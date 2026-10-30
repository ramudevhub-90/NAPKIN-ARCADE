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

test("multiplayer is a hard gate: only a lab run that passed the 2-player race can ship", async () => {
  const { multiplayerProblem } = await import("../server/studio3d.js");
  const ok = { sessions: [{ outcome: "won" }], multiplayer: [] };
  assert.equal(multiplayerProblem(ok), null);
  assert.match(multiplayerProblem({ ...ok, multiplayer: ["Both racers start at the same spot"] }), /Multiplayer races: Both racers start/);
  assert.match(multiplayerProblem({ sessions: [{ outcome: "won" }] }), /didn't run the 2-player race check/); // an outdated lab can't wave a game through
  assert.equal(multiplayerProblem({ compileError: "boom" }), null); // crashes are reported separately
});

test("store credentials are sealed with AES-GCM and tampering is detected", async () => {
  process.env.CONNECTOR_KEY = "ab".repeat(32);
  const { seal, unseal } = await import("../server/stores/vault.js");
  const box = seal({ p8: "secret" });
  assert.ok(!box.includes("secret"));
  assert.deepEqual(unseal(box), { p8: "secret" });
  const [v, iv, tag, ct] = box.split(".");
  assert.throws(() => unseal([v, iv, tag, Buffer.from("x" + ct).toString("base64")].join(".")));
});

test("store keys are validated before they are saved", async () => {
  const crypto = await import("node:crypto");
  const play = await import("../server/stores/google-play.js"), asc = await import("../server/stores/app-store.js");
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(play.parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: rsa })).client_email, "a@b.iam.gserviceaccount.com");
  assert.throws(() => play.parseServiceAccount("{\"type\":\"authorized_user\"}"));
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(asc.parseApiKey({ issuerId: crypto.randomUUID(), keyId: "abc123defg", teamId: "team123456", p8: ec }).keyId, "ABC123DEFG");
  assert.throws(() => asc.parseApiKey({ issuerId: crypto.randomUUID(), keyId: "ABC123DEFG", teamId: "TEAM123456", p8: rsa })); // RSA isn't an ASC key
  assert.ok(play.PACKAGE.test("com.studio.game") && !play.PACKAGE.test("Com.Studio"));
});
