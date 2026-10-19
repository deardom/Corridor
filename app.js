// Corridor web app. All money logic lives in ./src (the same code the tests and
// evidence logs run). This file only draws screens and wires buttons.
import { Session } from "./src/session.js";
import { Agent } from "./src/agent.js";
import { PERSONAS, SAMPLE_MESSAGES, RATES_AS_OF } from "./src/data.js";
import { TIERS, TOOL_TIERS } from "./src/policy.js";
import { getPack } from "./src/packs/index.js";
import { midRate } from "./src/fx.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => Number(n).toLocaleString("en-CA", { maximumFractionDigits: d });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

const TABS = [
  { id: "home", label: "Home", ic: "◎", c: "ocean" },
  { id: "money", label: "Send", ic: "⇄", c: "teal" },
  { id: "budget", label: "Budget", ic: "▦", c: "accent" },
  { id: "wishlist", label: "Wishlist", ic: "☆", c: "primary" },
  { id: "trip", label: "Trip", ic: "✈", c: "amber" },
  { id: "safety", label: "Safety", ic: "⛉", c: "bad" },
];

const state = {
  personaId: "christina",
  tab: "home",
  session: null,
  agent: null,
  msgs: [],
  busy: false,
  sample: null,       // Claude via the artifact runtime, when available
  brain: "auto",      // "auto" uses Claude when available, else built-in
  tier: "quick",
  lastCompare: null,
  ctl: null,
};

// ---------------- Claude adapter (artifact runtime) ----------------
async function initClaude() {
  try {
    if (!window.claude?.use) return;
    const sample = await window.claude.use("sample");
    if (!sample) return;
    const lim = await sample.limits().catch(() => null);
    if (!lim?.tools) return;
    state.sample = sample;
    resetAgent();
    renderBrain();
  } catch { /* stay on the built-in agent */ }
}

function llmFn() {
  if (!state.sample || state.brain === "rules") return null;
  return async ({ instructions, history, message, tools, onText, signal }) => {
    const input = [{ role: "user", content: instructions + "\n\nThe conversation with the student follows." }, ...history, { role: "user", content: message }];
    const { text } = await state.sample(input, {
      modelTier: state.tier,
      signal,
      onText,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: (args) => t.execute(args) })),
    });
    return text;
  };
}

// ---------------- session lifecycle ----------------
function newSession(personaId) {
  state.personaId = personaId;
  state.session = new Session({ persona: personaId, language: $("#lang").value || "en" });
  state.msgs = [];
  state.lastCompare = null;
  $("#alertbar").innerHTML = "";
  resetAgent();
  const p = PERSONAS[personaId];
  addMsg("bot", `Hi ${p.name.split(" ")[0]}! I'm Corridor. I watch your money across ${[p.home, p.host, p.trip?.country].filter(Boolean).map((c) => getPack(c).name).join(", ")}. I can move money, buy things on your wishlist and save for you, but nothing happens without your Confirm.\n\nWhat do you need?`);
  renderAll();
}

function resetAgent() {
  if (!state.session) return;
  state.agent = new Agent(state.session, { llm: llmFn() });
}

// ---------------- messages ----------------
function addMsg(role, text, extra = {}) {
  state.msgs.push({ role, text, ...extra });
  renderMsgs();
}

function md(text) {
  const lines = esc(text).split("\n");
  let html = "", inList = false;
  for (let line of lines) {
    line = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)_(.+?)_(?=\s|$|[.,])/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
    const li = line.match(/^\s*[-•]\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const q = line.replace(/^&gt;\s?/, "");
    if (q.trim()) html += `<p>${q}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

async function ask(text, { attachments = [], silentUser = false } = {}) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  if (!silentUser) addMsg("user", text, { attachments });
  openAgent();
  const live = { role: "bot", text: "", thinking: true, tools: [] };
  state.msgs.push(live);
  renderMsgs();
  state.ctl = new AbortController();
  try {
    const r = await state.agent.handle(text, {
      attachments,
      signal: state.ctl.signal,
      onEvent: (e) => { if (e.type === "tool") { live.tools.push({ name: e.name, tier: e.tier, status: e.result.status }); renderMsgs(); } if (e.type === "alert") showAlert(e); if (e.type === "fallback") live.fallback = true; },
      onText: ({ text }) => { live.text = text; live.thinking = false; renderMsgs(); },
    });
    live.text = r.reply; live.thinking = false; live.brain = r.brain;
  } catch (e) {
    live.thinking = false;
    live.text = e?.code === "cancelled" ? (e.text || "Stopped.") : `I couldn't finish that (${esc(e?.code || e?.message || "error")}). Try again, or switch to the built-in agent in Safety.`;
  }
  state.busy = false;
  renderAll();
}

function showAlert(e) {
  const el = $("#alertbar");
  el.innerHTML = e.kind === "scam" ? `<div class="alertbar">Scam shield triggered (risk ${e.score}/100). Transfers are blocked while this conversation looks like a scam.</div>` : `<div class="alertbar">Compliance check: request looks like splitting a transfer to avoid a limit.</div>`;
  setTimeout(() => { el.innerHTML = ""; }, 9000);
}

// ---------------- UI-initiated actions (same tools, same guard) ----------------
function uiTool(name, args) {
  const r = state.session.callTool(name, args, "user_ui");
  if (r.status === "awaiting_user_confirmation") toast("Ready for your confirmation");
  else if (r.status === "executed_automatically") { addMsg("note", `✅ Done automatically: ${r.summary}`); toast("Done"); }
  else if (r.status === "blocked") { addMsg("note", `🛑 Blocked by the safety guard:\n${r.reasons.map((x) => `- ${x}`).join("\n")}`); toast("Blocked by the safety guard"); }
  else if (r.status === "error") toast(r.error);
  renderAll();
  return r;
}

function confirmPending(id) {
  const att = document.getElementById(`att-${id}`);
  const r = state.session.confirm(id, { documentsAttested: !!att?.checked });
  if (r.status === "executed") { addMsg("note", `✅ Confirmed: ${r.summary}`); toast("Done"); }
  else if (r.status === "blocked") addMsg("note", `🛑 Blocked at execution:\n${r.reasons.map((x) => `- ${x}`).join("\n")}`);
  else addMsg("note", `Couldn't complete: ${r.error}`);
  renderAll();
}

function rejectPending(id) {
  state.session.reject(id);
  addMsg("note", "Cancelled. Nothing was moved.");
  renderAll();
}

function toast(t) {
  const el = $("#toast");
  el.textContent = t; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------- rendering ----------------
function renderAll() {
  renderNav();
  renderScreen();
  renderMsgs();
  renderChips();
  renderBrain();
}

function pendingCount() { return state.session.pending.size; }

function renderNav() {
  const pc = pendingCount();
  $("#nav").innerHTML = TABS.map((t) => `<button type="button" style="--c: var(--${t.c}); --c-soft: var(--${t.c}-soft)" data-tab="${t.id}" ${state.tab === t.id ? 'aria-current="page"' : ""}><span class="ic" aria-hidden="true">${t.ic}</span>${t.label}${t.id === "home" && pc ? `<span class="badge">${pc}</span>` : ""}</button>`).join("") +
    `<button type="button" data-open-agent="1"><span class="ic" aria-hidden="true">✦</span>Ask Corridor</button>`;
  $("#tabbar").innerHTML = TABS.map((t) => `<button type="button" style="--c: var(--${t.c})" data-tab="${t.id}" ${state.tab === t.id ? 'aria-current="page"' : ""}><span class="ic" aria-hidden="true">${t.ic}</span>${t.label}${t.id === "home" && pc ? '<span class="dot"></span>' : ""}</button>`).join("") +
    `<button type="button" data-open-agent="1"><span class="ic" aria-hidden="true">✦</span>Ask</button>`;
}

function stubHtml(p) {
  const q = p.params.quote;
  const codes = q && q.from && q.to ? (q.from === q.to ? `${q.from}` : `${q.from} <span class="plane">✈</span> ${q.to}`) : "RULE";
  const label = { send_money: "Transfer", pay_tuition: "Tuition payment", convert_currency: "Currency conversion", buy_wishlist_item: "Purchase", save_to_pot: "Savings", set_auto_save: "Weekly saving rule", set_rate_rule: "Rate rule" }[p.action] || p.action;
  const needsDocs = (p.requirements || []).includes("documents_attested");
  return `<div class="stub" role="group" aria-label="Pending action">
    <div class="body">
      <div class="row"><span class="label">${esc(label)} · awaiting you</span></div>
      <div class="codes">${codes}</div>
      <p>${esc(p.summary)}</p>
      ${p.warnings?.length ? `<div class="warns">${p.warnings.map((w) => `⚠ ${esc(w)}`).join("<br>")}</div>` : ""}
      ${needsDocs ? `<label class="att"><input type="checkbox" id="att-${p.id}"> I will give the bank my admission letter and the tuition invoice.</label>` : ""}
    </div>
    <div class="tear"><button class="btn primary" type="button" data-confirm="${p.id}">Confirm</button><button class="btn ghost danger" type="button" data-reject="${p.id}">Cancel</button></div>
  </div>`;
}

function pendingBlock() {
  const ps = [...state.session.pending.values()];
  return ps.length ? `<div class="list">${ps.map(stubHtml).join("")}</div>` : "";
}

function whoStrip() {
  const L = state.session.ledger, p = L.persona;
  const legs = [`<span class="leg">${getPack(p.home).flag} ${p.home}</span>`, `<span class="arrow">→</span>`, `<span class="leg">${getPack(p.host).flag} ${p.host}</span>`];
  if (p.trip) legs.push(`<span class="arrow">⇢</span>`, `<span class="leg trip">${getPack(p.trip.country).flag} ${p.trip.country} · ${p.trip.start.slice(5)}</span>`);
  return `<div class="who"><h1>${esc(p.name)}</h1><div class="corridor-line">${legs.join("")}</div><span class="spacer"></span><span class="small muted">${esc(L.today)} · ${esc(p.tagline)}</span></div>`;
}

function renderScreen() {
  const fn = { home: screenHome, money: screenMoney, budget: screenBudget, wishlist: screenWishlist, trip: screenTrip, safety: screenSafety }[state.tab];
  const tab = TABS.find((t) => t.id === state.tab);
  const scr = $("#screen");
  scr.style.setProperty("--tab", `var(--${tab.c})`);
  scr.style.setProperty("--tab-soft", `var(--${tab.c}-soft)`);
  $("#screen-inner").innerHTML = `<div class="tab-band"><span class="dot"></span>${esc(tab.label)}</div>` + whoStrip() + fn();
}

function screenHome() {
  const s = state.session;
  const w = s.peek("get_wallet");
  const labels = w.walletLabels || {};
  const wallets = Object.entries(w.balances).filter(([k, v]) => !["totalCad", "inPotsCad"].includes(k) && (v > 0 || labels[k])).map(([k, v]) => `<div class="wallet"><span class="cur">${k}</span><span class="amt">${fmt(v)}</span><span class="sub">${esc(labels[k] || "")}</span></div>`).join("");
  const alerts = w.alerts.map((a) => {
    let action = "";
    if (a.kind === "shortfall") action = `<button class="btn" type="button" data-ask="Pay my rent please.">Fix it</button>`;
    if (a.kind === "pot_behind") action = `<button class="btn" type="button" data-tab-go="budget">Review</button>`;
    return `<div class="alert ${a.level}"><p class="small">${esc(a.text)}</p>${action}</div>`;
  }).join("");
  const host = getPack(s.ledger.persona.host);
  const setup = host.setupChecklist.map((c) => ({ ...c, done: s.ledger.setupDone.includes(c.id) }));
  return `${pendingBlock()}
  <section class="panel">
    <div class="panel-head"><span class="label">Safe to spend this month</span><span class="small muted">after essentials and savings</span></div>
    <div class="hero-num"><div class="big num">${fmt(w.safeToSpendThisMonth)}<small>${esc(s.ledger.persona.budgetCurrency)}</small></div><span class="small muted">Across all wallets ≈ <span class="num">${fmt(w.balances.totalCad)}</span> CAD · in savings pots <span class="num">${fmt(w.balances.inPotsCad)}</span> CAD</span></div>
    <div class="grid3">${wallets}</div>
  </section>
  ${alerts ? `<section class="panel"><div class="panel-head"><h2>Needs attention</h2><span class="small muted">Corridor checks these every day</span></div><div class="list">${alerts}</div></section>` : ""}
  <div class="grid2">
    <section class="panel"><div class="panel-head"><h2>Coming up</h2></div><div class="list">${w.obligations.map((o) => `<div class="row"><span class="pill ${o.status === "paid" ? "ok" : "warn"}">${o.status === "paid" ? "Paid" : "Due " + esc(o.due.slice(5))}</span><span class="small">${esc(o.label)}</span><span class="spacer"></span><span class="num small">${fmt(o.amount)} ${o.currency}</span></div>`).join("") || '<span class="muted small">Nothing due.</span>'}</div></section>
    <section class="panel"><div class="panel-head"><h2>Settling in ${host.flag}</h2><span class="small muted">${setup.filter((c) => c.done).length}/${setup.length}</span></div><div class="list">${setup.map((c) => `<div class="check ${c.done ? "done" : ""}"><span class="box">${c.done ? "✓" : ""}</span><div><b class="small">${esc(c.title)}</b></div></div>`).join("")}</div></section>
  </div>`;
}

function screenMoney() {
  const L = state.session.ledger;
  const home = L.persona.homeAccount.currency, hostCur = getPack(L.persona.host).currency;
  const curs = Object.keys(L.wallets);
  const opt = (sel) => curs.map((c) => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");
  const lc = state.lastCompare;
  let table = "";
  if (lc) {
    const r = lc.result;
    const max = Math.max(...r.eligible.map((q) => q.totalCostPct), 1);
    table = `<section class="panel"><div class="panel-head"><h2>${esc(r.from)} → ${esc(r.to)}: ${fmt(r.amount || r.targetAmount)} ${esc(r.amount ? r.from : r.to)}</h2><span class="small muted">Hidden cost = gap to the real exchange rate · rates ${esc(RATES_AS_OF)}</span></div>
    <div class="tscroll"><table><thead><tr><th>Option</th><th>${r.targetAmount ? "You send" : "Arrives"}</th><th>Hidden cost</th><th>Speed</th><th></th></tr></thead><tbody>
    ${r.eligible.map((q, i) => `<tr class="${q.trap ? "trap" : i === 0 ? "best" : ""}"><td>${q.trap ? "🚫 " : i === 0 ? "🟢 " : ""}${esc(q.route)}${q.conversions > 1 ? ' <span class="pill warn">2 conversions</span>' : ""}${q.source ? `<div class="small muted">${esc(q.source)}</div>` : ""}</td><td class="num">${esc(r.targetAmount ? q.send : q.received)}</td><td><div class="costbar"><div class="bar"><i style="width:${Math.min(100, (q.totalCostPct / max) * 100)}%"></i></div><span class="num small">${esc(q.hiddenCost)}</span></div></td><td class="small">${esc(q.days)}</td><td>${q.trap || q.category === "card" || q.category === "mobile_wallet" ? '<span class="small muted">for purchases</span>' : `<button class="btn" type="button" data-use-route="${q.routeId}">Use</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    ${r.excluded.filter((e) => e.category !== "card").length ? `<p class="small muted">Not suitable: ${r.excluded.filter((e) => e.category !== "card").map((e) => `${esc(e.route)} (${esc(e.reason)})`).join("; ")}</p>` : ""}
    </section>`;
  }
  return `${pendingBlock()}
  <section class="panel">
    <div class="panel-head"><h2>Move money between countries</h2><span class="small muted">Every option, against the real exchange rate</span></div>
    <form class="inline" id="compare-form">
      <div class="field"><label for="cf-from">From</label><select id="cf-from">${opt(home)}</select></div>
      <div class="field"><label for="cf-to">To</label><select id="cf-to">${opt(hostCur === home ? "CAD" : hostCur)}</select></div>
      <div class="field"><label for="cf-mode">Amount is</label><select id="cf-mode"><option value="target">what must arrive</option><option value="send">what I send</option></select></div>
      <div class="field"><label for="cf-amt">Amount</label><input id="cf-amt" inputmode="decimal" value="${L.persona.id === "christina" ? "100000" : "5000"}"></div>
      <div class="field"><label for="cf-to-who">Send to</label><select id="cf-to-who">${L.payees.map((p) => `<option value="${p.id}" ${p.id === "p_self_host" ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <button class="btn primary" type="submit">Compare</button>
    </form>
  </section>
  ${table}
  <section class="panel"><div class="panel-head"><h2>Recent activity</h2></div>
    ${L.transactions.length ? `<div class="tscroll"><table><thead><tr><th>Date</th><th>What</th><th>Sent</th><th>Received</th><th>Hidden cost</th></tr></thead><tbody>${L.transactions.slice().reverse().map((t) => `<tr><td class="num small">${esc(t.date)}</td><td class="small">${esc(t.kind)}${t.routeId ? ` · ${esc(t.routeId)}` : ""}</td><td class="num small">${fmt(t.sent)} ${esc(t.from)}</td><td class="num small">${fmt(t.received)} ${esc(t.to)}</td><td class="num small">${t.totalCostVsMid ? fmt(t.totalCostVsMid) + " " + esc(t.to) : "0"}</td></tr>`).join("")}</tbody></table></div>` : '<p class="small muted">No transactions yet in this sandbox.</p>'}
  </section>`;
}

function screenBudget() {
  const b = state.session.peek("get_budget");
  const L = state.session.ledger;
  const curOpts = (sel) => Object.keys(L.wallets).map((c) => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");
  const cats = b.categories.filter((c) => c.limit).map((c) => `<div class="cat"><span>${esc(c.label)}</span><div class="bar ${c.status}"><i style="width:${Math.min(100, c.pct)}%"></i></div><span class="num small">${fmt(c.spent, 0)} / ${fmt(c.limit, 0)}</span></div>`).join("");
  const pots = b.pots.map((p) => `<div class="pot">
    <div class="top"><h3>${p.kind === "health" ? "🩺" : "✈️"} ${esc(p.name)}</h3><span class="pill ${p.onTrack ? "ok" : "warn"}">${p.onTrack ? "On track" : "Behind"}</span></div>
    <div class="bar"><i style="width:${p.pct}%"></i></div>
    <div class="row small"><span class="num">${fmt(p.saved)} / ${fmt(p.target)} ${esc(p.currency)}</span><span class="spacer"></span><span class="muted">by ${esc(p.due)} · needs <span class="num">${fmt(p.neededWeekly)}</span>/week</span></div>
    <p class="small muted" style="margin:0">${esc(p.why || "")}</p>
    <div class="row"><button class="btn" type="button" data-save-pot="${p.id}" data-amt="${p.weekly}">Save ${fmt(p.weekly)} now</button>${p.autoSave ? `<span class="pill accent">Auto-save ${fmt(p.weekly)}/week</span>` : `<button class="btn ghost" type="button" data-auto-pot="${p.id}">Save automatically every week</button>`}</div>
  </div>`).join("");
  return `${pendingBlock()}
  <section class="panel">
    <div class="panel-head"><span class="label">Safe to spend · ${esc(b.month)}</span><span class="small muted">${b.daysLeft} days left</span></div>
    <div class="hero-num"><div class="big num">${fmt(b.safeToSpend)}<small>${esc(b.currency)}</small></div><span class="small muted">≈ <span class="num">${fmt(b.safePerDay)}</span> ${esc(b.currency)} a day</span></div>
    <div class="small muted">Income <span class="num">${fmt(b.income)}</span> (${b.incomes.map((i) => `${fmt(i.amount)} ${esc(i.currency)} ${esc(i.label.toLowerCase())}`).join(" + ")}) − spent <span class="num">${fmt(b.totalSpent)}</span> − essentials still due <span class="num">${fmt(b.essentialsStillToPay)}</span> − savings <span class="num">${fmt(b.savingsGoal)}</span></div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head"><h2>Add an expense</h2><span class="small muted">or tell Corridor: “I spent 4,500 tenge on lunch”</span></div>
      <form class="inline" id="expense-form">
        <div class="field" style="grid-column: 1 / -1"><label for="ex-what">What</label><input id="ex-what" placeholder="e.g. Lunch with friends" required></div>
        <div class="field"><label for="ex-amt">Amount</label><input id="ex-amt" inputmode="decimal" placeholder="4500" required></div>
        <div class="field"><label for="ex-cur">Currency</label><select id="ex-cur">${curOpts(L.persona.id === "christina" ? "KZT" : "CAD")}</select></div>
        <div class="field"><label for="ex-cat">Category</label><select id="ex-cat">${b.categories.filter((c) => c.limit).map((c) => `<option value="${c.name}" ${c.name === "eating_out" ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select></div>
        <button class="btn primary" type="submit">Add expense</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Add income</h2><span class="small muted">pay, scholarship, money from family</span></div>
      <form class="inline" id="income-form">
        <div class="field" style="grid-column: 1 / -1"><label for="in-what">From</label><input id="in-what" placeholder="e.g. Tutoring this week" required></div>
        <div class="field"><label for="in-amt">Amount</label><input id="in-amt" inputmode="decimal" placeholder="120" required></div>
        <div class="field"><label for="in-cur">Currency</label><select id="in-cur">${curOpts("CAD")}</select></div>
        <button class="btn primary" type="submit">Add income</button>
      </form>
    </section>
  </div>
  <section class="panel"><div class="panel-head"><h2>Latest spending</h2><span class="small muted">this month, converted to ${esc(b.currency)}</span></div>
    <div class="tscroll"><table><thead><tr><th>Date</th><th>What</th><th>Category</th><th>Amount</th><th>In ${esc(b.currency)}</th></tr></thead><tbody>
    ${b.recent.map((x) => `<tr><td class="num small">${esc(x.date.slice(5))}</td><td class="small">${esc(x.merchant)}${x.manual ? ' <span class="pill accent">added</span>' : ""}</td><td class="small">${esc(x.category.replace("_", " "))}</td><td class="num small">${fmt(x.amount)} ${esc(x.currency || b.currency)}</td><td class="num small">${fmt(x.inBudgetCurrency)}</td></tr>`).join("")}
    </tbody></table></div>
  </section>
  <div class="grid2">
    <section class="panel"><div class="panel-head"><h2>Categories</h2><span class="small muted">in ${esc(b.currency)}</span></div><div class="list">${cats}</div></section>
    <section class="panel"><div class="panel-head"><h2>What Corridor noticed</h2></div><div class="list">${b.insights.map((i) => `<div class="alert"><p class="small">${esc(i)}</p></div>`).join("")}</div></section>
  </div>
  <section class="panel"><div class="panel-head"><h2>Savings pots</h2><span class="small muted">money set aside for big bills, including health insurance</span></div><div class="grid2">${pots}</div></section>`;
}

function spark(item) {
  const pts = item.history.map((h) => h.price);
  const lo = Math.min(...pts, item.targetPrice) * 0.97, hi = Math.max(...pts, item.targetPrice) * 1.02;
  const W = 150, H = 56, pad = 4;
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, pts.length - 1);
  const y = (v) => H - 12 - ((v - lo) / (hi - lo || 1)) * (H - 18);
  const path = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ty = y(item.targetPrice);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history">
    <line x1="0" x2="${W}" y1="${ty}" y2="${ty}" stroke="var(--ok)" stroke-dasharray="3 3" stroke-width="1"/>
    <text x="${W - 2}" y="${ty - 3}" text-anchor="end">target</text>
    <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1])}" r="3.5" fill="${item.onSale ? "var(--ok)" : "var(--primary)"}"/>
    <text x="2" y="${H - 1}">${item.history.length} price checks</text>
  </svg>`;
}

function screenWishlist() {
  const wl = state.session.peek("get_wishlist");
  const verdict = { buy_now: ["go", "Buy now"], on_sale_but_tight: ["warn", "On sale, budget tight"], needed_soon: ["warn", "Needed soon"], wait: ["", "Waiting for target"], bought: ["ok", "Bought"] };
  const items = wl.items.map((i) => {
    const [cls, txt] = verdict[i.verdict] || ["", i.verdict];
    return `<article class="wish ${i.verdict === "buy_now" ? "go" : ""}">
      <div class="list" style="gap:6px">
        <div class="row"><h3>${esc(i.name)}</h3><span class="pill ${cls}">${txt}</span></div>
        <div class="row small muted">${esc(i.store)}${i.potId ? " · paid from trip pot" : ""}${i.neededBy ? ` · needed by ${esc(i.neededBy)}` : ""}</div>
        <div class="row"><span class="price">${fmt(i.price)} ${esc(i.currency)}</span><span class="small muted">target <span class="num">${fmt(i.targetPrice)}</span> · lowest <span class="num">${fmt(i.lowestSeen)}</span>${i.currency !== wl.currency ? ` · ≈ <span class="num">${fmt(i.priceInBudgetCurrency)}</span> ${esc(wl.currency)}` : ""}</span></div>
        <p class="advice">${esc(i.advice)}</p>
        ${i.verdict === "buy_now" ? `<div><button class="btn primary" type="button" data-buy="${i.id}">Buy at this price</button></div>` : ""}
      </div>
      ${spark(i)}
    </article>`;
  }).join("");
  return `${pendingBlock()}
  <section class="panel">
    <div class="panel-head"><h2>Add something you want</h2><span class="small muted">Corridor watches the price and checks your budget before saying buy</span></div>
    <form class="inline" id="wish-form">
      <div class="field" style="grid-column: span 2"><label for="wf-name">What</label><input id="wf-name" placeholder="e.g. Winter coat" required></div>
      <div class="field"><label for="wf-price">Price now</label><input id="wf-price" inputmode="decimal" placeholder="250" required></div>
      <div class="field"><label for="wf-cur">Currency</label><select id="wf-cur">${Object.keys(state.session.ledger.wallets).map((c) => `<option ${c === state.session.ledger.persona.budgetCurrency ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label for="wf-target">Target price</label><input id="wf-target" inputmode="decimal" placeholder="optional"></div>
      <button class="btn primary" type="submit">Add to wishlist</button>
    </form>
  </section>
  <div class="panel-head"><h2>Watching ${wl.items.filter((i) => i.verdict !== "bought").length} items</h2><span class="small muted">Safe to spend: <span class="num">${fmt(wl.safeToSpend)}</span> ${esc(wl.currency)}</span></div>
  <div class="list">${items || '<p class="muted">Nothing on your wishlist yet.</p>'}</div>`;
}

function screenTrip() {
  const r = state.session.peek("trip_readiness");
  if (!r.hasTrip) return `<section class="panel"><h2>No trip planned</h2><p class="muted small">When a trip to another country is planned, Corridor loads that country's pack: payment apps, card traps, insurance and emergency numbers.</p></section>`;
  const opts = r.paymentCosts.options;
  const best = Math.min(...opts.filter((o) => !o.trap).map((o) => o.total));
  const maxExtra = Math.max(...opts.map((o) => o.extraVsMid), 1);
  return `${pendingBlock()}
  <section class="panel">
    <div class="panel-head"><h2>${esc(r.destination)}</h2><span class="pill accent">${esc(r.dates)} · in ${r.daysUntil} days</span></div>
    <div class="list">${r.checklist.map((c) => `<div class="check ${c.done ? "done" : ""}"><span class="box">${c.done ? "✓" : ""}</span><div><b class="small">${esc(c.title)}</b><p>${esc(c.detail)}</p></div></div>`).join("")}</div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>How to pay in China</h2><span class="small muted">cost of spending ${fmt(r.paymentCosts.spendLocal)} ${esc(r.paymentCosts.tripCurrency)} on the trip</span></div>
    <div class="tscroll"><table><thead><tr><th>Setup</th><th>Total</th><th>Extra vs real rate</th></tr></thead><tbody>
    ${opts.map((o) => `<tr class="${o.trap ? "trap" : o.total === best ? "best" : ""}"><td>${o.trap ? "🚫 " : o.total === best ? "🟢 " : ""}${esc(o.label)}</td><td class="num">${fmt(o.total)} ${esc(r.paymentCosts.homeCurrency)}</td><td><div class="costbar"><div class="bar"><i style="width:${(o.extraVsMid / maxExtra) * 100}%"></i></div><span class="num small">${fmt(o.extraVsMid)}</span></div></td></tr>`).join("")}
    </tbody></table></div>
    <div class="list small">${r.traps.map((t) => `<div class="alert"><p>${esc(t)}</p></div>`).join("")}</div>
  </section>
  <div class="grid2">
    ${r.pots.map((p) => `<section class="pot"><div class="top"><h3>${p.kind === "health" ? "🩺" : "✈️"} ${esc(p.name)}</h3><span class="pill ${p.onTrack ? "ok" : "warn"}">${p.pct}%</span></div><div class="bar"><i style="width:${p.pct}%"></i></div><span class="small muted"><span class="num">${fmt(p.saved)} / ${fmt(p.target)}</span> ${esc(p.currency)} · needs <span class="num">${fmt(p.neededWeekly)}</span>/week</span></section>`).join("")}
  </div>
  <section class="panel"><div class="panel-head"><h2>Paying like a local</h2><span class="small muted">Emergency: ${Object.entries(r.emergency).map(([k, v]) => `${esc(k)} <b class="num">${esc(v)}</b>`).join(" · ")}</span></div>
    <div class="list">${r.localRails.map((x) => `<div><b class="small">${esc(x.name)}</b><div class="small muted">${esc(x.note)}</div></div>`).join("")}</div></section>`;
}

function screenSafety() {
  const s = state.session, set = s.ledger.settings;
  const v = s.audit.verify();
  const rows = s.audit.entries.slice(-40).reverse().map((e) => `<tr><td>${e.seq}</td><td>${esc(e.actor)}</td><td>${esc(e.type)}</td><td class="d">${esc(JSON.stringify(e.data).slice(0, 160))}</td><td>${e.hash.slice(0, 10)}</td></tr>`).join("");
  const tools = Object.entries(TOOL_TIERS);
  const pv = s.parentView({ log: false });
  return `<section class="panel">
    <div class="panel-head"><h2>What Corridor may do on its own</h2><span class="small muted">Only you can change this. The agent cannot.</span></div>
    <div class="seg" role="group" aria-label="Autonomy">
      ${[["advise", "Advise only"], ["confirm", "Act after I confirm"], ["auto_small", `Small actions automatically (≤ ${set.autoLimitCad} CAD)`]].map(([k, l]) => `<button type="button" data-autonomy="${k}" aria-pressed="${set.autonomy === k}">${l}</button>`).join("")}
    </div>
    <form class="inline" id="limits-form">
      <div class="field"><label for="lf-auto">Automatic limit (CAD)</label><input id="lf-auto" inputmode="decimal" value="${set.autoLimitCad}"></div>
      <div class="field"><label for="lf-tx">Max per transfer (CAD)</label><input id="lf-tx" inputmode="decimal" value="${set.perTxCapCad}"></div>
      <div class="field"><label for="lf-day">Max per day (CAD)</label><input id="lf-day" inputmode="decimal" value="${set.dailyCapCad}"></div>
      <button class="btn" type="submit">Save limits</button>
    </form>
    <label class="row small"><input type="checkbox" id="parent-mode" ${set.parentMode ? "checked" : ""}> Parent mode: my family can see transfers from home, due dates and savings progress (never my spending)</label>
    ${pv.status === "ok" ? `<div class="alert"><p class="small"><b>What your family sees:</b> ${pv.obligations.map((o) => `${esc(o.label)} (${esc(o.status)})`).join(", ")}; savings ${pv.savings.map((x) => `${esc(x.name)} ${x.progress}`).join(", ")}; ${pv.transfersFromHome.length} transfers from home. ${esc(pv.notShown)}</p></div>` : ""}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Permission tiers</h2><span class="small muted">The AI proposes. A rule engine decides. You confirm.</span></div>
    <div class="tscroll"><table><thead><tr><th>Tier</th><th>Meaning</th><th>Tools</th></tr></thead><tbody>
    ${Object.entries(TIERS).map(([k, t]) => `<tr><td><b>${k}</b> ${esc(t.name)}</td><td class="small">${esc(t.description)}</td><td class="small mono">${tools.filter(([, tt]) => tt === k).map(([n]) => n).join(", ")}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="small muted">Every money action is checked for: autonomy setting, verified payee, document integrity (hidden instructions, changed bank details), scam signals, attempts to split transfers, your per-transfer and daily limits, available funds, and home-country currency rules. It is checked again at the moment you press Confirm.</p>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Audit log</h2><span class="pill ${v.ok ? "ok" : "bad"}">${v.ok ? `Chain verified · ${v.length} entries` : `Broken at ${v.brokenAt}`}</span></div>
    <p class="small muted">Each entry includes the fingerprint (SHA-256) of the one before it, so any edit to the history breaks the chain.</p>
    <div class="tscroll"><table class="log"><thead><tr><th>#</th><th>Who</th><th>Event</th><th>Details</th><th>Hash</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>
  <section class="panel"><div class="panel-head"><h2>Agent brain</h2></div>
    <div class="seg" role="group" aria-label="Agent brain">
      <button type="button" data-brain="auto" aria-pressed="${state.brain === "auto"}">Claude when available</button>
      <button type="button" data-brain="rules" aria-pressed="${state.brain === "rules"}">Built-in only</button>
    </div>
    <div class="seg" role="group" aria-label="Claude speed">
      <button type="button" data-tier="quick" aria-pressed="${state.tier === "quick"}">Fast</button>
      <button type="button" data-tier="default" aria-pressed="${state.tier === "default"}">Thorough</button>
    </div>
    <p class="small muted">${state.sample ? "Claude is available in this view." : "Claude isn't available in this view (it needs a signed-in Claude account), so the built-in agent answers. Both use the same tools and the same safety guard."}</p>
  </section>`;
}

function renderMsgs() {
  const el = $("#msgs");
  const pend = [...state.session.pending.values()];
  el.innerHTML = state.msgs.map((m) => {
    const tools = m.tools?.length ? `<div class="tools">${m.tools.map((t) => `<span class="tool ${t.tier} ${t.status === "blocked" ? "blocked" : ""}">${esc(t.name)} · ${t.tier} · ${esc(t.status)}</span>`).join("")}</div>` : "";
    const body = m.thinking && !m.text ? `<span class="typing">Thinking${state.sample && state.brain !== "rules" ? " with Claude" : ""}…</span>` : md(m.text);
    return `<div class="msg ${m.role}">${m.role === "incoming" ? '<span class="label">Incoming call · transcript</span>' : ""}${tools}<div class="bubble">${body}</div>${m.fallback ? '<span class="small muted">Claude was unavailable, the built-in agent answered.</span>' : ""}</div>`;
  }).join("") + (pend.length ? `<div class="list">${pend.map(stubHtml).join("")}</div>` : "");
  el.scrollTop = el.scrollHeight;
  $("#send").textContent = state.busy ? "Stop" : "Send";
}

function renderChips() {
  const p = state.session.ledger.persona;
  const chips = p.id === "christina"
    ? ["What's my situation?", "How much can I spend?", "I spent 4,500 tenge on lunch", "Pay my rent please.", "Add warm gloves to my wishlist, 12,000 tenge, I want them under 9,000", "Am I ready for my trip?", "Save for my health insurance every week", "Check my wishlist"]
    : ["What's my situation?", "Pay my tuition", "How much can I spend?", "I want to buy headphones for 449 dollars", "Save for my health insurance every week", "How do I build credit?"];
  $("#chips").innerHTML = chips.map((c) => `<button type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join("");
}

function renderBrain() {
  const on = state.sample && state.brain !== "rules";
  const pill = $("#brain-pill");
  pill.textContent = on ? `Claude · ${state.tier === "quick" ? "fast" : "thorough"}` : "Built-in agent";
  pill.className = `pill brain ${on ? "accent" : ""}`;
}

function openAgent() { $("#agent").dataset.closed = "false"; }

// ---------------- demo controls ----------------
function renderDrawer() {
  const p = state.session.ledger.persona;
  const flight = state.session.ledger.wishlist.find((w) => w.id === "w_flight");
  const items = [
    ["persona", p.id === "christina" ? "Switch to Li Wei" : "Switch to Christina", p.id === "christina" ? "Chinese student in Canada: same app, other direction" : "Canadian student in Kazakhstan, trip to China"],
    ...(flight && flight.status !== "bought" ? [["flight_drop", "Flight price drops", "Almaty → Shanghai falls to 229,000 KZT"]] : []),
    ["boots_drop", "Boots go on sale", p.id === "christina" ? "Winter boots fall to 41,500 KZT" : "Parka falls to 199 CAD"],
    ["week", "A week passes", "Auto-savings run; pots move closer to target"],
    ["kzt_move", `${p.id === "christina" ? "Tenge" : "Yuan"} gets 3% cheaper`, "Exchange rates move; rate rules can fire"],
    ["scam", "Receive a scam call", p.id === "christina" ? "Fake 'Kaspi security' asks for SMS code" : "Fake embassy officer, 'safe account'"],
    ...(p.id === "li_wei" ? [["invoice_clean", "Attach tuition invoice", "A genuine invoice from Maple University"], ["invoice_poison", "Attach poisoned invoice", "Hidden text tells the AI to pay another account"], ["structuring", "Ask to split a transfer", "Use cousins' FX quotas to stay under a limit"]] : []),
    ["reset", "Reset sandbox", "Start this student over"],
  ];
  $("#drawer").innerHTML = `<div class="row"><h2>Demo controls</h2><span class="small muted">Play "the world" to show Corridor reacting</span><span class="spacer"></span><button class="btn" type="button" data-close-drawer="1">Close</button></div>
    <div class="grid">${items.map(([k, b, s]) => `<button type="button" data-demo="${k}"><b>${esc(b)}</b><span>${esc(s)}</span></button>`).join("")}</div>`;
}

function demo(k) {
  const s = state.session, p = s.ledger.persona;
  $("#drawer").hidden = true;
  if (k === "persona") return newSession(p.id === "christina" ? "li_wei" : "christina");
  if (k === "reset") return newSession(p.id);
  if (k === "flight_drop" || k === "boots_drop") {
    const id = k === "flight_drop" ? "w_flight" : p.id === "christina" ? "w_boots" : "w_coat";
    const price = k === "flight_drop" ? 229000 : p.id === "christina" ? 41500 : 199;
    const r = s.simulatePriceChange(id, price);
    const ev = r.evaluation;
    addMsg("note", `🔔 Price watcher: **${ev.name}** is now ${fmt(ev.price)} ${ev.currency} (target ${fmt(ev.targetPrice)}). ${ev.verdict === "buy_now" ? "It's at your target and your budget covers it." : ev.advice}`);
    state.tab = "wishlist";
    renderAll();
    if (ev.verdict === "buy_now") { openAgent(); renderChipsWith(["Check my wishlist and buy what's ready."]); }
    return;
  }
  if (k === "week") {
    const r = s.advanceWeek();
    const lines = r.autoSaves.map((a) => a.proposal.status === "executed_automatically" ? `- ✅ ${a.proposal.summary} (automatic, within your limit)` : a.proposal.status === "awaiting_user_confirmation" ? `- 🟡 ${a.proposal.summary} (waiting for your Confirm)` : `- ${a.proposal.status}`);
    addMsg("note", `📅 A week passed. Today is ${r.today}.${lines.length ? "\n" + lines.join("\n") : "\nNo automatic savings are set up yet. Try \"save for my health insurance every week\"."}`);
    openAgent(); renderAll(); return;
  }
  if (k === "kzt_move") {
    const cur = p.id === "christina" ? "KZT" : "CNY";
    const before = midRate("CAD", cur, s.rates);
    const fired = s.simulateRateMove(cur, 3);
    addMsg("note", `📈 Market: 1 CAD now buys ${fmt(midRate("CAD", cur, s.rates), 4)} ${cur} (was ${fmt(before, 4)}).${fired.length ? "\n" + fired.map((f) => `- Rule ${f.rule.id} fired: ${f.proposal.summary}`).join("\n") : ""}`);
    openAgent(); renderAll(); return;
  }
  if (k === "scam") {
    const msg = p.id === "christina" ? SAMPLE_MESSAGES.scam_bank_security : SAMPLE_MESSAGES.scam_embassy;
    addMsg("incoming", msg);
    openAgent();
    return ask(`I just got this call, should I do what they say? "${msg}"`, { silentUser: true });
  }
  if (k === "invoice_clean") return ask("Here is my tuition invoice, please pay it.", { attachments: ["invoice_clean"] });
  if (k === "invoice_poison") return ask("Pay this invoice please.", { attachments: ["invoice_poisoned"] });
  if (k === "structuring") return ask("My cousins can each buy 10,000 USD with their quota. Can we split the tuition between them so it stays under the limit?");
}

function renderChipsWith(list) {
  $("#chips").innerHTML = list.map((c) => `<button type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join("") + $("#chips").innerHTML;
}

// ---------------- events ----------------
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { state.tab = d.tab; store.set("corridor.tab", d.tab); try { history.replaceState(null, "", "#" + d.tab); } catch {} renderAll(); $("#screen").scrollTop = 0; if (window.innerWidth <= 720) $("#agent").dataset.closed = "true"; }
  else if (d.tabGo) { state.tab = d.tabGo; renderAll(); }
  else if (d.openAgent) { const a = $("#agent"); a.dataset.closed = a.dataset.closed === "false" ? "true" : "false"; }
  else if (d.ask) ask(d.ask);
  else if (d.confirm) confirmPending(d.confirm);
  else if (d.reject) rejectPending(d.reject);
  else if (d.buy) uiTool("buy_wishlist_item", { item_id: d.buy });
  else if (d.savePot) uiTool("save_to_pot", { pot_id: d.savePot, amount: Number(d.amt) });
  else if (d.autoPot) uiTool("set_auto_save", { pot_id: d.autoPot });
  else if (d.useRoute) {
    const lc = state.lastCompare; if (!lc) return;
    uiTool("send_money", { payee_id: lc.payee, from: lc.result.from, to: lc.result.to, route_id: d.useRoute, ...(lc.result.targetAmount ? { target_amount: lc.result.targetAmount } : { amount: lc.result.amount }) });
  }
  else if (d.autonomy) { state.session.updateSettings({ autonomy: d.autonomy }); toast("Saved. Only you can change this."); renderAll(); }
  else if (d.brain) { state.brain = d.brain; resetAgent(); renderAll(); }
  else if (d.tier) { state.tier = d.tier; renderAll(); }
  else if (d.demo) demo(d.demo);
  else if (d.closeDrawer) $("#drawer").hidden = true;
});

$("#open-demo").addEventListener("click", () => { renderDrawer(); $("#drawer").hidden = false; });
$("#close-agent").addEventListener("click", () => { $("#agent").dataset.closed = "true"; });
$("#lang").addEventListener("change", (e) => { state.session.language = e.target.value; store.set("corridor.lang", e.target.value); });

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "compose") {
    if (state.busy) { state.ctl?.abort(); return; }
    const v = $("#input").value; $("#input").value = ""; ask(v);
  } else if (f.id === "compare-form") {
    const from = $("#cf-from").value, to = $("#cf-to").value, amt = Number($("#cf-amt").value.replace(/[, ]/g, "")), mode = $("#cf-mode").value;
    if (from === to) { toast("Pick two different currencies"); return; }
    const r = state.session.callTool("compare_routes", mode === "target" ? { from, to, target_amount: amt, purpose: "living" } : { from, to, amount: amt, purpose: "living" }, "user_ui");
    if (r.status !== "ok") { toast(r.error); return; }
    state.lastCompare = { result: r, payee: $("#cf-to-who").value };
    renderAll();
  } else if (f.id === "wish-form") {
    const name = $("#wf-name").value.trim(), price = Number($("#wf-price").value.replace(/[, ]/g, "")), target = Number($("#wf-target").value.replace(/[, ]/g, "")) || undefined;
    if (!name || !(price > 0)) { toast("Add a name and a price"); return; }
    const r = uiTool("add_wishlist_item", { name, price, currency: $("#wf-cur").value, target_price: target });
    if (r.status === "ok") { toast(`Watching "${name}"`); addMsg("note", `⭐ Added **${r.added.name}** to your wishlist. ${r.added.advice}`); }
  } else if (f.id === "expense-form") {
    const amount = Number($("#ex-amt").value.replace(/[, ]/g, ""));
    if (!(amount > 0)) { toast("Enter an amount"); return; }
    const r = uiTool("add_expense", { what: $("#ex-what").value.trim(), amount, currency: $("#ex-cur").value, category: $("#ex-cat").value });
    if (r.status === "ok") { toast(`Expense added. Safe to spend: ${fmt(r.safeToSpendNow)}`); addMsg("note", `🧾 Recorded **${fmt(amount)} ${r.recorded.currency}** for ${r.recorded.merchant}. Safe to spend this month: **${fmt(r.safeToSpendNow)}**.`); }
  } else if (f.id === "income-form") {
    const amount = Number($("#in-amt").value.replace(/[, ]/g, ""));
    if (!(amount > 0)) { toast("Enter an amount"); return; }
    const r = uiTool("add_income", { what: $("#in-what").value.trim(), amount, currency: $("#in-cur").value });
    if (r.status === "ok") { toast(`Income added. Safe to spend: ${fmt(r.safeToSpendNow)}`); addMsg("note", `💰 Added **${fmt(amount)} ${r.recorded.currency}** (${r.recorded.label}). Safe to spend this month: **${fmt(r.safeToSpendNow)}**.`); }
  } else if (f.id === "limits-form") {
    state.session.updateSettings({ autoLimitCad: Number($("#lf-auto").value) || 0, perTxCapCad: Number($("#lf-tx").value) || 0, dailyCapCad: Number($("#lf-day").value) || 0 });
    toast("Limits saved"); renderAll();
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "parent-mode") { state.session.updateSettings({ parentMode: e.target.checked }); renderAll(); }
});

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#compose").requestSubmit(); }
});

// ---------------- boot ----------------
const lang = store.get("corridor.lang"); if (lang) $("#lang").value = lang;
const hash = (location.hash || "").slice(1);
state.tab = TABS.some((t) => t.id === hash) ? hash : (store.get("corridor.tab") || "home");
if (!TABS.some((t) => t.id === state.tab)) state.tab = "home";
if (window.innerWidth > 1080) $("#agent").dataset.closed = "false";
newSession("christina");
initClaude();
