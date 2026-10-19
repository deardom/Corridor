// Cross-border compliance checks. The agent explains rules and routes users to
// the legitimate path; it never helps anyone get around a rule.
import { COMPLIANCE_RULES } from "./data.js";
import { round2 } from "./util.js";

const STRUCTURING_PATTERNS = [
  /split (it|the (transfer|payment|money|amount))|break (it|the (transfer|payment|amount)) (up|into)/i,
  /(cousin|relative|friend|parent|uncle|aunt|family member)s?'?s? (quota|allowance|name|account)s?/i,
  /(under|below|less than|just under) (the )?(\$?10,?000|10k|reporting|limit|threshold|quota)/i,
  /avoid (the )?(report|reporting|fintrac|quota|limit|detection|flag)/i,
  /(several|multiple|many) (small(er)? )?(transfers|payments) (so|to avoid|to stay)/i,
  /分拆|拆分|用(亲戚|朋友|家人|表哥|表姐|父母)的?(额度|名义|账户)|避开(额度|监管|申报)/,
  /разби(ть|ть на части)|по частям|чтобы не (заметили|отчитываться)|на имя (родственник|друз)/i,
];

export function detectStructuring(text) {
  const t = String(text || "");
  const evidence = STRUCTURING_PATTERNS.map((re) => t.match(re)).filter(Boolean).map((m) => m[0]);
  return { flagged: evidence.length > 0, evidence };
}

/** Behavioural check: several outbound transfers in 24h that each stay under CAD 10,000 but add up past it. */
export function detectBehaviouralStructuring(transactions, today, newCad) {
  const sameDay = transactions.filter((t) => t.date === today && t.direction === "out");
  const amounts = [...sameDay.map((t) => t.cadEquivalent), newCad];
  const total = amounts.reduce((a, b) => a + b, 0);
  const allUnder = amounts.every((a) => a < 10000);
  return { flagged: amounts.length >= 3 && allUnder && total >= 10000, count: amounts.length, totalCad: round2(total) };
}

/**
 * China annual FX purchase quota check.
 * @returns status: "within_quota" | "documents_required" | "blocked"
 */
export function checkChinaQuota({ usedUsd, amountUsd, purpose }) {
  const quota = COMPLIANCE_RULES.CN_ANNUAL_FX_QUOTA_USD.value;
  const remaining = Math.max(0, quota - usedUsd);
  if (amountUsd <= remaining) return { status: "within_quota", remainingUsd: round2(remaining), afterUsd: round2(remaining - amountUsd) };
  if (purpose === "tuition") {
    return {
      status: "documents_required",
      remainingUsd: round2(remaining),
      overByUsd: round2(amountUsd - remaining),
      explanation: "This tuition payment exceeds the remaining annual quota. For tuition, the bank can process the full amount when you provide your admission letter and the school's tuition invoice. Do not split the payment across relatives' quotas.",
      documents: ["Passport / ID of the person buying the currency", "Admission letter or enrolment confirmation", "Tuition invoice showing the school's account"],
    };
  }
  return {
    status: "blocked",
    remainingUsd: round2(remaining),
    overByUsd: round2(amountUsd - remaining),
    explanation: "This exceeds the remaining annual FX quota and is not a documented current-account purpose such as tuition. Send a smaller amount now, or wait for the new quota year (January 1).",
  };
}

export function largeTransferNotice(amountCad) {
  const t = COMPLIANCE_RULES.CA_LARGE_EFT_CAD.value;
  if (amountCad >= t) {
    return { applies: true, text: `International transfers of CAD ${t.toLocaleString()} or more are reported to FINTRAC by the financial institution. This is routine for tuition and does not mean anything is wrong. Keep your invoice and receipt.` };
  }
  return { applies: false };
}

export function refusalForStructuring(language = "en") {
  const msg = {
    en: "I can't help split this transfer to stay under a limit or use other people's quotas. Splitting purchases across relatives is prohibited in China (分拆购汇) and structuring to avoid reporting is an offence in Canada. It can get your family's accounts restricted. Here is the legitimate way to pay the full amount instead:",
    zh: "我不能帮助拆分转账以规避额度或使用他人的额度。在中国，分拆购汇是被禁止的；在加拿大，为规避申报而拆分交易属于违法行为，可能导致家人的账户被限制。以下是支付全额的合规方式：",
    ru: "Я не могу помочь разбить перевод, чтобы обойти лимит или использовать чужие квоты. Это запрещено в Китае (分拆购汇), а дробление операций для обхода отчётности является правонарушением в Канаде. Вот законный способ оплатить всю сумму:",
  };
  return msg[language] || msg.en;
}
