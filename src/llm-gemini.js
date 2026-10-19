// Free option: Google Gemini (AI Studio free tier) as Corridor's planner.
// Uses Gemini function calling for Corridor's tools, plus a `research_web` tool
// that runs a separate Google-Search-grounded Gemini request and returns
// the answer with its sources. Runs in the browser with the user's own key.

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Pick the newest general-purpose Flash model the key can use. */
export async function pickGeminiModel(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { code: res.status === 400 || res.status === 403 ? "bad_key" : "upstream_error" });
  const usable = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /gemini/.test(n) && !/(image|tts|audio|live|embedding|vision|thinking-exp|robotics)/.test(n));
  const score = (n) => {
    const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    return v * 10 + (/flash/.test(n) ? 3 : 0) - (/lite/.test(n) ? 1 : 0) - (/preview|exp/.test(n) ? 0.5 : 0) - (/pro/.test(n) ? 5 : 0);
  };
  usable.sort((a, b) => score(b) - score(a));
  if (!usable.length) throw new Error("No Gemini model available for this key");
  return usable[0];
}

function cleanSchema(schema) {
  if (!schema || !schema.properties || !Object.keys(schema.properties).length) return undefined;
  const out = { type: "object", properties: {} };
  for (const [k, v] of Object.entries(schema.properties)) {
    out.properties[k] = { type: v.type || "string", ...(v.description ? { description: v.description } : {}), ...(v.enum ? { enum: v.enum } : {}) };
  }
  if (schema.required?.length) out.required = schema.required;
  return out;
}

export function geminiAgent({ apiKey, model, webSearch = true, maxRounds = 8, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let modelId = model || null;

  async function generate(body, signal) {
    if (!modelId) modelId = await pickGeminiModel(apiKey, doFetch);
    const res = await doFetch(`${BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { code: res.status === 429 ? "rate_limited" : /API key/i.test(msg) ? "bad_key" : "upstream_error" });
    }
    return data;
  }

  /** One grounded research call: Gemini + Google Search, returns answer and sources. */
  async function research(query, signal) {
    const data = await generate({ contents: [{ role: "user", parts: [{ text: `Research this for an international student and answer factually and concisely, with numbers and dates where relevant:\n\n${query}` }] }], tools: [{ google_search: {} }] }, signal);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri })).slice(0, 6);
    return { answer: text, sources };
  }

  const run = async function ({ instructions, history = [], message, tools, onText, signal, onEvent }) {
    const allTools = [...tools];
    if (webSearch) {
      allTools.push({
        name: "research_web",
        description: "Search the web (Google) for current information: fees, exchange rates, rules, prices, procedures, news. Returns an answer with sources. Use it whenever facts may have changed or you are unsure.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "What to research" } }, required: ["query"] },
        execute: async (args) => research(String(args.query || message), signal),
      });
    }
    const decls = allTools.map((t) => ({ name: t.name, description: t.description, ...(cleanSchema(t.inputSchema) ? { parameters: cleanSchema(t.inputSchema) } : {}) }));
    const contents = [
      ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] })),
      { role: "user", parts: [{ text: message }] },
    ];
    const sources = new Map();
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      const data = await generate({ systemInstruction: { parts: [{ text: instructions }] }, contents, tools: [{ functionDeclarations: decls }] }, signal);
      const parts = data.candidates?.[0]?.content?.parts || [];
      contents.push({ role: "model", parts });
      const text = parts.map((p) => p.text || "").join("");
      if (text) { finalText = text; onText?.({ text, delta: text }); }
      const callsHere = parts.filter((p) => p.functionCall);
      if (!callsHere.length) break;

      const responses = [];
      for (const p of callsHere) {
        const { name, args } = p.functionCall;
        const tool = allTools.find((t) => t.name === name);
        let out;
        try { out = tool ? await tool.execute(args || {}) : { error: `Unknown tool ${name}` }; }
        catch (e) { out = { error: e.message }; }
        if (name === "research_web") {
          onEvent?.({ type: "tool", name: "research_web", tier: "T0", args, result: { status: "ok" } });
          for (const s of out.sources || []) sources.set(s.url, s.title);
        }
        responses.push({ functionResponse: { name, response: { result: JSON.parse(JSON.stringify(out ?? null)) } } });
      }
      contents.push({ role: "user", parts: responses });
    }

    if (sources.size) finalText += `\n\nSources:\n${[...sources].slice(0, 6).map(([url, title]) => `- ${title || "Source"}: ${url}`).join("\n")}`;
    return finalText || "I couldn't produce an answer. Please try rephrasing.";
  };
  run.modelName = () => modelId;
  return run;
}
