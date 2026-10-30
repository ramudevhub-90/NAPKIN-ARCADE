// Nebius Token Factory client (OpenAI-compatible) with a spending ledger, hard
// caps and a response cache. Every model call in CrashLab goes through here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./env.js";

const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data");
const LEDGER = path.join(DATA, "usage.jsonl");
const CACHE = path.join(DATA, "cache");
fs.mkdirSync(CACHE, { recursive: true });

// USD per 1M tokens [input, output], from the Token Factory model catalog.
const PRICES = [
  [/ultra/i, [1.0, 3.0]],
  [/super/i, [0.3, 0.9]],
  [/nano|lightning/i, [0.06, 0.24]],
];
const priceFor = (model) => (PRICES.find(([re]) => re.test(model)) || [null, [1.0, 3.0]])[1];
const costOf = (model, inTok, outTok) => {
  const [pi, po] = priceFor(model);
  return (inTok * pi + outTok * po) / 1e6;
};

let totalSpent = 0;
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    try { totalSpent += JSON.parse(line).cost || 0; } catch {}
  }
}
const listeners = new Set();
export const onSpend = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const spending = () => ({ totalUsd: totalSpent, hardCapUsd: config.hardCapUsd });

export class BudgetError extends Error {}

// Resolve friendly names ("Nemotron-3-Ultra") to the exact model ids the API lists.
let modelIds = null;
export async function resolveModels() {
  if (!config.nebiusKey) return null;
  if (!modelIds) {
    const r = await fetch(`${config.nebiusBase}/models`, { headers: { Authorization: `Bearer ${config.nebiusKey}` } });
    if (!r.ok) throw new Error(`Token Factory /models failed: ${r.status} ${await r.text()}`);
    modelIds = (await r.json()).data.map((m) => m.id);
  }
  const pick = (want) => {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    return modelIds.find((id) => id === want) || modelIds.find((id) => norm(id).includes(norm(want))) || want;
  };
  for (const role of Object.keys(config.models)) config.models[role] = pick(config.models[role]);
  return { ...config.models };
}

const stripThinking = (s) => {
  const m = s.match(/<think>([\s\S]*?)<\/think>/);
  return { text: s.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), thinking: m ? m[1].trim() : "" };
};

export function parseJson(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

// One chat completion. `budget` is the per-campaign tracker ({ spent, cap }).
export async function chat({ role, messages, maxTokens = 2000, temperature = 0.6, budget, purpose, extra = {} }) {
  const model = config.models[role];
  // Images count as ~1.5k tokens each; don't let base64 data inflate the estimate.
  const images = (JSON.stringify(messages).match(/data:image\//g) || []).length;
  const estIn = Math.ceil(JSON.stringify(messages).replace(/data:image\/[^"]+/g, "").length / 3.5) + images * 1500;
  const worst = costOf(model, estIn, maxTokens);
  if (totalSpent + worst > config.hardCapUsd) throw new BudgetError(`Hard cap $${config.hardCapUsd} would be exceeded`);
  if (budget && budget.spent + worst > budget.cap) throw new BudgetError(`Campaign cap $${budget.cap} would be exceeded`);

  const body = { model, messages, max_tokens: maxTokens, temperature, ...extra };
  const key = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  const cacheFile = path.join(CACHE, key + ".json");
  if (config.useCache && fs.existsSync(cacheFile)) {
    return { ...JSON.parse(fs.readFileSync(cacheFile, "utf8")), cached: true, cost: 0, model };
  }

  const t0 = Date.now();
  const r = await fetch(`${config.nebiusBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.nebiusKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Token Factory ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  const { text, thinking } = stripThinking(msg.content || "");
  const usage = j.usage || {};
  const cost = costOf(model, usage.prompt_tokens || estIn, usage.completion_tokens || maxTokens);

  totalSpent += cost;
  if (budget) budget.spent += cost;
  fs.appendFileSync(LEDGER, JSON.stringify({
    ts: new Date().toISOString(), model, purpose, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    cost: +cost.toFixed(6), ms: Date.now() - t0,
  }) + "\n");
  for (const fn of listeners) fn(spending());

  const out = { text, thinking: thinking || msg.reasoning_content || "", usage };
  if (config.useCache) fs.writeFileSync(cacheFile, JSON.stringify(out));
  return { ...out, cached: false, cost, model };
}
