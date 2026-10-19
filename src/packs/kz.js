// Country pack: Kazakhstan.
export default {
  code: "KZ",
  name: "Kazakhstan",
  flag: "🇰🇿",
  currency: "KZT",
  languages: ["kk", "ru"],
  localRails: [
    { id: "kaspi_qr", name: "Kaspi QR / Kaspi transfers", note: "Most shops, cafés, taxis and markets take Kaspi QR or Kaspi transfers. Cards work in larger stores; small vendors often prefer Kaspi or cash." },
    { id: "cash_kzt", name: "Cash (tenge)", note: "Useful for markets and small vendors." },
  ],
  routes: [
    {
      id: "kaspi_intl_card",
      name: "Kaspi.kz international transfer (USD to card) + conversion abroad",
      category: "kaspi",
      from: ["KZT"],
      to: ["CAD"],
      legs: [
        { via: "USD", markupPct: 0.8, label: "Kaspi converts KZT to USD" },
        { markupPct: 2.5, label: "Receiving bank converts USD to CAD" },
      ],
      feePct: 0.95, feeFixed: 0, feeMin: 200, feeCurrency: "KZT",
      receiveFee: { CAD: 0 },
      days: [0, 2],
      purposes: ["living", "family", "rent"],
      notes: "Two conversions (KZT to USD, then USD to CAD). Check in the Kaspi app that the destination country and card are supported.",
      source: "Fee 0.95%, minimum 200 KZT: Kaspi Guide, International transfers (guide.kaspi.kz, checked 2026-10-18). FX spreads simulated.",
      simulated: true,
    },
    {
      id: "kaspi_swift",
      name: "Kaspi Bank SWIFT wire (SWIFT: CASPKZKA)",
      category: "bank_wire",
      from: ["KZT"],
      to: ["CAD", "USD"],
      legs: [{ markupPct: 0.9 }],
      feePct: 0.2, feeFixed: 0, feeMin: 5000, feeMax: 25000, feeCurrency: "KZT",
      receiveFee: { CAD: 17, USD: 15 },
      days: [2, 5],
      purposes: ["tuition", "living", "family", "rent"],
      notes: "Single conversion; better for large amounts despite fixed fees.",
      simulated: true,
    },
  ],
  setupChecklist: [
    { id: "kz_iin", title: "Get an IIN (individual identification number)", detail: "Apply in person at a Citizen Service Center (TsON) with your passport. Usually ready in a few working days." },
    { id: "kz_sim", title: "Get a Kazakh SIM card", detail: "Banks and Kaspi send confirmation codes by SMS to a local number." },
    { id: "kz_registration", title: "Have your temporary registration", detail: "Usually arranged by your university, dorm or landlord." },
    { id: "kz_kaspi", title: "Open Kaspi (or another local bank)", detail: "Kaspi accounts are in tenge. Some banks ask foreign students for extra tax documents; ask your university's international office which bank works best." },
  ],
  cardTraps: [
    "Small shops and taxis may only take Kaspi QR or cash: carry some tenge.",
    "If a terminal or ATM offers to charge you in CAD, choose tenge (KZT). The 'convert for you' rate is usually worse.",
  ],
  healthInsurance: {
    incoming: "Foreign students in Kazakhstan are usually asked for health insurance by their university. Check what your exchange program requires and what it covers.",
    outgoing: "",
  },
  scamSignals: [
    { id: "kz_bank_security", weight: 30, label: "Someone from 'bank security' asks for your SMS code or to move money", patterns: [/служба безопасности|безопасности банка|bank security|kaspi security/i] },
  ],
  emergency: { police: "102", ambulance: "103", general: "112" },
};
