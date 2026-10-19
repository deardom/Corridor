// Trip readiness: everything a student should sort out before visiting a third
// country, computed from that country's pack plus the student's own situation.
import { getPack } from "./packs/index.js";
import { ROUTES } from "./data.js";
import { quoteRouteForTarget } from "./fx.js";
import { potStatus } from "./budget.js";
import { round2 } from "./util.js";

/**
 * Estimate what it costs to spend `spendLocal` in the trip currency under each payment option.
 * Assumes a realistic mix: 60% of the money in small payments (≈ 80 units), 40% in large ones (≈ 450).
 */
export function tripPaymentCosts(tripCurrency, spendLocal, homeCurrency, rates, userCardFeePct = 2.5) {
  const small = 80, large = 450;
  const nSmall = (spendLocal * 0.6) / small, nLarge = (spendLocal * 0.4) / large;
  const r = (id) => ROUTES.find((x) => x.id === id);
  const cost = (route, extraPct = 0) => {
    if (!route || !route.from.includes(homeCurrency) || !route.to.includes(tripCurrency)) return null;
    const qs = quoteRouteForTarget(route, homeCurrency, tripCurrency, small, rates);
    const ql = quoteRouteForTarget(route, homeCurrency, tripCurrency, large, rates);
    const total = (qs.sendAmount * nSmall + ql.sendAmount * nLarge) * (1 + extraPct / 100);
    const mid = (qs.midMarketReceived / qs.sendAmount) ? spendLocal / (qs.midMarketReceived / qs.sendAmount) : 0;
    return { total: round2(total), mid: round2(mid) };
  };
  const options = [
    { id: "alipay_current_card", label: `Alipay/WeChat Pay linked to your current card (${userCardFeePct}% foreign fee)`, ...cost(r("alipay_foreign_card"), userCardFeePct) },
    { id: "alipay_nofx_card", label: "Alipay/WeChat Pay linked to a no-foreign-fee card", ...cost(r("alipay_foreign_card")) },
    { id: "card_no_fx", label: "No-foreign-fee card directly, where cards are accepted", ...cost(r("card_no_fx")) },
    { id: "dcc_trap", label: "Saying yes to 'pay in CAD' at terminals", ...cost(r("dcc_trap")), trap: true },
  ].filter((o) => o.total);
  const best = Math.min(...options.filter((o) => !o.trap).map((o) => o.total));
  for (const o of options) { o.extraVsMid = round2(o.total - o.mid); o.extraVsBest = round2(o.total - best); }
  return { spendLocal, tripCurrency, homeCurrency, options };
}

export function tripReadiness(ledger, rates) {
  const trip = ledger.persona.trip;
  if (!trip) return { hasTrip: false };
  const pack = getPack(trip.country);
  const home = getPack(ledger.persona.home);
  const card = ledger.persona.cards?.[0];
  const hasNoFxCard = (ledger.persona.cards || []).some((c) => c.fxFeePct === 0);
  const pots = trip.potIds.map((id) => potStatus(ledger.pots.find((p) => p.id === id), ledger.today));
  const health = pots.find((p) => p.kind === "health");
  const checklist = [
    ...pack.setupChecklist.map((c) => ({ ...c, done: ledger.setupDone.includes(c.id) || (c.id === "cn_card" && hasNoFxCard) })),
    { id: "insurance", title: "Travel medical insurance for the trip dates", detail: [pack.healthInsurance.visiting, home.healthInsurance.outgoing].filter(Boolean).join(" "), done: ledger.setupDone.includes("insurance") || (!!health && health.saved >= health.target) },
  ];
  const spend = 6000;
  const costs = tripPaymentCosts(pack.currency, spend, ledger.persona.homeAccount.currency, rates, card?.fxFeePct ?? 2.5);
  return {
    hasTrip: true,
    destination: `${trip.city}, ${pack.name} ${pack.flag}`,
    dates: `${trip.start} to ${trip.end}`,
    daysUntil: Math.round((new Date(trip.start) - new Date(ledger.today)) / 86400000),
    checklist,
    ready: `${checklist.filter((c) => c.done).length}/${checklist.length}`,
    pots,
    paymentCosts: costs,
    traps: pack.cardTraps,
    localRails: pack.localRails,
    emergency: pack.emergency,
  };
}
