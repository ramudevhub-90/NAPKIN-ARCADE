// Minimal .env loader (no dependency). Real environment variables win.
import fs from "node:fs";
import path from "node:path";

const file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const config = {
  port: +(process.env.PORT || 8787),
  nebiusKey: process.env.NEBIUS_API_KEY || "",
  nebiusBase: (process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1").replace(/\/$/, ""),
  tavilyKey: process.env.TAVILY_API_KEY || "",
  models: {
    vision: process.env.MODEL_VISION || "Nemotron-3.5-Super-VL",
    designer: process.env.MODEL_DESIGNER || "Nemotron-3-Ultra",
    developer: process.env.MODEL_DEVELOPER || "Nemotron-3-Super",
    fast: process.env.MODEL_FAST || "Nemotron-3-Nano",
  },
  // Spending guardrails (USD). The app refuses model calls past these limits.
  hardCapUsd: +(process.env.HARD_CAP_USD || 20),
  campaignCapUsd: +(process.env.CAMPAIGN_CAP_USD || 1),
  concurrency: +(process.env.CONCURRENCY || 5),
  liveRunsPerHour: +(process.env.LIVE_RUNS_PER_HOUR || 10),
  useCache: process.env.LLM_CACHE !== "off",
};
