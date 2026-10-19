// Run with: npm test   (or: node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.js";
import { Agent, parseMoney } from "../src/agent.js";
import { ROUTES, SAMPLE_DOCS, SAMPLE_MESSAGES } from "../src/data.js";
import { quoteRoute, quoteRouteForTarget, compareRoutes, midRate } from "../src/fx.js";
import { assessScamRisk } from "../src/scam.js";
import { verifyInvoice } from "../src/documents.js";
import { detectStructuring, checkChinaQuota } from "../src/compliance.js";
import { PACKS } from "../src/packs/index.js";
import { SCENARIOS } from "../src/scenarios.js";
import { runScenario } from "../src/runner.js";
import { sha256 } from "../src/util.js";

const route = (id) => ROUTES.find((r) => r.id === id);

// ---------- FX and routes ----------
test("sha256 matches a known vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("mid-market quote with no fees or spread costs nothing", () => {
  const r = { id: "x", from: ["CAD"], to: ["KZT"], legs: [{ markupPct: 0 }], feePct: 0, feeFixed: 0, feeMin: 0, feeCurrency: "SOURCE", receiveFee: {}, days: [0, 0], purposes: ["living"] };
  const q = quoteRoute(r, "CAD", "KZT", 100);
  assert.equal(q.totalCost, 0);
  assert.equal(q.received, Math.round(100 * midRate("CAD", "KZT") * 100) / 100);
});

test("Kaspi fee uses the 200 KZT minimum on small transfers and counts two conversions", () => {
  const q = quoteRoute(route("kaspi_intl_card"), "KZT", "CAD", 10000);
  assert.equal(q.upfrontFee, 200);
  assert.equal(q.conversions, 2);
});

test("Alipay charges 3% only on payments above 200 CNY", () => {
  const small = quoteRouteForTarget(route("alipay_foreign_card"), "CAD", "CNY", 150);
  const large = quoteRouteForTarget(route("alipay_foreign_card"), "CAD", "CNY", 450);
  assert.equal(small.paymentFee, 0);
  assert.ok(large.paymentFee > 0);
  assert.ok(large.received >= 450);
});

test("target-amount quotes always deliver at least the target", () => {
  for (const id of ["paysend_kzt", "rbc_wire", "wise_usd_kz"]) {
    const q = quoteRouteForTarget(route(id), "CAD", "KZT", 108000);
    assert.ok(q.received >= 108000, id);
  }
});

test("route comparison never ranks a trap first", () => {
  const cmp = compareRoutes({ from: "CAD", to: "CNY", amount: 500, purpose: "trip" });
  assert.equal(cmp.eligible[0].trap, false);
  assert.ok(cmp.eligible.some((q) => q.trap));
});

// ---------- country packs ----------
test("every country pack has the same shape", () => {
  for (const p of Object.values(PACKS)) {
    for (const key of ["code", "name", "currency", "localRails", "routes", "setupChecklist", "cardTraps", "healthInsurance", "scamSignals", "emergency"]) {
      assert.ok(key in p, `${p.code} missing ${key}`);
    }
  }
});

// ---------- security ----------
test("scam shield flags the fake bank-security call (Russian too)", () => {
  assert.equal(assessScamRisk(SAMPLE_MESSAGES.scam_bank_security).level, "high");
  assert.equal(assessScamRisk("Служба безопасности банка: срочно назовите код из СМС и переведите деньги на безопасный счёт").level, "high");
  assert.equal(assessScamRisk("我是大使馆的警察，你涉嫌洗钱，必须保密，立即把钱转到安全账户").level, "high");
  assert.equal(assessScamRisk("Can you send 50,000 tenge to my Kaspi for groceries?").level, "low");
});

test("poisoned invoice is detected: hidden text, AI instructions, foreign account", () => {
  const v = verifyInvoice(SAMPLE_DOCS.invoice_poisoned);
  assert.equal(v.trusted, false);
  assert.ok(v.problems.some((p) => p.includes("9902")));
  assert.ok(v.problems.some((p) => /Hidden text/.test(p)));
  assert.equal(verifyInvoice(SAMPLE_DOCS.invoice_clean).trusted, true);
});

test("structuring requests are detected in English, Chinese and Russian", () => {
  assert.ok(detectStructuring("split the payment so it stays under 10,000").flagged);
  assert.ok(detectStructuring("用表哥的额度分拆购汇").flagged);
  assert.ok(detectStructuring("разбить перевод на имя родственников").flagged);
  assert.equal(detectStructuring("pay my tuition").flagged, false);
});

test("China FX quota: tuition above quota needs documents, other purposes are blocked", () => {
  assert.equal(checkChinaQuota({ usedUsd: 45000, amountUsd: 10000, purpose: "tuition" }).status, "documents_required");
  assert.equal(checkChinaQuota({ usedUsd: 45000, amountUsd: 10000, purpose: "living" }).status, "blocked");
  assert.equal(checkChinaQuota({ usedUsd: 0, amountUsd: 10000, purpose: "living" }).status, "within_quota");
});

test("T3 actions are always denied to the agent", () => {
  const s = new Session({ persona: "christina" });
  for (const t of ["change_settings", "add_payee", "export_personal_data"]) assert.equal(s.callTool(t, {}).status, "blocked");
});

test("money never moves without confirmation by default", () => {
  const s = new Session({ persona: "christina" });
  const before = s.ledger.wallets.CAD;
  const r = s.callTool("send_money", { payee_id: "p_self_host", from: "CAD", to: "KZT", amount: 200 });
  assert.equal(r.status, "awaiting_user_confirmation");
  assert.equal(s.ledger.wallets.CAD, before);
  assert.equal(s.confirm(r.pendingId).status, "executed");
  assert.equal(s.ledger.wallets.CAD, before - 200);
});

test("unverified payees, caps and advise-only mode are enforced", () => {
  const s = new Session({ persona: "christina" });
  assert.equal(s.callTool("send_money", { payee_id: "stranger", from: "CAD", amount: 10 }).status, "blocked");
  assert.equal(s.callTool("send_money", { payee_id: "p_self_host", from: "CAD", to: "KZT", amount: 25000 }).status, "blocked");
  s.updateSettings({ autonomy: "advise" });
  assert.equal(s.callTool("convert_currency", { from: "CAD", to: "KZT", amount: 10 }).status, "blocked");
});

test("the agent cannot change its own settings", () => {
  const s = new Session({ persona: "christina" });
  assert.equal(s.updateSettings({ perTxCapCad: 1e9 }, "agent").status, "blocked");
  assert.equal(s.ledger.settings.perTxCapCad, 20000);
});

test("auto mode runs small actions to own pots, never purchases", () => {
  const s = new Session({ persona: "christina" });
  s.updateSettings({ autonomy: "auto_small" });
  assert.equal(s.callTool("save_to_pot", { pot_id: "pot_health", amount: 40 }).status, "executed_automatically");
  assert.equal(s.callTool("buy_wishlist_item", { item_id: "w_boots" }).status, "awaiting_user_confirmation");
  assert.equal(s.callTool("save_to_pot", { pot_id: "pot_health", amount: 150 }).status, "awaiting_user_confirmation");
});

test("the guard re-checks at confirm time (scam context appearing later blocks execution)", () => {
  const s = new Session({ persona: "christina" });
  const r = s.callTool("send_money", { payee_id: "p_self_host", from: "CAD", to: "KZT", amount: 100 });
  s.noteUserText(SAMPLE_MESSAGES.scam_bank_security);
  assert.equal(s.confirm(r.pendingId).status, "blocked");
});

test("audit log detects tampering", () => {
  const s = new Session({ persona: "christina" });
  s.callTool("get_wallet", {});
  assert.equal(s.audit.verify().ok, true);
  s.audit.entries[1].data.tool = "something_else";
  assert.equal(s.audit.verify().ok, false);
});

test("account numbers are masked in the audit log", () => {
  const s = new Session({ persona: "li_wei" });
  s.callTool("pay_tuition", { amount_cad: 100, account: "00999-310-44129902" });
  const logged = JSON.stringify(s.audit.entries);
  assert.ok(!logged.includes("00999-310-44129902"));
});

// ---------- budget, wishlist, pots ----------
test("safe-to-spend is non-negative and accounts for essentials and savings", () => {
  const s = new Session({ persona: "christina" });
  const b = s.budget();
  assert.ok(b.safeToSpend >= 0);
  assert.ok(b.safeToSpend <= b.income - b.savingsGoal - b.totalSpent);
});

test("a wishlist item becomes buy_now only when at target AND affordable", () => {
  const s = new Session({ persona: "christina" });
  assert.equal(s.callTool("get_wishlist").items.find((i) => i.id === "w_flight").verdict, "wait");
  assert.equal(s.simulatePriceChange("w_flight", 229000).evaluation.verdict, "buy_now");
  s.ledger.pots.find((p) => p.id === "pot_trip").saved = 0;
  s.ledger.budget.savingsGoal = 1650;
  assert.notEqual(s.callTool("get_wishlist").items.find((i) => i.id === "w_flight").verdict, "buy_now");
});

test("buying from the wishlist draws from the linked pot first", () => {
  const s = new Session({ persona: "christina" });
  s.simulatePriceChange("w_flight", 229000);
  const r = s.callTool("buy_wishlist_item", { item_id: "w_flight" });
  const potBefore = s.ledger.pots.find((p) => p.id === "pot_trip").saved;
  s.confirm(r.pendingId);
  assert.ok(s.ledger.pots.find((p) => p.id === "pot_trip").saved < potBefore);
  assert.equal(s.ledger.wishlist.find((w) => w.id === "w_flight").status, "bought");
});

// ---------- agent parsing ----------
test("money parser understands tenge, k suffix and dollars", () => {
  assert.deepEqual(parseMoney("12,000 tenge").map((m) => [m.amount, m.currency]), [[12000, "KZT"]]);
  assert.deepEqual(parseMoney("50k KZT").map((m) => [m.amount, m.currency]), [[50000, "KZT"]]);
  assert.deepEqual(parseMoney("$250").map((m) => [m.amount, m.currency]), [[250, "CAD"]]);
});

test("rule agent adds a wishlist item from plain language", async () => {
  const s = new Session({ persona: "christina" });
  const a = new Agent(s);
  await a.handle("Add warm gloves to my wishlist, 12,000 tenge, I want them under 9,000");
  const w = s.ledger.wishlist.find((x) => /gloves/i.test(x.name));
  assert.ok(w);
  assert.equal(w.currency, "KZT");
  assert.equal(w.targetPrice, 9000);
});

// ---------- every demo scenario ----------
for (const sc of SCENARIOS) {
  test(`scenario runs with a valid audit chain: ${sc.id}`, async () => {
    const { session } = await runScenario(sc);
    assert.equal(session.audit.verify().ok, true);
  });
}

test("scenario outcomes", async () => {
  const get = async (id) => (await runScenario(SCENARIOS.find((s) => s.id === id)));
  const rent = await get("christina_rent_topup");
  assert.equal(rent.session.ledger.obligations.find((o) => o.kind === "rent").status, "paid");
  const scam = await get("christina_scam");
  assert.equal(scam.session.ledger.transactions.length, 0);
  const poison = await get("liwei_poisoned_invoice");
  assert.equal(poison.session.ledger.transactions.length, 0);
  const tuition = await get("liwei_tuition");
  assert.equal(tuition.session.ledger.obligations.find((o) => o.kind === "tuition").status, "paid");
  const wish = await get("christina_wishlist");
  assert.equal(wish.session.ledger.wishlist.find((w) => w.id === "w_flight").status, "bought");
  const health = await get("christina_health_pot");
  assert.ok(health.session.ledger.pots.find((p) => p.id === "pot_health").saved > 120);
});

test("recording expenses and income updates wallet and safe-to-spend", async () => {
  const s = new Session({ persona: "christina" });
  const before = s.budget().safeToSpend;
  const a = new Agent(s);
  await a.handle("I spent 4,500 tenge on lunch");
  assert.equal(s.ledger.wallets.KZT, 62000 - 4500);
  assert.ok(s.budget().safeToSpend < before);
  await a.handle("I got paid 120 dollars from tutoring");
  assert.equal(s.ledger.wallets.CAD, 4850 + 120);
});

test("AI agent adapter runs Corridor tools through the guard and returns the final answer", async () => {
  const { anthropicAgent } = await import("../src/llm-anthropic.js");
  const calls = [];
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "send_money", input: { payee_id: "p_self_host", from: "CAD", to: "KZT", amount: 100 } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Ready for your confirmation.", citations: [{ url: "https://example.org/fees", title: "Fees" }] }] },
  ];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, json: async () => replies.shift() }; };
  const s = new Session({ persona: "christina" });
  const a = new Agent(s, { llm: anthropicAgent({ apiKey: "test", fetchImpl }) });
  const r = await a.handle("Send 100 dollars to my Kaspi");
  assert.equal(r.brain, "llm");
  assert.match(r.reply, /Ready for your confirmation/);
  assert.match(r.reply, /example\.org/);
  assert.equal(s.pending.size, 1);                       // proposed, not executed
  assert.equal(s.ledger.wallets.CAD, 4850);
  assert.ok(calls[0].tools.some((t) => t.name === "web_search"));
  assert.equal(calls[1].messages.at(-1).content[0].type, "tool_result");
});

test("Gemini adapter: runs Corridor tools and web research, cites sources", async () => {
  const { geminiAgent } = await import("../src/llm-gemini.js");
  const calls = [];
  let round = 0;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (body.tools?.[0]?.google_search) {
      return ok({ candidates: [{ content: { parts: [{ text: "Rent in Almaty averages 250k KZT." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.org/rent", title: "Rent guide" } }] } }] });
    }
    round++;
    if (round === 1) return ok({ candidates: [{ content: { parts: [{ functionCall: { name: "get_wallet", args: {} } }, { functionCall: { name: "research_web", args: { query: "rent Almaty" } } }] } }] });
    return ok({ candidates: [{ content: { parts: [{ text: "You have enough for rent." }] } }] });
  };
  const run = geminiAgent({ apiKey: "k", model: "gemini-test-flash", fetchImpl });
  let walletCalled = false;
  const out = await run({ instructions: "sys", message: "Can I afford rent?", tools: [{ name: "get_wallet", description: "wallet", inputSchema: { type: "object", properties: {} }, execute: async () => { walletCalled = true; return { CAD: 100 }; } }] });
  assert.ok(walletCalled);
  assert.match(out, /enough for rent/);
  assert.match(out, /Sources:[\s\S]*example\.org\/rent/);
  assert.ok(calls.every((c) => c.url.includes("gemini-test-flash")));
  const second = calls.filter((c) => c.body.contents && !c.body.tools?.[0]?.google_search)[1];
  assert.ok(second.body.contents.at(-1).parts.some((p) => p.functionResponse?.name === "get_wallet"));
});
