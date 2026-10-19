// The guard. The language model (or rule planner) PROPOSES actions; this
// deterministic policy engine DECIDES. No model output can move money without
// passing every check below, and every decision is written to the audit log.
import { assessScamRisk } from "./scam.js";
import { detectStructuring, detectBehaviouralStructuring, checkChinaQuota, largeTransferNotice } from "./compliance.js";
import { toUsd } from "./fx.js";
import { round2 } from "./util.js";

export const TIERS = {
  T0: { name: "Read", description: "Look at balances, quotes, documents and rules. No side effects.", userConfirmation: false },
  T1: { name: "Plan", description: "Build a recommendation, or edit the student's own plans (wishlist, budget). Never moves money.", userConfirmation: false },
  T2: { name: "Act", description: "Move or convert money in the sandbox. Always passes the guard; needs the user's click unless the user enabled small automatic actions.", userConfirmation: true },
  T3: { name: "Forbidden to the agent", description: "Change limits or autonomy, add payees from documents, export personal data. Only the user can do these, in the settings screen.", userConfirmation: null },
};

/** Actions the user may let the agent run without a click (small amounts only). Purchases, tuition and standing rules always need a click. */
export const AUTO_ELIGIBLE = ["save_to_pot", "convert_currency", "send_money"];

export const TOOL_TIERS = {
  get_wallet: "T0",
  compare_routes: "T0",
  check_fx_quota: "T0",
  assess_scam_risk: "T0",
  review_document: "T0",
  get_credit_plan: "T0",
  get_budget: "T0",
  check_purchase: "T0",
  get_wishlist: "T0",
  trip_readiness: "T0",
  add_wishlist_item: "T1",
  add_expense: "T1",
  add_income: "T1",
  buy_wishlist_item: "T2",
  plan_tuition_payment: "T1",
  pay_tuition: "T2",
  send_money: "T2",
  convert_currency: "T2",
  set_rate_rule: "T2",
  save_to_pot: "T2",
  set_auto_save: "T2",
  change_settings: "T3",
  add_payee: "T3",
  export_personal_data: "T3",
};

/**
 * Evaluate a proposed T2 action.
 * @returns {{decision: "allow"|"confirm"|"deny", checks: Array, reasons: string[], warnings: string[], requirements: string[]}}
 */
export function evaluate(action, ctx) {
  const tier = TOOL_TIERS[action];
  const checks = [];
  const reasons = [];
  const warnings = [];
  const requirements = [];
  const add = (name, pass, detail, severity = "block") => {
    checks.push({ name, pass, detail: pass ? "passed" : detail });
    if (!pass && severity === "block") reasons.push(detail);
    if (!pass && severity === "warn") warnings.push(detail);
  };

  if (!tier) return { decision: "deny", tier: null, checks, reasons: [`Unknown action ${action}`], warnings, requirements };
  if (tier === "T3") return { decision: "deny", tier, checks: [{ name: "tier", pass: false, detail: "T3 actions are reserved to the user" }], reasons: ["This action is reserved to you in Settings. The agent cannot do it."], warnings, requirements };
  if (tier !== "T2") return { decision: "allow", tier, checks: [{ name: "tier", pass: true, detail: `${tier} has no side effects` }], reasons, warnings, requirements };

  const { ledger, quote, payee, purpose, amountCad = 0, riskText = "", documentCheck, userConfirmed = false, documentsAttested = false, skipFunds = false, language = "en" } = ctx;
  const ownMoney = ["convert_currency", "save_to_pot", "set_auto_save", "set_rate_rule"].includes(action) || payee?.kind === "self";
  const standingRule = action === "set_auto_save" || action === "set_rate_rule";
  const s = ledger.settings;

  // 1. Autonomy setting chosen by the user.
  add("autonomy", s.autonomy !== "advise", "Autonomy is set to 'advise only', so the agent may not execute actions.");

  // 2. Payee must be verified (school registry or user-verified payee).
  if (action === "pay_tuition" || action === "send_money") {
    add("verified_payee", !!payee && payee.verified === true, "The recipient is not a verified payee. New payees must be added and verified by you in Settings.");
  }

  // 3. Document trust: payment details taken from an untrusted document cannot authorise a payment.
  if (documentCheck) {
    add("document_integrity", documentCheck.trusted, `The document failed integrity checks: ${documentCheck.problems.join("; ")}`);
  }

  // 4. Scam shield on the surrounding conversation.
  const scam = assessScamRisk(riskText, { payeeVerified: payee?.verified !== false, amountCad, language, emergency: ledger.hostPack().emergency });
  if (scam.level === "high") add("scam_shield", false, `High scam risk (${scam.score}/100): ${scam.signals.map((x) => x.label).join("; ")}`);
  else if (scam.level === "medium") add("scam_shield", false, `Possible scam signals (${scam.score}/100): ${scam.signals.map((x) => x.label).join("; ")}`, "warn");
  else checks.push({ name: "scam_shield", pass: true, detail: "No scam signals in context" });

  // 5. Structuring / quota evasion (stated intent and behaviour).
  const st = detectStructuring(riskText);
  add("no_structuring_intent", !st.flagged, `Request asks to split or disguise a transfer (${st.evidence.join(", ")}).`);
  if (!ownMoney) {
    const bs = detectBehaviouralStructuring(ledger.transactions, ledger.today, amountCad);
    add("no_structuring_pattern", !bs.flagged, `${bs.count} transfers today each under CAD 10,000 adding up to CAD ${bs.totalCad.toLocaleString()}. Combine them into one documented transfer instead.`);
  }

  // 6. Limits the user set.
  if (!standingRule) {
    add("per_transaction_cap", amountCad <= s.perTxCapCad, `CAD ${round2(amountCad).toLocaleString()} is above your per-transaction cap of CAD ${s.perTxCapCad.toLocaleString()}.`);
    const today = ledger.movedTodayCad();
    const outbound = ownMoney ? 0 : amountCad;
    add("daily_cap", today + outbound <= s.dailyCapCad, `This would bring today's outbound total to CAD ${round2(today + outbound).toLocaleString()}, above your daily cap of CAD ${s.dailyCapCad.toLocaleString()}.`);
  }

  // 7. Funds available.
  if (quote && !standingRule && !skipFunds) {
    const have = ledger.wallets[quote.from] || 0;
    add("sufficient_funds", have >= quote.sendAmount, `Not enough ${quote.from}: need ${quote.sendAmount.toLocaleString()}, have ${round2(have).toLocaleString()}.`);
  }

  // 8. Home-country FX rules (China quota).
  let quota = null;
  if (quote && quote.from === "CNY" && ledger.persona.home === "CN" && !standingRule) {
    quota = checkChinaQuota({ usedUsd: ledger.fxQuotaUsedUsd, amountUsd: toUsd(quote.sendAmount, "CNY"), purpose });
    if (quota.status === "blocked") add("cn_fx_quota", false, quota.explanation);
    else if (quota.status === "documents_required") {
      checks.push({ name: "cn_fx_quota", pass: true, detail: `Above remaining quota by USD ${quota.overByUsd.toLocaleString()}; allowed for tuition with documents.` });
      requirements.push("documents_attested");
      if (userConfirmed && !documentsAttested) add("documents_attested", false, "Confirm that the admission letter and tuition invoice will be presented to the bank.");
    } else checks.push({ name: "cn_fx_quota", pass: true, detail: `Within annual quota (USD ${quota.remainingUsd.toLocaleString()} remaining before this payment).` });
  }

  // 9. Budget: buying something the budget can't absorb is the user's call, but they get a clear warning.
  if (action === "buy_wishlist_item" && ctx.safeToSpend != null && amountCad > ctx.safeToSpend) {
    warnings.push(`This is ${round2(amountCad - ctx.safeToSpend)} CAD more than your safe-to-spend for the rest of the month (${ctx.safeToSpend} CAD).`);
  }

  // 10. Informational: large transfer reporting (never a block).
  const notice = largeTransferNotice(amountCad);
  if (notice.applies) warnings.push(notice.text);

  let decision;
  if (reasons.length) decision = "deny";
  else if (userConfirmed) decision = "allow";
  else if (s.autonomy === "auto_small" && AUTO_ELIGIBLE.includes(action) && amountCad <= s.autoLimitCad && warnings.length === 0 && (payee ? payee.verified : true) && requirements.length === 0) decision = "allow";
  else decision = "confirm";

  return { decision, tier, checks, reasons, warnings, requirements, scam, quota };
}
