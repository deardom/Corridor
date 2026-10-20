# Corridor

**An AI money agent for students who live, study and travel across borders.**
Fintechathon 2026, International Track, Topic C (Cross-border & Student Finance).

Christina is a Canadian student on exchange in Almaty who is planning a trip to Shanghai. In one semester she deals with three currencies, a local payment system she has to join (Kaspi), hidden card fees, a tight budget, a flight she wants at the right price, health insurance for the trip, and scam calls aimed at foreigners. Corridor is the agent that handles this for her. Her story is one route: the same engine serves any student going from any country to any other, because everything country specific lives in a plug-in **country pack**.

* **Live demo (GitHub Pages):** https://deardom.github.io/Corridor/ (runs in any browser with the built-in agent)
* **Live demo with Claude as the agent:** https://claude.ai/artifact/UQ9WLHNqQVNZCTLw5s39u4 (the AI conversation uses Claude when the viewer is signed in; otherwise the built-in agent answers with the same tools and safety rules)
* **Everything is a sandbox.** No real bank, card or account is connected. Exchange rates are an illustrative snapshot.

## What the agent does

| | Feature | What the agent actually does |
|---|---|---|
| 1 | Multi-currency wallet | Tracks CAD, KZT, CNY balances, spots that November rent in tenge is short, proposes the cheapest top-up |
| 2 | True-cost transfers | Compares named providers (RBC, TD, CIBC, BMO, Scotiabank wires, Wise, Paysend, Western Union, Kaspi) against the real mid-market rate, using each provider's published or reported fee and exchange-rate markup, and flags traps such as "pay in CAD" at terminals |
| 3 | Budget | Add expenses and income (by form or by chat, in any currency); everything is converted into one number: safe to spend for the rest of the month |
| 4 | Wishlist with price watching | Watches prices and proposes buying only when the item is at the target price **and** the budget (or its savings pot) covers it. Redirects impulse purchases to the wishlist |
| 5 | Savings pots, including health insurance | Saves weekly toward health and travel insurance and the trip, automatically within a limit the student sets |
| 6 | Trip readiness | Loads the destination's country pack: payment apps, card fees (e.g. Alipay foreign card fee), entry and insurance checklist, emergency numbers |
| 7 | Scam shield | Detects fake police, embassy and "bank security" calls, SMS-code requests, "safe accounts" and virtual kidnapping, in English, Chinese and Russian, and blocks the transfer |
| 8 | Tuition (reverse direction) | For a Chinese student in Canada: reads the invoice, checks it against the school's verified account, handles the China FX quota with documents, refuses to split transfers |

## Connect a real AI model (any question, with web research)

Out of the box the app uses a built-in offline agent for its own tasks. To let Corridor answer any question and research current information on the web:

1. Open the app, go to **Safety → Agent brain**.
2. Choose a provider and paste its key:
   * **Google Gemini (free):** get a key at aistudio.google.com with a Google account, no credit card. Corridor picks the newest Flash model and researches with Google Search. Free-tier limits apply, and Google may use free-tier prompts to improve its products.
   * **Anthropic Claude (paid):** key from console.anthropic.com; pick a model (Claude Sonnet 5.5 recommended).
3. Keep **Web research** on and ask anything in the chat. The agent plans with the model, searches the web when facts may have changed (and cites its sources), and uses Corridor's 20 money tools. Every action still passes the safety guard and needs your Confirm.

The key stays in your browser and is sent only to the provider you chose. In the Claude-hosted demo, signed-in viewers get Claude without a key (without web research). From the terminal, `npm run cli` accepts any OpenAI-compatible model (DeepSeek, Qwen).

## How it works: four roles

1. **Planner**: a language model (Google Gemini on its free tier with Google Search research, Claude through the Anthropic API with web search, or any OpenAI-compatible model such as DeepSeek or Qwen) understands the request, researches when needed and chains 20 tools.
2. **Watchers**: a price watcher, an exchange-rate watcher, a weekly savings scheduler and a bill monitor react to events and propose actions on their own.
3. **Specialists**: a scam shield, a document inspector and a compliance checker report risks.
4. **Guard**: a deterministic rule engine decides; the model cannot override it.

## Safety design in one paragraph

The language model **proposes**; a deterministic policy engine **decides**; the student **confirms**. Tools are split into four permission tiers (read, plan, act, forbidden). Every money action passes nine checks (autonomy setting, verified payee, document integrity, scam signals, structuring, per-transfer and daily limits, funds, home-country FX rules, budget warning) and is checked again at the moment the student presses Confirm. Instructions hidden inside documents are never followed. Every step is written to a SHA-256 hash-chained audit log.

## Run it

Requirements: Node.js 18 or newer. No dependencies to install.

```bash
npm test            # 39 automated tests
npm run evidence    # regenerates evidence/ (sandbox logs for every demo scenario)
npm start           # web app at http://localhost:8080
npm run cli         # chat with the agent in a terminal (built-in agent)
```

Use any OpenAI-compatible model in the terminal (OpenAI, DeepSeek, Qwen compatible mode, a local server):

```bash
LLM_API_KEY=sk-... LLM_BASE_URL=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat npm run cli
```

### Deployment

The web app is static files (`index.html`, `app.js`, `src/`). Any static host works (GitHub Pages, Netlify, an S3 bucket): upload the folder as is. The hosted demo above runs on Claude artifacts, which also provides the Claude model to signed-in viewers without an API key.

## Repository map

```
index.html, app.js      web app (screens, chat, confirmation cards, demo controls)
src/session.js          sandbox session: tools, pending confirmations, simulated world
src/policy.js           the guard: permission tiers and the nine checks
src/agent.js            agent: tool specs, LLM instructions, deterministic rule brain
src/llm-gemini.js       Gemini adapter (free tier): function calling + Google Search research
src/llm-anthropic.js    Claude adapter: tool use + web search
src/fx.js               route quotes against mid-market, target-amount solver
src/budget.js           safe-to-spend, savings pots, wishlist verdicts
src/trip.js             trip readiness and cost of each way to pay
src/scam.js             multilingual scam shield
src/documents.js        untrusted document intake, prompt-injection and invoice-fraud detection
src/compliance.js       structuring detection, China FX quota, large-transfer notice
src/audit.js            hash-chained audit log
src/packs/              country packs: ca.js, kz.js, cn.js (add a country = add a file)
test/core.test.js       automated tests
scripts/                evidence generator, local server, terminal chat
evidence/               sandbox operation logs (JSONL), transcripts, summary
```

## Test cases

`npm test` runs 39 tests, including: FX maths and fee rules (Kaspi minimum fee, Alipay fee above ¥200), traps never ranked first, country pack shape, scam detection in three languages, poisoned invoice detection, structuring detection in three languages, China FX quota rules, tier T3 always denied, no money movement without confirmation, unverified payees and caps blocked, advise-only mode, the agent cannot change its own settings, automatic mode limited to small actions on the student's own money, re-check at confirmation time, audit tamper detection, masking of account numbers, budget and wishlist logic, and every demo scenario end to end.

## Data sources and limits

Provider fees and exchange-rate markups (checked 2026-10-19, full list in `src/data.js`):
- **Canadian banks:** exchange-rate markup RBC 2.60%, TD 2.64%, BMO 2.65%, Scotiabank 2.88%, CIBC 3.34% (Finder Canada); wire fees RBC from C$45 (Wise source check, Sept 2026), CIBC C$30 up to C$10,000 (Airwallex, 2025), TD up to C$30, BMO from C$15, Scotiabank C$9 + 1% (Finder Canada).
- **Wise:** mid-market rate; CAD to CNY payouts to bank, Alipay or Weixin (Wise Canada); fee about 0.8% + US$1.17 (RemitAnalyst estimate). CAD to KZT is not offered yet; Wise sends USD by SWIFT instead (Wise Kazakhstan page).
- **Paysend** CAD to KZT card: C$3 fee, 0.31% below mid-market; **Western Union** cash pickup: no fee, 4.57% below mid-market (Monito, 300 CAD example).
- **Kaspi** international transfer: 0.95%, minimum 200 KZT (Kaspi help pages). **Alipay** foreign cards: 3% above ¥200 (third-party travel guide). Canadian cards' 2.5% foreign transaction fee (NerdWallet, MoneySense).

Mid-market exchange rates are an illustrative snapshot, and a few values are marked as assumptions in the code (school payment platforms, the Kazakh bank's USD conversion, terminal "pay in CAD" markup). Compliance thresholds carry a `verified` flag in `src/data.js`; they must be checked against primary sources before any real-world use. Corridor gives general information, not legal, tax, insurance or investment advice.

## Team

Team Silk & Maple: two Canadian, one Kazakh and two Chinese students. MIT License.
