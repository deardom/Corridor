// Runs a scenario step by step against a Session + Agent. Used by the web demo
// and by the evidence generator, so both show exactly the same behaviour.
import { Session } from "./session.js";
import { Agent } from "./agent.js";
import { SAMPLE_MESSAGES } from "./data.js";

export async function runScenario(scenario, { llm = null, language = "en", onStep = () => {} } = {}) {
  const session = new Session({ persona: scenario.persona, language });
  const agent = new Agent(session, { llm });
  const transcript = [];
  for (const step of scenario.steps) {
    const rec = await runStep(session, agent, step);
    transcript.push(rec);
    onStep(rec);
  }
  return { session, agent, transcript };
}

export async function runStep(session, agent, step) {
  if (step.say || step.message) {
    const text = step.say || `${step.prefix || ""}"${SAMPLE_MESSAGES[step.message]}"`;
    const r = await agent.handle(text, { attachments: step.attachments || [] });
    return { kind: "chat", user: text, attachments: step.attachments || [], reply: r.reply, brain: r.brain, tools: r.events.filter((e) => e.type === "tool").map((e) => ({ name: e.name, tier: e.tier, status: e.result.status })), alerts: r.events.filter((e) => e.type === "alert") };
  }
  if (step.confirm) {
    const p = [...session.pending.values()].pop();
    if (!p) return { kind: "confirm", result: { status: "nothing_pending" } };
    return { kind: "confirm", pendingId: p.id, summary: p.summary, result: session.confirm(p.id, { documentsAttested: !!step.documentsAttested }) };
  }
  if (step.rawTool) {
    return { kind: "direct_tool_call", note: step.note, tool: step.rawTool, args: step.args, result: session.callTool(step.rawTool, step.args, "simulated_compromised_agent") };
  }
  if (step.userSettings) {
    return { kind: "user_settings", note: step.note, result: session.updateSettings(step.userSettings, "user") };
  }
  if (step.market) {
    const fired = session.simulateRateMove(step.market.currency, step.market.pct);
    return { kind: "market_move", note: step.note, fired: fired.map((f) => ({ rule: f.rule.id, proposal: f.proposal.status, summary: f.proposal.summary })) };
  }
  if (step.price) {
    return { kind: "price_change", note: step.note, result: session.simulatePriceChange(step.price.item, step.price.price) };
  }
  if (step.week) {
    return { kind: "week_passes", note: step.note, result: session.advanceWeek() };
  }
  if (step.parentView) {
    return { kind: "parent_view", result: session.parentView() };
  }
  return { kind: "unknown" };
}
