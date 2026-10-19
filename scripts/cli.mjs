// Talk to the Corridor agent in a terminal.
//   npm run cli                      -> built-in rule agent, no key needed
//   LLM_API_KEY=... LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini npm run cli
// Any OpenAI-compatible endpoint works (OpenAI, DeepSeek, Qwen/DashScope compatible mode, local servers).
// Commands: /confirm  /reject  /week  /persona li_wei  /log  /quit
import readline from "node:readline/promises";
import { stdin, stdout, env } from "node:process";
import { Session } from "../src/session.js";
import { Agent } from "../src/agent.js";

function openAiCompatible({ apiKey, baseUrl, model }) {
  return async ({ instructions, history, message, tools }) => {
    const messages = [{ role: "system", content: instructions }, ...history, { role: "user", content: message }];
    const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    for (let round = 0; round < 6; round++) {
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools: toolDefs }),
      });
      if (!r.ok) throw Object.assign(new Error(`LLM HTTP ${r.status}`), { code: "upstream_error" });
      const data = await r.json();
      const msg = data.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls?.length) return msg.content || "";
      for (const tc of msg.tool_calls) {
        const tool = tools.find((t) => t.name === tc.function.name);
        let out;
        try { out = tool ? tool.execute(JSON.parse(tc.function.arguments || "{}")) : { error: "unknown tool" }; } catch (e) { out = { error: e.message }; }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 30000) });
      }
    }
    return "I stopped after several tool rounds. Please ask again more specifically.";
  };
}

let session = new Session({ persona: env.PERSONA || "christina" });
const llm = env.LLM_API_KEY ? openAiCompatible({ apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1", model: env.LLM_MODEL || "gpt-4o-mini" }) : null;
let agent = new Agent(session, { llm });
const rl = readline.createInterface({ input: stdin, output: stdout });
console.log(`Corridor CLI · ${session.ledger.persona.name} · brain: ${llm ? "LLM" : "built-in rules"} · /quit to exit`);
for (;;) {
  const line = (await rl.question("\nyou> ")).trim();
  if (!line) continue;
  if (line === "/quit") break;
  if (line === "/confirm" || line === "/reject") {
    const p = [...session.pending.values()].pop();
    if (!p) { console.log("Nothing pending."); continue; }
    console.log(JSON.stringify(line === "/confirm" ? session.confirm(p.id, { documentsAttested: true }) : session.reject(p.id), null, 2));
    continue;
  }
  if (line === "/week") { console.log(JSON.stringify(session.advanceWeek(), null, 2)); continue; }
  if (line.startsWith("/persona")) { session = new Session({ persona: line.split(" ")[1] || "christina" }); agent = new Agent(session, { llm }); console.log(`Now ${session.ledger.persona.name}`); continue; }
  if (line === "/log") { console.log(session.audit.toJSONL()); console.log(session.audit.verify()); continue; }
  const r = await agent.handle(line);
  for (const e of r.events.filter((x) => x.type === "tool")) console.log(`  [${e.tier}] ${e.name} → ${e.result.status}`);
  console.log(`\ncorridor> ${r.reply}`);
  if (session.pending.size) console.log("\n(type /confirm or /reject)");
}
rl.close();
