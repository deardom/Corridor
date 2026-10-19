// FX maths and route comparison. Pure functions: no state, easy to test.
import { UNITS_PER_USD, ROUTES, RATES_AS_OF } from "./data.js";
import { round2 } from "./util.js";

export function midRate(from, to, rates = UNITS_PER_USD) {
  if (!(from in rates) || !(to in rates)) throw new Error(`Unsupported currency pair ${from}/${to}`);
  return rates[to] / rates[from];
}

export function convertMid(amount, from, to, rates = UNITS_PER_USD) {
  return amount * midRate(from, to, rates);
}

export function toUsd(amount, currency, rates = UNITS_PER_USD) {
  return convertMid(amount, currency, "USD", rates);
}

/** Quote one route for a given source amount. Returns null if the route cannot serve the pair. */
export function quoteRoute(route, from, to, amountSource, rates = UNITS_PER_USD) {
  if (!route.from.includes(from) || !route.to.includes(to)) return null;
  const amount = Number(amountSource);
  if (!(amount > 0)) throw new Error("Amount must be positive");

  let fee = (amount * (route.feePct || 0)) / 100 + (route.feeFixed || 0);
  if (route.feeMin) fee = Math.max(fee, route.feeMin);
  if (route.feeMax) fee = Math.min(fee, route.feeMax);
  // Fees not denominated in the source currency are converted at mid-market.
  const feeCur = route.feeCurrency === "SOURCE" ? from : route.feeCurrency;
  const feeInSource = feeCur === from ? fee : convertMid(fee, feeCur, from, rates);

  const path = [from, ...route.legs.filter((l) => l.via).map((l) => l.via), to];
  let value = amount - feeInSource;
  const legDetails = [];
  for (let i = 0; i < path.length - 1; i++) {
    const leg = route.legs[i] || { markupPct: 0 };
    const mid = midRate(path[i], path[i + 1], rates);
    const applied = mid * (1 - (leg.markupPct || 0) / 100);
    const before = value;
    value = value * applied;
    legDetails.push({ from: path[i], to: path[i + 1], midRate: mid, appliedRate: applied, markupPct: leg.markupPct || 0, in: round2(before), out: round2(value), label: leg.label || null });
  }
  // Some wallets charge a % only on payments above a threshold (e.g. Alipay foreign cards above ¥200).
  let paymentFee = 0;
  if (route.perPaymentFee && value > route.perPaymentFee.thresholdDest) {
    paymentFee = (value * route.perPaymentFee.pctAbove) / 100;
    value -= paymentFee;
  }
  const receiveFee = (route.receiveFee && route.receiveFee[to]) || 0;
  const received = value - receiveFee;
  const midReceived = convertMid(amount, from, to, rates);
  const totalCost = midReceived - received;

  const usd = toUsd(amount, from, rates);
  const overLimit = route.maxSourceUsd ? usd > route.maxSourceUsd : false;

  return {
    routeId: route.id,
    routeName: route.name,
    category: route.category,
    from, to,
    sendAmount: round2(amount),
    upfrontFee: round2(feeInSource),
    receiveFee: round2(receiveFee),
    paymentFee: round2(paymentFee),
    trap: !!route.trap,
    pack: route.pack || null,
    legs: legDetails,
    conversions: path.length - 1,
    received: round2(received),
    midMarketReceived: round2(midReceived),
    totalCost: round2(totalCost),
    totalCostPct: round2((totalCost / midReceived) * 100),
    totalCostInSource: round2(totalCost / midRate(from, to, rates)),
    days: route.days,
    schoolVerified: !!route.schoolVerified,
    purposes: route.purposes,
    overLimit,
    needsDocsAboveQuota: !!route.needsDocsAboveQuota,
    notes: route.notes,
    source: route.source || null,
    simulated: route.simulated !== false,
    ratesAsOf: RATES_AS_OF,
  };
}

/** Find the source amount needed so that `target` arrives in `to` (binary search). */
export function quoteRouteForTarget(route, from, to, target, rates = UNITS_PER_USD) {
  if (!route.from.includes(from) || !route.to.includes(to)) return null;
  let lo = convertMid(target, to, from, rates);
  let hi = lo * 1.5 + 10000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const q = quoteRoute(route, from, to, mid, rates);
    if (q.received >= target) hi = mid; else lo = mid;
  }
  // Round up to the next whole unit so the target is always met.
  const amount = Math.ceil(hi);
  return quoteRoute(route, from, to, amount, rates);
}

/**
 * Compare all eligible routes. Provide either `amount` (source) or `targetAmount` (destination).
 * Routes are ranked by what the user cares about: for a fixed send amount, most received;
 * for a target amount, least sent. Ineligible routes are returned separately with a reason.
 */
export function compareRoutes({ from, to, amount, targetAmount, purpose, daysUntilDue }, rates = UNITS_PER_USD) {
  const eligible = [];
  const excluded = [];
  for (const route of ROUTES) {
    if (!route.from.includes(from) || !route.to.includes(to)) continue;
    const q = targetAmount ? quoteRouteForTarget(route, from, to, targetAmount, rates) : quoteRoute(route, from, to, amount, rates);
    if (!q) continue;
    if (purpose && !route.purposes.includes(purpose)) { excluded.push({ ...q, reason: `Not designed for ${purpose} payments` }); continue; }
    if (q.overLimit) { excluded.push({ ...q, reason: `Above this provider's per-transfer limit (USD ${route.maxSourceUsd.toLocaleString()})` }); continue; }
    if (daysUntilDue != null && q.days[1] > daysUntilDue) { excluded.push({ ...q, reason: `May arrive after the due date (up to ${q.days[1]} business days)` }); continue; }
    eligible.push(q);
  }
  eligible.sort((a, b) => (a.trap - b.trap) || (targetAmount ? a.sendAmount - b.sendAmount : b.received - a.received));
  if (eligible.length) {
    const best = eligible[0];
    for (const q of eligible) {
      q.vsBest = targetAmount ? round2(q.sendAmount - best.sendAmount) : round2(best.received - q.received);
    }
  }
  return { from, to, amount: amount ?? null, targetAmount: targetAmount ?? null, purpose: purpose ?? null, ratesAsOf: RATES_AS_OF, eligible, excluded };
}
