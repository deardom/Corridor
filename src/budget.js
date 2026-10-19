// Personal budget, savings pots and wishlist for students whose income arrives
// in one currency and whose spending happens in another.
import { convertMid } from "./fx.js";
import { round2 } from "./util.js";

export const ESSENTIAL = ["rent", "groceries", "phone_internet", "transit"];

const LABELS = { rent: "Rent", groceries: "Groceries", phone_internet: "Phone & internet", transit: "Transit", eating_out: "Eating out", shopping: "Shopping", fun: "Fun", travel: "Travel" };
export function label(cat) { return LABELS[cat] || cat; }

function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** All budget maths happens in the budget currency (CAD for both demo students). */
export function budgetSummary(budget, today, rates, cur = "CAD") {
  const toB = (amt, c) => round2(convertMid(amt, c || cur, cur, rates));
  const incomes = budget.incomes.map((i) => ({ ...i, inBudgetCurrency: toB(i.amount, i.currency) }));
  const income = round2(incomes.reduce((s, i) => s + i.inBudgetCurrency, 0));
  const monthSpends = budget.spends.filter((s) => s.date.startsWith(budget.month) && !s.fromPot);
  const cats = {};
  for (const [cat, limit] of Object.entries(budget.categories)) cats[cat] = { limit, spent: 0, count: 0 };
  for (const s of monthSpends) {
    cats[s.category] = cats[s.category] || { limit: 0, spent: 0, count: 0 };
    cats[s.category].spent = round2(cats[s.category].spent + toB(s.amount, s.currency));
    cats[s.category].count++;
  }
  const totalSpent = round2(Object.values(cats).reduce((s, c) => s + c.spent, 0));
  const essentialsLeft = round2(ESSENTIAL.reduce((s, c) => s + Math.max(0, (cats[c]?.limit || 0) - (cats[c]?.spent || 0)), 0));
  const safeToSpend = round2(Math.max(0, income - budget.savingsGoal - totalSpent - essentialsLeft));
  const end = monthEnd(budget.month);
  const daysLeft = Math.max(1, Math.round((new Date(end) - new Date(today)) / 86400000) + 1);

  const categories = Object.entries(cats).map(([name, c]) => ({
    name, label: label(name), limit: c.limit, spent: c.spent, left: round2(c.limit - c.spent), count: c.count,
    pct: c.limit ? Math.round((c.spent / c.limit) * 100) : null,
    status: !c.limit ? "unbudgeted" : c.spent > c.limit ? "over" : c.spent / c.limit >= 0.8 ? "near" : "ok",
  }));

  const insights = [];
  for (const c of categories) {
    if (c.status === "over") insights.push(`${c.label} is over budget by ${round2(c.spent - c.limit)} ${cur}.`);
    else if (c.status === "near") insights.push(`${c.label} is at ${c.pct}% of its budget with ${daysLeft} days left.`);
  }
  const foreignSpend = monthSpends.filter((s) => (s.currency || cur) !== cur);
  if (foreignSpend.length) {
    const fx = round2(foreignSpend.reduce((s, x) => s + toB(x.amount, x.currency), 0));
    insights.push(`${Math.round((fx / Math.max(1, totalSpent)) * 100)}% of your spending this month was in ${[...new Set(foreignSpend.map((s) => s.currency))].join("/")}, so exchange rates move your real budget.`);
  }
  const foreignIncome = incomes.filter((i) => i.currency !== cur);
  if (foreignIncome.length) {
    const amt = foreignIncome.reduce((s, i) => s + i.inBudgetCurrency, 0);
    insights.push(`${Math.round((amt / income) * 100)}% of your income arrives in ${foreignIncome.map((f) => f.currency).join("/")}. A 5% drop in that currency means about ${round2(amt * 0.05)} ${cur} less per month.`);
  }

  return {
    currency: cur, month: budget.month, today, daysLeft,
    incomes, income, totalSpent, savingsGoal: budget.savingsGoal,
    essentialsStillToPay: essentialsLeft,
    safeToSpend, safePerDay: round2(safeToSpend / daysLeft),
    categories, insights,
    recent: [...budget.spends].filter((x) => !x.fromPot).slice(-8).reverse().map((x) => ({ ...x, inBudgetCurrency: toB(x.amount, x.currency) })),
  };
}

export function potStatus(pot, today) {
  const days = Math.round((new Date(pot.due) - new Date(today)) / 86400000);
  const weeks = Math.max(1, Math.floor(days / 7));
  const remaining = round2(Math.max(0, pot.target - pot.saved));
  const neededWeekly = round2(remaining / weeks);
  return { ...pot, pct: Math.min(100, Math.round((pot.saved / pot.target) * 100)), remaining, daysLeft: days, weeksLeft: weeks, neededWeekly, onTrack: pot.weekly >= neededWeekly };
}

/** Decide what to do about one wishlist item given the budget and its linked pot. */
export function evaluateWish(item, summary, today, rates, pots = []) {
  const cur = summary.currency;
  const priceB = round2(convertMid(item.price, item.currency, cur, rates));
  const pot = item.potId ? pots.find((p) => p.id === item.potId) : null;
  const available = round2(summary.safeToSpend + (pot ? convertMid(pot.saved, pot.currency, cur, rates) : 0));
  const lowest = Math.min(...item.history.map((h) => h.price), item.price);
  const highest = Math.max(...item.history.map((h) => h.price), item.price);
  const onSale = item.price <= item.targetPrice;
  const affordable = priceB <= available;
  const daysToNeed = item.neededBy ? Math.round((new Date(item.neededBy) - new Date(today)) / 86400000) : null;
  const p = (x) => `${x.toLocaleString()} ${item.currency}`;
  const fundSrc = pot ? `your "${pot.name}" pot plus safe-to-spend (${available} ${cur})` : `your safe-to-spend (${summary.safeToSpend} ${cur})`;
  let verdict, advice;
  if (item.status === "bought") {
    verdict = "bought"; advice = "Already bought.";
  } else if (onSale && affordable) {
    verdict = "buy_now";
    advice = `Now ${p(item.price)} (≈ ${priceB} ${cur}), at or below your target of ${p(item.targetPrice)}, and ${fundSrc} covers it. Good time to buy: ${round2(highest - item.price).toLocaleString()} ${item.currency} below the highest price seen.`;
  } else if (onSale && !affordable) {
    verdict = "on_sale_but_tight";
    advice = `On sale at ${p(item.price)}, but ${fundSrc} doesn't cover it (${priceB} ${cur} needed). Buying now would cut into essentials or savings.`;
  } else if (daysToNeed !== null && daysToNeed <= 21) {
    verdict = "needed_soon";
    advice = `You need it in ${daysToNeed} days and it's still ${p(round2(item.price - item.targetPrice))} above your target. Watch for one more week; if there's no drop, buy before ${item.neededBy}.`;
  } else {
    verdict = "wait";
    advice = `Wait: ${p(round2(item.price - item.targetPrice))} above your target (lowest seen ${p(lowest)}). I'll alert you when it drops.`;
  }
  return { id: item.id, name: item.name, store: item.store, currency: item.currency, price: item.price, priceInBudgetCurrency: priceB, targetPrice: item.targetPrice, lowestSeen: lowest, history: item.history, potId: item.potId || null, onSale, affordable, neededBy: item.neededBy, verdict, advice, status: item.status };
}

/** "Can I afford this right now?" check for an impulse purchase (price in the budget currency). */
export function checkPurchase({ name, price, category = "shopping" }, summary) {
  const cur = summary.currency;
  const cat = summary.categories.find((c) => c.name === category);
  const afterSafe = round2(summary.safeToSpend - price);
  const fitsCategory = cat ? cat.spent + price <= cat.limit : false;
  let verdict, advice;
  if (afterSafe >= 0 && fitsCategory) {
    verdict = "ok";
    advice = `Fits your budget: you'd still have ${afterSafe} ${cur} safe to spend this month.`;
  } else if (afterSafe >= 0) {
    verdict = "over_category";
    advice = `You can afford it, but it pushes ${label(category)} over budget (${cat ? `${cat.spent} of ${cat.limit} ${cur} used` : "no budget set"}).`;
  } else {
    verdict = "not_affordable";
    advice = `Not this month: it's ${round2(-afterSafe)} ${cur} more than your safe-to-spend (${summary.safeToSpend} ${cur}).`;
  }
  return { name, price, currency: cur, category, verdict, advice, safeToSpendAfter: afterSafe, suggestedTargetPrice: round2(price * 0.8) };
}
