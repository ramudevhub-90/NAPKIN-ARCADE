// Global leaderboards: top scores per game, stored on disk.
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "scores.json");
const boards = (() => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } })();
const recent = new Map(); // ip -> timestamps (anti-spam)

export function topScores(game, n = 10) {
  return (boards[game] || []).slice(0, n);
}

export function submitScore(game, { name, score, progress, won, time }, ip) {
  const now = Date.now(), hits = (recent.get(ip) || []).filter((t) => now - t < 60e3);
  if (hits.length >= 12) throw Object.assign(new Error("Too many scores — slow down."), { status: 429 });
  recent.set(ip, [...hits, now]);
  const entry = {
    name: String(name || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player",
    score: Math.max(0, Math.min(1e7, Math.round(+score || 0))), progress: Math.max(0, Math.min(1, +progress || 0)),
    won: won ? 1 : 0, time: Math.max(0, Math.min(3600, +time || 0)), at: new Date().toISOString(),
  };
  const list = [...(boards[game] || []), entry].sort((a, b) => b.score - a.score || b.won - a.won || a.time - b.time).slice(0, 100);
  boards[game] = list;
  fs.writeFileSync(FILE, JSON.stringify(boards));
  return { rank: list.indexOf(entry) + 1 || null, top: list.slice(0, 10) };
}
