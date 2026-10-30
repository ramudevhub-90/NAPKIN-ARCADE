// Studio unit tests: the linter, scoring and auto-tuner (no network, no model calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lintGame } from "../server/lint.js";
import { funScore, autoEase, botReport } from "../server/studio3d.js";

const EX = new URL("../public/engine3d/examples/", import.meta.url);

test("every showcase game passes the linter", () => {
  for (const f of fs.readdirSync(EX).filter((f) => f.endsWith(".js"))) assert.deepEqual(lintGame(fs.readFileSync(new URL(f, EX), "utf8")), [], f);
});

test("linter catches undeclared names and quotes the line", () => {
  const issues = lintGame("export function setup(api) {}\nfunction lane(l) { return api.clamp(l, 0, 2); }\nexport function update(api, dt) { lane(1); Math.random(); }");
  assert.ok(issues.some((i) => i.includes('"api" is used but never declared') && i.includes("api.clamp")));
  assert.ok(issues.some((i) => i.includes("api.rand()")));
});

test("fun score gives partial credit, so improvements are visible even with no wins", () => {
  const rep = (p) => botReport(["novice", "casual", "expert"].flatMap((skill) => [1, 2].map(() => ({ skill, outcome: "lost", time: 50, progress: p, pickups: 2, hurts: [], cause: "crash" }))));
  const worse = funScore(rep(0.2)), better = funScore(rep(0.8));
  assert.ok(better.score > worse.score && better.raw > worse.raw);
});

test("auto-tuner eases danger and keeps rewards", () => {
  const out = autoEase({ lives: 3, rowGap: 30, carChance: 0.4, coinChance: 0.5, enemySpeed: 10, length: 1800 }, 1.5);
  assert.equal(out.lives, 5);
  assert.ok(out.rowGap > 30 && out.carChance < 0.4 && out.enemySpeed < 10 && out.coinChance >= 0.5);
  assert.equal(out.length, undefined);
});

test("leaderboard weeks follow ISO 8601 (Monday start, week 1 holds the first Thursday)", async () => {
  const { isoWeek, boardKey } = await import("../aws/lib/store.mjs");
  assert.equal(isoWeek(new Date("2026-10-30T12:00:00Z")), "2026-44");
  assert.equal(isoWeek(new Date("2024-12-30T12:00:00Z")), "2025-01");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-53");
  assert.equal(boardKey("month", new Date("2026-10-30T12:00:00Z")), "M2026-10");
  assert.equal(boardKey("all"), "ALL");
});

test("every showcase game starts racers apart in multiplayer", () => {
  for (const f of fs.readdirSync(EX).filter((f) => f.endsWith(".js"))) assert.match(fs.readFileSync(new URL(f, EX), "utf8"), /api\.mp\b/, f);
});
