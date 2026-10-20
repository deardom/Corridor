// Sandbox ledger: a simulated multi-currency account for one student.
// Nothing here touches a real bank. All state is plain JSON so it can be
// snapshotted into the execution-evidence logs.
import { PERSONAS, SCHOOL_REGISTRY } from "./data.js";
import { round2, deepClone, makeIdGen, addDays } from "./util.js";
import { convertMid, toUsd, midRate } from "./fx.js";
import { getPack } from "./packs/index.js";

export const DEFAULT_SETTINGS = {
  autonomy: "confirm", // "advise" | "confirm" | "auto_small"
  autoLimitCad: 100,   // auto_small: max CAD-equivalent the agent may move without a click (verified payees, own pots)
  perTxCapCad: 20000,
  dailyCapCad: 25000,
  parentMode: false,   // family can see transfer status and due dates (express consent required)
};

export class Ledger {
  constructor(personaId = "christina", { today = "2026-10-19" } = {}) {
    const p = PERSONAS[personaId];
    if (!p) throw new Error(`Unknown persona ${personaId}`);
    this.persona = deepClone(p);
    this.today = today;
    this.wallets = { ...p.wallets };
    this.payees = deepClone(p.payees);
    this.payees.push({ id: "p_self_home", name: `${p.name} (own ${getPack(p.home).name} account)`, currency: getPack(p.home).currency, accountLast4: "0007", verified: true, kind: "self" });
    this.payees.push({ id: "p_self_host", name: `${p.name} (own ${getPack(p.host).name} account)`, currency: getPack(p.host).currency, accountLast4: "0008", verified: true, kind: "self" });
    this.transactions = [];
    this.rateRules = [];
    this.obligations = deepClone(p.obligations || []);
    this.fxQuotaUsedUsd = p.fxQuotaUsedUsd || 0;
    this.credit = { ...p.credit };
    this.budget = deepClone(p.budget);
    this.pots = deepClone(p.pots || []).map((x) => ({ ...x, autoSave: false }));
    this.wishlist = deepClone(p.wishlist || []).map((w) => ({ ...w, status: "watching" }));
    this.setupDone = [...(p.setupDone || [])];
    this.settings = { ...DEFAULT_SETTINGS };
    this.nextTx = makeIdGen("tx");
    this.nextRule = makeIdGen("rule");
  }

  homePack() { return getPack(this.persona.home); }
  hostPack() { return getPack(this.persona.host); }
  school() { return SCHOOL_REGISTRY.find((s) => s.id === this.persona.school); }

  balances(rates) {
    const out = {};
    for (const [cur, amt] of Object.entries(this.wallets)) out[cur] = round2(amt);
    out.totalCad = round2(Object.entries(this.wallets).reduce((s, [c, a]) => s + convertMid(a, c, "CAD", rates), 0));
    out.inPotsCad = round2(this.pots.reduce((s, p) => s + convertMid(p.saved, p.currency, "CAD", rates), 0));
    return out;
  }

  quotaRemainingUsd() {
    return this.persona.home === "CN" ? round2(50000 - this.fxQuotaUsedUsd) : null;
  }

  /** Total CAD-equivalent moved out to other people today (for the daily cap). */
  movedTodayCad() {
    return round2(this.transactions.filter((t) => t.date === this.today && t.direction === "out").reduce((s, t) => s + (t.cadEquivalent || 0), 0));
  }

  /** Alerts the wallet raises on its own. */
  alerts(rates) {
    const out = [];
    const left = { ...this.wallets };
    const open = this.obligations.filter((o) => o.status === "open").sort((a, b) => a.due.localeCompare(b.due));
    for (const o of open) {
      const days = Math.round((new Date(o.due) - new Date(this.today)) / 86400000);
      const have = left[o.currency] || 0;
      if (o.amount > have) {
        const short = round2(o.amount - have);
        out.push({ level: days <= 14 ? "high" : "medium", kind: "shortfall", obligationId: o.id, currency: o.currency, short,
          text: `${o.label}: ${o.amount.toLocaleString()} ${o.currency} due ${o.due} (${days} days). Your ${o.currency} balance is short by ${short.toLocaleString()} ${o.currency}${o.currency !== this.persona.homeAccount.currency ? ` (≈ ${round2(convertMid(short, o.currency, "CAD", rates)).toLocaleString()} CAD)` : ""}.` });
      } else left[o.currency] = have - o.amount;
    }
    for (const p of this.pots) {
      const days = Math.round((new Date(p.due) - new Date(this.today)) / 86400000);
      const weeks = Math.max(1, Math.floor(days / 7));
      const needed = round2((p.target - p.saved) / weeks);
      if (p.saved < p.target && needed > p.weekly) out.push({ level: "medium", kind: "pot_behind", potId: p.id, text: `${p.name}: ${p.saved}/${p.target} ${p.currency}. To be ready by ${p.due} you need about ${needed} ${p.currency}/week (plan: ${p.weekly}).` });
    }
    if (this.credit.securedCardLimit > 0) {
      const util = this.credit.securedCardBalance / this.credit.securedCardLimit;
      if (util > 0.3) out.push({ level: "medium", kind: "credit", text: `Credit card utilization is ${Math.round(util * 100)}%. Paying it below 30% before the statement date helps your credit history.` });
    }
    return out;
  }

  getPayee(id) {
    return this.payees.find((p) => p.id === id) || null;
  }

  /** Move money out (to a payee) or into the student's own account. Called only after the guard approved. */
  applyTransfer({ quote, payeeId, purpose, reference, schoolId }) {
    const from = quote.from;
    if ((this.wallets[from] || 0) < quote.sendAmount) throw new Error(`Insufficient ${from} balance`);
    this.wallets[from] = round2(this.wallets[from] - quote.sendAmount);
    const toSelf = payeeId === "p_self_home" || payeeId === "p_self_host";
    if (toSelf) this.wallets[quote.to] = round2((this.wallets[quote.to] || 0) + quote.received);
    if (from === "CNY" && this.persona.home === "CN" && quote.to !== "CNY") {
      this.fxQuotaUsedUsd = round2(this.fxQuotaUsedUsd + toUsd(quote.sendAmount, "CNY"));
    }
    const tx = {
      id: this.nextTx(), date: this.today, direction: toSelf ? "internal" : "out", kind: purpose,
      from, to: quote.to, sent: quote.sendAmount, received: quote.received,
      fees: round2((quote.upfrontFee || 0)), totalCostVsMid: quote.totalCost, routeId: quote.routeId,
      payeeId: payeeId || null, schoolId: schoolId || null, reference: reference || null,
      cadEquivalent: toSelf ? 0 : round2(convertMid(quote.sendAmount, from, "CAD")),
      status: "settled_simulated", arrivesBy: addDays(this.today, quote.days[1]),
    };
    this.transactions.push(tx);
    const ob = this.obligations.find((o) => o.kind === purpose && o.status === "open" && o.currency === quote.to);
    if (ob && !toSelf && quote.received >= ob.amount - 0.01) ob.status = "paid";
    return tx;
  }

  applyConversion({ from, to, amount, markupPct = 0.45, mid }) {
    if ((this.wallets[from] || 0) < amount) throw new Error(`Insufficient ${from} balance`);
    const m = mid ?? midRate(from, to);
    const rate = m * (1 - markupPct / 100);
    const out = round2(amount * rate);
    this.wallets[from] = round2(this.wallets[from] - amount);
    this.wallets[to] = round2((this.wallets[to] || 0) + out);
    if (from === "CNY" && this.persona.home === "CN") this.fxQuotaUsedUsd = round2(this.fxQuotaUsedUsd + toUsd(amount, "CNY"));
    const tx = { id: this.nextTx(), date: this.today, direction: "internal", kind: "conversion", from, to, sent: round2(amount), received: out, fees: 0, totalCostVsMid: round2(amount * m - out), rate: Math.round(rate * 1e6) / 1e6, cadEquivalent: 0, status: "settled_simulated" };
    this.transactions.push(tx);
    return tx;
  }

  /** Move money from the main wallet into a savings pot (stays the student's money). */
  applyPotContribution({ potId, amount }) {
    const pot = this.pots.find((p) => p.id === potId);
    if (!pot) throw new Error("No such pot");
    if ((this.wallets[pot.currency] || 0) < amount) throw new Error(`Insufficient ${pot.currency} balance`);
    this.wallets[pot.currency] = round2(this.wallets[pot.currency] - amount);
    pot.saved = round2(pot.saved + amount);
    const tx = { id: this.nextTx(), date: this.today, direction: "internal", kind: "savings", from: pot.currency, to: pot.currency, sent: round2(amount), received: round2(amount), fees: 0, totalCostVsMid: 0, potId, cadEquivalent: 0, status: "settled_simulated" };
    this.transactions.push(tx);
    return { tx, pot: { ...pot } };
  }

  setPotAutoSave(potId, on, weekly) {
    const pot = this.pots.find((p) => p.id === potId);
    if (!pot) throw new Error("No such pot");
    pot.autoSave = !!on;
    if (weekly) pot.weekly = round2(weekly);
    return { ...pot };
  }

  /**
   * Buy a wishlist item. Paid from the linked pot first, then from the wallet
   * in the item's currency, converting from the home currency if needed.
   */
  applyPurchase({ item, rates, cardFeePct = 0 }) {
    const priceCad = round2(convertMid(item.price, item.currency, "CAD", rates));
    let fromPotCad = 0;
    const pot = item.potId ? this.pots.find((p) => p.id === item.potId) : null;
    if (pot) { fromPotCad = Math.min(pot.saved, priceCad); pot.saved = round2(pot.saved - fromPotCad); }
    let restCad = round2(priceCad - fromPotCad);
    let paidFrom = [];
    if (fromPotCad > 0) paidFrom.push(`${round2(fromPotCad)} CAD from "${pot.name}"`);
    if (restCad > 0) {
      const localHave = item.currency !== "CAD" ? this.wallets[item.currency] || 0 : 0;
      const restLocal = round2(convertMid(restCad, "CAD", item.currency, rates));
      if (item.currency !== "CAD" && localHave >= restLocal) {
        this.wallets[item.currency] = round2(localHave - restLocal);
        paidFrom.push(`${restLocal.toLocaleString()} ${item.currency} from your ${item.currency} wallet`);
      } else {
        const fee = round2(restCad * cardFeePct / 100);
        if ((this.wallets.CAD || 0) < restCad + fee) throw new Error("Insufficient balance");
        this.wallets.CAD = round2(this.wallets.CAD - restCad - fee);
        paidFrom.push(`${restCad} CAD by card${fee ? ` (+${fee} CAD foreign fee)` : ""}`);
      }
    }
    // The part paid from a savings pot was already set aside; only the rest counts against this month's budget.
    if (fromPotCad > 0) this.budget.spends.push({ date: this.today, category: item.category, merchant: `${item.store}: ${item.name} (from savings)`, amount: fromPotCad, currency: "CAD", fromPot: true });
    if (restCad > 0) this.budget.spends.push({ date: this.today, category: item.category, merchant: `${item.store}: ${item.name}`, amount: restCad, currency: "CAD", fromPot: false });
    item.status = "bought";
    const firstSeen = Math.max(...item.history.map((h) => h.price));
    const tx = { id: this.nextTx(), date: this.today, direction: "out", kind: "purchase", from: item.currency, to: item.currency, sent: item.price, received: item.price, fees: 0, totalCostVsMid: 0, payeeId: item.store, wishlistId: item.id, paidFrom, cadEquivalent: 0, status: "settled_simulated", savedVsHighest: round2(firstSeen - item.price), currency: item.currency };
    this.transactions.push(tx);
    return tx;
  }

  /** Record money the student spent. Paid from the wallet in that currency when it has enough. */
  addExpense({ amount, currency, category, merchant, date }) {
    const paid = (this.wallets[currency] || 0) >= amount;
    if (paid) this.wallets[currency] = round2(this.wallets[currency] - amount);
    const entry = { date: date || this.today, category, merchant, amount: round2(amount), currency, manual: true };
    this.budget.spends.push(entry);
    return { ...entry, paidFromWallet: paid };
  }

  /** Record money the student received (one-off or this month's income). Credited to the wallet. */
  addIncome({ amount, currency, label }) {
    this.wallets[currency] = round2((this.wallets[currency] || 0) + amount);
    const entry = { label, amount: round2(amount), currency, date: this.today, manual: true };
    this.budget.incomes.push(entry);
    return entry;
  }

  addRateRule({ from, to, targetRate, amount }) {
    const rule = { id: this.nextRule(), from, to, targetRate: Number(targetRate), amount: Number(amount), status: "active", createdAt: this.today };
    this.rateRules.push(rule);
    return rule;
  }

  dueRateRules(currentRateFn) {
    return this.rateRules.filter((r) => r.status === "active" && currentRateFn(r.from, r.to) >= r.targetRate);
  }

  snapshot() {
    return deepClone({ persona: this.persona.id, today: this.today, wallets: this.wallets, fxQuotaUsedUsd: this.fxQuotaUsedUsd, obligations: this.obligations, transactions: this.transactions, rateRules: this.rateRules, pots: this.pots, wishlist: this.wishlist, settings: this.settings });
  }
}
