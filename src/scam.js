// Scam shield: scores the context around a transfer for known scam patterns
// that target international students. Multilingual (EN / 中文 / Русский).
import { SCAM_SIGNALS } from "./data.js";

const ADVICE = {
  en: [
    "Do not send any money and do not share any code. Real police, embassies, banks and tax offices never ask you to move money to a 'safe account', read out an SMS code, or pay with gift cards or crypto.",
    "Hang up. Call your family and your bank yourself, using numbers you already know. Scammers often contact family at the same time.",
    "Tell your school's international office and report it to the local police.",
  ],
  zh: [
    "不要转账，也不要透露任何验证码。真正的警察、大使馆、银行或税务机关绝不会要求你把钱转到“安全账户”、念出短信验证码，或用礼品卡、加密货币付款。",
    "挂断电话。用你已知的号码亲自联系家人和银行。骗子常常同时联系你的家人。",
    "告诉学校国际学生办公室，并向当地警方报案。",
  ],
  ru: [
    "Не переводите деньги и не сообщайте никакие коды. Настоящая полиция, посольство, банк или налоговая никогда не просят перевести деньги на «безопасный счёт», назвать код из СМС или заплатить подарочными картами или криптовалютой.",
    "Положите трубку. Сами позвоните семье и в банк по известным вам номерам. Мошенники часто одновременно звонят родственникам.",
    "Сообщите в офис международных студентов и в местную полицию.",
  ],
};

/**
 * @param {string} text  The message(s) around the request: what the user said, pasted chats, call notes.
 * @param {object} opts  { payeeVerified, amountCad, language }
 */
export function assessScamRisk(text, { payeeVerified = true, amountCad = 0, language = "en", emergency = null } = {}) {
  const t = String(text || "");
  const hits = [];
  let score = 0;
  for (const s of SCAM_SIGNALS) {
    if (s.id === "new_payee_abroad") {
      if (!payeeVerified && amountCad > 0) { hits.push({ id: s.id, label: s.label }); score += s.weight; }
      continue;
    }
    const m = s.patterns.map((re) => t.match(re)).find(Boolean);
    if (m) { hits.push({ id: s.id, label: s.label, evidence: m[0] }); score += s.weight; }
  }
  // Combination bonus: authority + money + secrecy is the classic pattern.
  const ids = new Set(hits.map((h) => h.id));
  if (ids.has("authority_impersonation") && (ids.has("safe_account") || ids.has("untraceable_payment"))) score += 15;
  score = Math.min(100, score);
  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  const lang = ADVICE[language] ? language : "en";
  return {
    score,
    level,
    signals: hits,
    pattern: ids.has("virtual_kidnapping") || (ids.has("authority_impersonation") && ids.has("secrecy")) ? "authority_impersonation_virtual_kidnapping" : hits.length ? "generic" : null,
    advice: level === "low" ? [] : [...ADVICE[lang], ...(emergency ? [`Local numbers: ${Object.entries(emergency).map(([k, v]) => `${k} ${v}`).join(", ")}.`] : [])],
  };
}
