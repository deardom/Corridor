// Credit builder for newcomers with no Canadian credit history.
// General education only: it never shows or invents a credit score.

export function creditPlan(credit) {
  const c = credit || {};
  const util = c.securedCardLimit > 0 ? c.securedCardBalance / c.securedCardLimit : null;
  const steps = [
    {
      id: "open_card",
      title: "Open a secured or student credit card",
      done: c.securedCardLimit > 0,
      detail: "A secured card uses a deposit as your limit, so banks approve it without Canadian history. Start small (e.g. a CAD 500 limit).",
    },
    {
      id: "low_utilization",
      title: "Keep the balance low",
      done: util !== null && util <= 0.3,
      detail: util === null ? "Once you have a card, keep the reported balance under about 30% of the limit." : `Current utilization: ${Math.round(util * 100)}%. Pay down before the statement date so the reported balance stays under about 30%.`,
    },
    {
      id: "autopay",
      title: "Never miss a payment: set up autopay",
      done: c.onTimePayments >= 1 && c.missedPayments === 0,
      detail: `Payment history is the biggest factor. On-time payments so far: ${c.onTimePayments || 0}. Missed: ${c.missedPayments || 0}.`,
    },
    {
      id: "rent_reporting",
      title: "Ask about rent reporting",
      done: !!c.rentReporting,
      detail: "Some landlords and services can report on-time rent payments to a credit bureau. Ask your landlord before signing up for any paid service.",
    },
    {
      id: "check_report",
      title: "Check your credit report for free",
      done: false,
      detail: "Equifax Canada and TransUnion Canada let you request your report for free. Check it after about 6 months.",
    },
  ];
  const months = c.monthsHistory || 0;
  const milestone = months < 6 ? { at: 6, text: "Around 6 months of on-time history, many students can ask their bank about an unsecured student card." } : months < 12 ? { at: 12, text: "Around 12 months, ask for a limit increase or the return of your secured deposit." } : { at: null, text: "Keep doing what works: low balance, on-time payments." };
  return {
    monthsHistory: months,
    utilizationPct: util === null ? null : Math.round(util * 100),
    steps,
    progress: `${steps.filter((s) => s.done).length}/${steps.length}`,
    nextMilestone: milestone,
    disclaimer: "General education, not credit counselling. Lender criteria vary.",
  };
}
