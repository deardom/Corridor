// Country pack: Canada. Everything country-specific lives in a pack like this one.
// Adding a country = adding one file with the same shape; the engine does not change.
export default {
  code: "CA",
  name: "Canada",
  flag: "🇨🇦",
  currency: "CAD",
  languages: ["en", "fr"],
  localRails: [
    { id: "interac", name: "Interac e-Transfer", note: "Instant domestic transfers between Canadian bank accounts." },
    { id: "debit", name: "Interac debit / credit cards", note: "Cards are accepted almost everywhere." },
  ],
  routes: [],
  setupChecklist: [
    { id: "ca_sin", title: "Get a Social Insurance Number (SIN) if you will work", detail: "Needed to be paid by an employer." },
    { id: "ca_bank", title: "Open a student bank account", detail: "Bring your passport and study permit. Most banks offer no-fee student accounts." },
    { id: "ca_credit", title: "Start a credit history", detail: "A secured or student card, kept at a low balance and paid in full, builds history from month one." },
  ],
  cardTraps: [],
  healthInsurance: {
    incoming: "International students in Canada usually need a mandatory health plan through their school or province. Rules, costs and waiting periods differ by province: check your school's international student office.",
    outgoing: "Before leaving Canada, check whether your provincial health plan still covers you while you study abroad and for how long, and buy travel medical insurance for anything it doesn't cover.",
  },
  scamSignals: [
    { id: "ca_cra", weight: 30, label: "Caller claims to be the CRA, IRCC or police and demands payment", patterns: [/\bCRA\b|canada revenue|\bIRCC\b|immigration officer/i] },
  ],
  emergency: { police: "911", fraud: "Canadian Anti-Fraud Centre 1-888-495-8501" },
};
