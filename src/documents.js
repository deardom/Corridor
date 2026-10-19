// Document intake: invoices and other files are UNTRUSTED DATA.
// 1) strip markup and record anything hidden,
// 2) scan for instructions aimed at the AI (prompt injection),
// 3) extract fields,
// 4) verify payment details against the verified school registry.
import { SCHOOL_REGISTRY } from "./data.js";

const INJECTION_PATTERNS = [
  { id: "override", re: /ignore (all |any |your )?(previous|prior|above) (instructions|rules)|disregard (the )?(rules|instructions)/i },
  { id: "addresses_ai", re: /\b(AI|assistant|agent|chatbot|LLM)\b[^.\n]{0,40}(must|should|:|please)/i },
  { id: "skip_confirmation", re: /(do not|don't|without) (ask(ing)? (for )?)?confirm|already (been )?approved|no need to (confirm|verify)/i },
  { id: "urgent_transfer_command", re: /(immediately|now) (transfer|send|pay|wire)/i },
  { id: "zh_override", re: /忽略(之前|以上)的?(指令|规则)|无需确认|已经批准/ },
  { id: "ru_override", re: /игнорируй(те)? (предыдущие|все) (инструкции|правила)|без подтверждения/i },
];

const HIDDEN_MARKUP = /<[^>]*(display\s*:\s*none|font-size\s*:\s*[0-2]px|color\s*:\s*(white|#fff\b|#ffffff)|opacity\s*:\s*0|visibility\s*:\s*hidden)[^>]*>([\s\S]*?)<\/[^>]+>/gi;

export function scanDocument(raw) {
  const text = String(raw || "");
  const findings = [];
  let m;
  HIDDEN_MARKUP.lastIndex = 0;
  while ((m = HIDDEN_MARKUP.exec(text))) {
    findings.push({ type: "hidden_text", detail: "Text styled to be invisible to a human reader", excerpt: m[3].trim().slice(0, 160) });
  }
  for (const p of INJECTION_PATTERNS) {
    const hit = text.match(p.re);
    if (hit) findings.push({ type: "instruction_to_ai", rule: p.id, excerpt: hit[0] });
  }
  if (/bank (details|account|information) (have |has )?changed|new (bank|payment) details/i.test(text)) {
    findings.push({ type: "changed_bank_details", detail: "Document claims the payment details changed (a common invoice-fraud pattern)" });
  }
  const visible = text.replace(HIDDEN_MARKUP, "").replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n").trim();
  return { suspicious: findings.some((f) => f.type !== "changed_bank_details") || findings.length > 1, findings, visibleText: visible };
}

function parseMoney(s) {
  return Number(String(s).replace(/[,\s]/g, ""));
}

export function parseInvoice(raw) {
  const { visibleText } = scanDocument(raw);
  const t = visibleText;
  const total = t.match(/TOTAL DUE[ .]*([\d,]+\.\d{2})\s*([A-Z]{3})/i);
  const due = t.match(/Due date:\s*(\d{4}-\d{2}-\d{2})/i);
  const sid = t.match(/Student ID:\s*([A-Z]{2}-\d{4}-\d+)/i);
  const ref = t.match(/Payment reference:\s*([A-Z0-9-]+)/i);
  const school = SCHOOL_REGISTRY.find((s) => t.toUpperCase().includes(s.name.toUpperCase()));
  // Every account number in the FULL raw text (hidden text included), so we can see what an attacker injected.
  const accounts = [...new Set((String(raw).match(/\b\d{5}-\d{3}-\d{6,10}\b/g) || []))];
  const payTo = t.match(/Pay to:\s*([^\n]+)/i);
  return {
    schoolId: school?.id || null,
    schoolName: school?.name || null,
    amount: total ? parseMoney(total[1]) : null,
    currency: total ? total[2].toUpperCase() : null,
    dueDate: due ? due[1] : null,
    studentId: sid ? sid[1] : null,
    reference: ref ? ref[1] : null,
    payToLine: payTo ? payTo[1].trim() : null,
    accountsFound: accounts,
  };
}

/** Compare an invoice's payment details with the verified registry. */
export function verifyInvoice(raw) {
  const scan = scanDocument(raw);
  const inv = parseInvoice(raw);
  const school = SCHOOL_REGISTRY.find((s) => s.id === inv.schoolId);
  const problems = [];
  if (!school) problems.push("School not in the verified registry");
  const foreign = school ? inv.accountsFound.filter((a) => a !== school.accountFull) : inv.accountsFound;
  if (foreign.length) problems.push(`Account number(s) that do not match the school's verified account: ${foreign.map((a) => "****" + a.slice(-4)).join(", ")}`);
  if (scan.findings.length) problems.push(...scan.findings.map((f) => (f.type === "hidden_text" ? "Hidden text found in the document" : f.type === "instruction_to_ai" ? `Embedded instruction aimed at the AI ("${f.excerpt}")` : f.detail)));
  return {
    invoice: inv,
    trusted: problems.length === 0,
    problems,
    verifiedPayee: school ? { schoolId: school.id, payeeName: school.payeeName, bank: school.bank, accountLast4: school.accountLast4 } : null,
    scan: { suspicious: scan.suspicious, findings: scan.findings },
  };
}
