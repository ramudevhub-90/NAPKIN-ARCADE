// One-time migration from the old file storage (data/projects, data/scores.json) to DynamoDB + S3.
// Run on the server: TABLE=… BUCKET=… node aws/migrate.mjs [dataDir]
import fs from "node:fs";
import path from "node:path";
import * as store from "./lib/store.mjs";

const DATA = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
// Optional: ONLY=id1,id2 to migrate some games; OWNER_MAP=old@x.com=new@y.com to reassign owners.
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const OWNER_MAP = Object.fromEntries((process.env.OWNER_MAP || "").split(",").filter(Boolean).map((p) => p.split("=").map((x) => x.trim().toLowerCase())));
let games = 0, scores = 0;
for (const id of fs.existsSync(path.join(DATA, "projects")) ? fs.readdirSync(path.join(DATA, "projects")) : []) {
  const dir = path.join(DATA, "projects", id), meta = read(path.join(dir, "meta.json")), game = read(path.join(dir, "game3d.json"));
  if (!meta || !game || (ONLY.length && !ONLY.includes(id)) || (await store.getGame(id))) continue;
  const email = String(meta.owner || "unknown").toLowerCase();
  const owner = `EMAIL#${OWNER_MAP[email] || email}`;
  await store.putGameMeta({ id, idea: meta.idea || "", hasDrawing: !!meta.hasDrawing, owner, ownerName: meta.ownerName || "Napkin Arcade", status: "ready", createdAt: meta.created || new Date().toISOString(), title: game.title || game.design?.title, tagline: game.pitch || game.design?.tagline || "", preset: game.design?.preset || null, score: game.score ?? null });
  if (fs.existsSync(path.join(dir, "drawing.txt"))) await store.putDrawing(id, fs.readFileSync(path.join(dir, "drawing.txt"), "utf8"));
  await store.saveVersion(id, game, "First version, built by the studio", game.score ?? null, { publish: true });
  games++;
}
const boards = read(path.join(DATA, "scores.json")) || {};
if (!process.env.SKIP_SCORES) for (const [game, list] of Object.entries(boards)) for (const e of list) { await store.addScore(game, e); scores++; }
console.log(`migrated ${games} games, ${scores} scores`);
