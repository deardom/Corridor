// Real AI agent: Claude via the Anthropic Messages API, with Corridor's tools
// plus Anthropic's server-side web search for research. Runs in the browser
// (the user's own API key, kept in their browser) or in Node.
//
// Loop: send the conversation + tools -> Claude answers, or asks to run tools ->
// we run Corridor's tools locally (through the safety guard) and send results back
// -> repeat until Claude gives its final answer. Web searches run on Anthropic's side.

const API_URL = "https://api.anthropic.com/v1/messages";
const WEB_SEARCH_TYPES = ["web_search_20260318", "web_search_20250305"];

export function anthropicAgent({ apiKey, model = "claude-sonnet-5-5", webSearch = true, maxRounds = 8, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let searchType = WEB_SEARCH_TYPES[0];

  async function call(body, signal) {
    const res = await doFetch(API_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = res.status === 401 ? "bad_key" : res.status === 429 ? "rate_limited" : res.status === 400 ? "bad_request" : "upstream_error";
      throw err;
    }
    return data;
  }

  return async function run({ instructions, history = [], message, tools, onText, signal, onEvent }) {
    const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    const messages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: message }];
    const sources = new Map();
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      const allTools = webSearch ? [...toolDefs, { type: searchType, name: "web_search", max_uses: 4 }] : toolDefs;
      let data;
      try {
        data = await call({ model, max_tokens: 2048, system: instructions, messages, tools: allTools }, signal);
      } catch (e) {
        // Older accounts or models may not have the newest search tool: fall back once.
        if (e.code === "bad_request" && webSearch && searchType === WEB_SEARCH_TYPES[0] && /web_search|tool/i.test(e.message)) {
          searchType = WEB_SEARCH_TYPES[1];
          round--;
          continue;
        }
        throw e;
      }

      const content = data.content || [];
      messages.push({ role: "assistant", content });
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) { finalText = text; onText?.({ text: finalText, delta: text }); }
      for (const b of content) {
        if (b.type === "server_tool_use" && b.name === "web_search") onEvent?.({ type: "tool", name: "web_search", tier: "T0", args: b.input, result: { status: "ok" } });
        for (const c of b.citations || []) if (c.url) sources.set(c.url, c.title || c.url);
      }

      if (data.stop_reason === "pause_turn") continue; // long server-side search: let Claude continue
      if (data.stop_reason !== "tool_use") break;

      const results = [];
      for (const b of content.filter((x) => x.type === "tool_use")) {
        const tool = tools.find((t) => t.name === b.name);
        let out;
        try { out = tool ? await tool.execute(b.input || {}) : { error: `Unknown tool ${b.name}` }; }
        catch (e) { out = { error: e.message }; }
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 30000) });
      }
      messages.push({ role: "user", content: results });
    }

    if (sources.size) finalText += `\n\nSources:\n${[...sources].slice(0, 6).map(([url, title]) => `- ${title}: ${url}`).join("\n")}`;
    return finalText || "I couldn't produce an answer. Please try rephrasing.";
  };
}
