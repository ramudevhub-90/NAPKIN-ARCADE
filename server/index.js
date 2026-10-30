// Napkin Arcade server: studio API, live events (SSE), AI playtester actions and game hosting.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./env.js";
import { chat, parseJson, resolveModels, spending, onSpend, setSpentBase, BudgetError } from "./llm.js";
import { runStudio, runRevision } from "./studio3d.js";
import { actMessages3d, PERSONAS, testerSummaryMessages } from "./prompts3d.js";
import { startSession, logout, me, currentUser, chargeBuild, chargeRevision, cognitoConfig } from "./cognito.js";
import { createRoom, handleUpgrade } from "./rooms.js";
import * as store from "../aws/lib/store.mjs";
import { publishStudioEvent } from "../aws/lib/appsync.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PUBLIC = path.join(ROOT, "public");
const PROJECTS = path.join(ROOT, "data", "projects"); // local cache of studio event logs only
fs.mkdirSync(PROJECTS, { recursive: true });
const APPSYNC = !!process.env.APPSYNC_URL;
const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };

const live = new Map(); // id -> { events, clients, done, budget, playtest }
const starts = [];
let ready = false;

const pdir = (id) => path.join(PROJECTS, id);
const save = (id, name, data) => { fs.mkdirSync(pdir(id), { recursive: true }); fs.writeFileSync(path.join(pdir(id), name), typeof data === "string" ? data : JSON.stringify(data)); };
const load = (id, name) => { const f = path.join(pdir(id), name); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };

function emitTo(p, ev) {
  const e = { ...ev, ts: Date.now() };
  p.events.push(e);
  for (const res of p.clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
  // Owners also receive every event over AppSync (Cognito-authenticated, owner-filtered).
  if (APPSYNC && p.ownerSub) publishStudioEvent(p.id, p.ownerSub, e).catch((err) => console.error("AppSync publish:", err.message));
}
onSpend((s) => {
  if (s.delta) store.addSpend(s.delta).catch(() => {});
  for (const p of live.values()) if (!p.done) emitTo(p, { type: "spend", ...s, project: +p.budget.spent.toFixed(5) });
});

// A studio job (new game or revision): live events over SSE, browser tasks for sandboxed tests.
function startJob(id, ownerSub, work, onDone, eventsFile) {
  const p = { id, ownerSub, events: [], clients: new Set(), done: false, budget: { spent: 0, cap: config.campaignCapUsd }, tasks: {} };
  live.set(id, p);
  // Game code runs only in the browser's sandboxed iframes: the server hands out tasks and waits.
  const browser = (kind, data, timeout = 240e3) => new Promise((resolve) => {
    const taskId = crypto.randomBytes(5).toString("hex");
    p.tasks[taskId] = resolve;
    emitTo(p, { type: "task", taskId, kind, data });
    setTimeout(() => { if (p.tasks[taskId]) { delete p.tasks[taskId]; resolve(null); } }, timeout);
  });
  (async () => {
    try { await onDone(await work({ budget: p.budget, emit: (e) => emitTo(p, e), browser }), p); }
    catch (e) {
      emitTo(p, { type: "error", text: e instanceof BudgetError ? `Stopped by spending guardrail: ${e.message}` : e.message });
      try { await onDone(null, p, e); } catch {}
    }
    emitTo(p, { type: "done", projectCost: +p.budget.spent.toFixed(5), ...spending() });
    p.done = true;
    if (eventsFile) save(id, eventsFile, p.events.filter((e) => e.type !== "task"));
    for (const res of p.clients) res.end();
    p.clients.clear();
  })();
  return p;
}

// ---- Workshop: chat with memory, versions, player feedback (DynamoDB + S3) ----
async function ownedGame(req, id) {
  const user = await currentUser(req);
  if (!user) throw Object.assign(new Error("Please sign in."), { status: 401 });
  const meta = await store.getGame(id);
  if (!meta) throw Object.assign(new Error("Game not found."), { status: 404 });
  if (meta.owner !== user.sub) throw Object.assign(new Error("Only the game's creator can do this."), { status: 403 });
  if (meta.status !== "ready") throw Object.assign(new Error("This game hasn't finished building yet."), { status: 409 });
  return { user, meta, game: await store.getPayload(id, meta.version) }; // latest version: changes stack on drafts
}
async function syncPending(id) {
  const n = (await store.feedback(id)).filter((f) => f.status === "pending").length;
  await store.updateGame(id, { pendingFeedback: n });
}
async function startRevision(id, user, meta, game, request, source, feedbackId = null) {
  if (!ready) throw Object.assign(new Error("The studio is offline."), { status: 503 });
  if (live.get(id) && !live.get(id).done) throw Object.assign(new Error("The studio is already working on this game. Wait for it to finish."), { status: 409 });
  await chargeRevision(user);
  const history = await store.chat(id);
  return startJob(id, user.sub, (ctx) => runRevision({ current: game, design: game.design, changelog: meta.changelog || [], history, request, source, ...ctx }), async (out, p, err) => {
    const setFb = async (status) => { if (feedbackId) { await store.setFeedback(id, feedbackId, status); await syncPending(id); } };
    if (!out) { await store.addChat(id, { role: "studio", text: `That change didn't work out: ${err?.message || "unknown error"}. The game is unchanged.` }); await setFb("approved"); return; }
    if (!out.changed) { await store.addChat(id, { role: "studio", text: out.reply }); return; }
    const next = { ...out.payload, design: game.design, score: out.after };
    const v = await store.saveVersion(id, next, out.summary, out.after); // a draft: players keep the live version
    await store.addChat(id, { role: "studio", text: `${out.reply}\n📝 Saved as draft version ${v} (bot fun score ${out.before} → ${out.after}). Players still see the live version — preview the draft, then press Publish when you're happy.`, version: v, before: out.before, after: out.after });
    await setFb("applied");
    emitTo(p, { type: "revised", version: v, draft: true, before: out.before, after: out.after, summary: out.summary });
  });
}
const fbHits = new Map();
// Behind Caddy every request comes from loopback; the real client is the last X-Forwarded-For hop.
const clientIp = (req) => { const a = req.socket.remoteAddress || ""; return /^(::1|127\.|::ffff:127\.)/.test(a) ? String(req.headers["x-forwarded-for"] || a).split(",").pop().trim() : a; };

async function createProject({ idea, image, user }) {
  if (!ready) throw Object.assign(new Error("The studio needs a Nebius API key on the server. Try a showcase game instead."), { status: 503 });
  const now = Date.now();
  while (starts.length && now - starts[0] > 3600e3) starts.shift();
  if (starts.length >= config.liveRunsPerHour) throw Object.assign(new Error("The studio is busy this hour. Try a showcase game instead."), { status: 429 });
  if (!idea && !image) throw Object.assign(new Error("Draw something or type an idea first."), { status: 400 });
  await chargeBuild(user);
  starts.push(now);
  const id = store.newId(4);
  const hasDrawing = typeof image === "string" && image.startsWith("data:image/") && (await store.putDrawing(id, image));
  const meta = { id, idea: idea || "", hasDrawing: !!hasDrawing, owner: user.sub, ownerName: user.name, status: "building", createdAt: new Date().toISOString() };
  await store.putGameMeta(meta);
  startJob(id, user.sub, (ctx) => runStudio({ project: { id, idea: idea || "", hasDrawing: !!hasDrawing, image: hasDrawing ? image : null }, ...ctx }), async (out, p, err) => {
    if (!out) { await store.updateGame(id, { status: "failed", error: String(err?.message || "").slice(0, 300) }); return; }
    const game = { ...out.payload, design: out.design, score: out.total };
    await store.putGameMeta({ ...meta, status: "ready", title: game.title || out.design?.title, tagline: game.pitch || out.design?.tagline || "", preset: out.design?.preset || null, score: out.total });
    await store.saveVersion(id, game, "First version, built by the studio", out.total, { publish: true });
  }, "events.json");
  return id;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm", ".webp": "image/webp" };
const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(body)); };
async function body(req, limit = 4e6) {
  let b = "";
  for await (const c of req) { b += c; if (b.length > limit) throw Object.assign(new Error("Upload too large"), { status: 413 }); }
  return JSON.parse(b || "{}");
}

const gameCard = (m) => ({ id: m.id, idea: m.idea, created: m.createdAt, by: m.ownerName || "Napkin Arcade", ready: m.status === "ready", status: m.status, version: m.version || 0, pendingFeedback: m.pendingFeedback || 0, title: m.title || null, tagline: m.tagline || "", preset: m.preset || null, score: m.score ?? null });
const knownGame = async (g) => /^example-[a-z]+$/.test(g || "") || (/^[a-z0-9]+$/.test(g || "") && (await store.getGame(g))?.status === "ready");
const scoreHits = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/api/status") return json(res, 200, { live: ready, models: config.models, ...spending(), projectCapUsd: config.campaignCapUsd, publicUrl: process.env.PUBLIC_URL || null });
    // Public client config: Cognito pool/client and the AppSync endpoint.
    if (url.pathname === "/api/config") return json(res, 200, { cognito: cognitoConfig, appsync: APPSYNC ? { url: process.env.APPSYNC_URL, realtime: process.env.APPSYNC_URL.replace("https://", "wss://").replace("appsync-api", "appsync-realtime-api") } : null });

    // ---- accounts: Amazon Cognito (custom passwordless auth) → session cookie ----
    if (url.pathname === "/api/auth/session" && req.method === "POST") return json(res, 200, { user: await startSession(res, await body(req, 2e4)) });
    if (url.pathname === "/api/auth/logout" && req.method === "POST") { await logout(req, res); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/auth/me") return json(res, 200, { user: await me(req) });

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in to create games." });
      const b = await body(req);
      return json(res, 200, { id: await createProject({ idea: String(b.idea || "").slice(0, 600), image: b.image, user }) });
    }
    if (url.pathname === "/api/my/projects") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      return json(res, 200, { projects: (await store.myGames(user.sub)).map(gameCard) });
    }
    // Every player comment across the signed-in creator's games, newest first.
    if (url.pathname === "/api/my/feedback") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      const games = (await store.myGames(user.sub)).filter((m) => m.status === "ready");
      const lists = await Promise.all(games.map(async (m) => (await store.feedback(m.id)).map(({ id, text, name, status, at, kind, reports, auto }) => ({ id, text, name, status, at, kind: kind || "idea", reports: reports || 1, auto: !!auto, gameId: m.id, title: m.title || "Untitled game" }))));
      return json(res, 200, { feedback: lists.flat().sort((a, b) => (a.at < b.at ? 1 : -1)) });
    }
    if (url.pathname === "/api/gallery") return json(res, 200, { games: (await store.gallery(24)).map(gameCard) });
    if (url.pathname === "/api/scores") {
      const game = url.searchParams.get("game") || "";
      if (!(await knownGame(game))) return json(res, 404, { error: "Game not found" });
      if (req.method === "POST") {
        const ip = clientIp(req), now = Date.now(), hits = (scoreHits.get(ip) || []).filter((t) => now - t < 60e3);
        if (hits.length >= 12) return json(res, 429, { error: "Too many scores — slow down." });
        scoreHits.set(ip, [...hits, now]);
        const b = await body(req, 1e4);
        const entry = { name: String(b.name || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player", score: Math.max(0, Math.min(1e7, Math.round(+b.score || 0))), progress: Math.max(0, Math.min(1, +b.progress || 0)), won: b.won ? 1 : 0, time: Math.max(0, Math.min(3600, +b.time || 0)) };
        await store.addScore(game, entry);
        const top = await store.topScores(game, 100);
        const rank = top.findIndex((t) => t.name === entry.name && t.score === entry.score) + 1 || null;
        return json(res, 200, { rank, top: top.slice(0, 10) });
      }
      return json(res, 200, { top: await store.topScores(game, 10) });
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const b = await body(req, 1e4);
      if (!(await knownGame(b.game))) return json(res, 404, { error: "Game not found" });
      return json(res, 200, { room: createRoom(b.game) });
    }

    if (parts[0] === "api" && parts[1] === "projects" && /^[a-z0-9-]+$/.test(parts[2] || "")) {
      const id = parts[2], p = live.get(id), what = parts[3];
      if (what === "events") {
        // Live events (with studio tasks) go only to the game's owner.
        if (p?.ownerSub && (await currentUser(req))?.sub !== p.ownerSub) return json(res, 403, { error: "Only the game's creator can watch the studio." });
        const events = p ? p.events : JSON.parse(load(id, "events.json") || "null");
        if (!events) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const e of events) if (e.type !== "task" || p?.tasks[e.taskId]) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (!p || p.done) return res.end();
        p.clients.add(res);
        req.on("close", () => p.clients.delete(res));
        return;
      }
      if (what === "workshop") {
        const { meta, game } = await ownedGame(req, id);
        const [versions, chatLog, fb] = await Promise.all([store.versions(id), store.chat(id), store.feedback(id)]);
        return json(res, 200, { id, title: meta.title || game.design?.title, tagline: meta.tagline || game.design?.tagline, design: game.design, version: meta.version, liveVersion: store.liveVersionOf(meta), versions: versions.map(({ v, summary, at, score }) => ({ v, summary, at, score })), changelog: meta.changelog || [], chat: chatLog.map(({ role, text, version, at }) => ({ role, text, version, at })), feedback: fb.map(({ id, text, name, status, at, kind, reports, auto }) => ({ id, text, name, status, at, kind: kind || "idea", reports: reports || 1, auto: !!auto })), busy: !!(p && !p.done) });
      }
      if (what === "chat" && req.method === "POST") {
        const { user, meta, game } = await ownedGame(req, id);
        const text = String((await body(req, 2e4)).text || "").trim().slice(0, 1500);
        if (!text) return json(res, 400, { error: "Type what you'd like to change." });
        await startRevision(id, user, meta, game, text, "owner");
        await store.addChat(id, { role: "user", text });
        return json(res, 200, { ok: true });
      }
      // Publish a version (draft or older) to every player; this is also how rollback works.
      if (what === "publish" && req.method === "POST") {
        const { meta } = await ownedGame(req, id);
        const v = Math.round(+(await body(req, 1e3)).version);
        if (!(v >= 1 && v <= meta.version)) return json(res, 404, { error: "No such version." });
        await store.publishVersion(id, v);
        await store.addChat(id, { role: "studio", text: `🚀 Version ${v} is now live for every player.`, version: v });
        return json(res, 200, { ok: true, liveVersion: v });
      }
      // The owner's preview of any version, including drafts (players only ever get the live one).
      if (what === "version" && /^\d+$/.test(parts[4] || "")) {
        const { meta } = await ownedGame(req, id);
        const v = +parts[4];
        if (!(v >= 1 && v <= meta.version)) return json(res, 404, { error: "No such version." });
        return json(res, 200, await store.getPayload(id, v));
      }
      if (what === "feedback" && req.method === "POST" && !parts[4]) {
        if ((await store.getGame(id))?.status !== "ready") return json(res, 404, { error: "Game not found." });
        const ip = clientIp(req), now = Date.now(), hits = (fbHits.get(ip) || []).filter((t) => now - t < 3600e3);
        if (hits.length >= 8) return json(res, 429, { error: "Thanks! You've sent a lot of feedback this hour." });
        fbHits.set(ip, [...hits, now]);
        const b = await body(req, 1e4);
        // Crashes in a player's browser are filed automatically as bugs (one open report per error).
        if (b.auto) {
          const msg = String(b.error?.message || "").slice(0, 300), stack = String(b.error?.stack || "").slice(0, 600);
          if (!msg) return json(res, 400, { error: "No error." });
          const open = (await store.feedback(id)).find((f) => f.auto && f.error === msg && (f.status === "pending" || f.status === "working"));
          if (open) await store.bumpFeedback(id, open.id);
          else await store.addFeedback(id, `The game crashed for a player: "${msg}"${stack ? `\nWhere: ${stack}` : ""}`, "Crash report", "bug", { auto: true, error: msg });
          await syncPending(id);
          return json(res, 200, { ok: true });
        }
        const text = String(b.text || "").trim().slice(0, 600);
        if (text.length < 3) return json(res, 400, { error: "Tell us a bit more." });
        const name = String((await currentUser(req))?.name || b.name || "Player").replace(/[<>]/g, "").slice(0, 30);
        await store.addFeedback(id, text, name, b.kind === "bug" ? "bug" : "idea");
        await syncPending(id);
        return json(res, 200, { ok: true });
      }
      if (what === "feedback" && req.method === "POST" && parts[4]) {
        const { user, meta, game } = await ownedGame(req, id);
        const action = (await body(req, 1e3)).action;
        const f = (await store.feedback(id)).find((x) => x.id === parts[4]);
        if (!f) return json(res, 404, { error: "Feedback not found." });
        if (action === "reject") { await store.setFeedback(id, f.id, "rejected"); await syncPending(id); return json(res, 200, { ok: true }); }
        if (action !== "approve" || f.status !== "pending") return json(res, 400, { error: "Nothing to do." });
        const request = f.kind === "bug" ? `Fix this bug reported by ${f.auto ? "the crash reporter" : "a player"}${f.reports > 1 ? ` (seen ${f.reports} times)` : ""}: ${f.text}` : f.text;
        await startRevision(id, user, meta, game, request, "feedback", f.id);
        await store.setFeedback(id, f.id, "working"); await syncPending(id);
        await store.addChat(id, { role: "feedback", text: `${f.kind === "bug" ? "🐞 Bug" : "✨ Enhancement"} from ${f.name}: ${f.text}` });
        return json(res, 200, { ok: true });
      }
      if (what === "game3d") {
        try { return json(res, 200, await store.getPayload(id)); } catch { return json(res, 404, { error: "This game is not ready yet." }); }
      }
      if (what === "task" && req.method === "POST" && p) {
        const b = await body(req, 3e6);
        const done = p.tasks[b.taskId];
        if (done) { delete p.tasks[b.taskId]; done(b.result ?? null); }
        return json(res, 200, { ok: !!done });
      }
      if (what === "drawing") {
        let d; try { d = await store.getDrawing(id); } catch { return json(res, 404, { error: "no drawing" }); }
        const m = d.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
        res.writeHead(200, { "Content-Type": m[1], "Cache-Control": "max-age=3600" });
        return res.end(Buffer.from(m[2], "base64"));
      }
      // AI playtester: one vision decision from a screenshot of the live 3D game.
      if (what === "act" && req.method === "POST" && p && !p.done) {
        const b = await body(req, 1.5e6);
        const persona = PERSONAS.find((x) => x.id === b.persona) || PERSONAS[0];
        const meta = { title: "", controls: "move", action: "none", ...(b.meta || {}) };
        const r = await chat({ role: "vision", messages: actMessages3d(persona, meta, b.frame, b.memory || []), maxTokens: 300, temperature: 0.6, budget: p.budget, purpose: `playtest ${persona.id}`, extra: NO_THINK });
        let a; try { a = parseJson(r.text); } catch { a = { thought: "…", action: "wait", seconds: 0.5 }; }
        const ok = ["left", "right", "up", "down", "up_left", "up_right", "action", "wait", "left_action", "right_action", "forward", "back", "jump"];
        if (!ok.includes(a.action)) a.action = meta.controls === "move" ? "up" : "wait";
        a.seconds = Math.max(0.3, Math.min(1.5, +a.seconds || 0.6));
        a.thought = String(a.thought || "").slice(0, 120);
        return json(res, 200, { ...a, persona: persona.name });
      }
      if (what === "summary" && req.method === "POST" && p) {
        const b = await body(req, 2e5);
        const testers = [];
        for (const s of (b.sessions || []).slice(0, 3)) {
          const persona = PERSONAS.find((x) => x.id === s.persona) || PERSONAS[0];
          try {
            const r = await chat({ role: "fast", messages: testerSummaryMessages(persona, { title: b.title || "" }, (s.log || []).slice(-40)), maxTokens: 400, temperature: 0.4, budget: p.budget, purpose: `tester summary ${persona.id}`, extra: NO_THINK });
            testers.push({ name: persona.name, ...parseJson(r.text), outcome: s.outcome });
          } catch (e) { if (e instanceof BudgetError) break; }
        }
        return json(res, 200, { testers });
      }
    }

    // Pages: landing, sign-in, studio (members only), play.
    const page = (f) => { res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" }); return fs.createReadStream(path.join(PUBLIC, f)).pipe(res); };
    if (url.pathname === "/") return page("landing.html");
    if (url.pathname === "/login") return page("login.html");
    if (url.pathname === "/arcade") return page("arcade.html");
    if (parts[0] === "studio" && parts[1] === "game" && /^[a-z0-9]+$/.test(parts[2] || "")) {
      if (!(await currentUser(req))) { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname)}` }); return res.end(); }
      return page("workshop.html");
    }
    if (url.pathname === "/studio/feedback") {
      if (!(await currentUser(req))) { res.writeHead(302, { Location: "/login?next=/studio/feedback" }); return res.end(); }
      return page("inbox.html");
    }
    if (url.pathname === "/studio") {
      if (!(await currentUser(req))) { res.writeHead(302, { Location: "/login?next=/studio" }); return res.end(); }
      return page("studio.html");
    }
    // Play pages: /play/<id>
    if (parts[0] === "play" && parts[1]) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return fs.createReadStream(path.join(PUBLIC, "play3d.html")).pipe(res);
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
    const type = MIME[path.extname(file)] || "application/octet-stream", size = fs.statSync(file).size;
    const media = /^(video|image)\//.test(type) && file.includes(`${path.sep}media${path.sep}`);
    const headers = { "Content-Type": type, "Cache-Control": media ? "public, max-age=86400" : "no-cache", "Accept-Ranges": "bytes", ...CORS };
    // Range requests let browsers stream and seek video (Safari requires them).
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      let start = range[1] === "" ? size - +range[2] : +range[1], end = range[1] === "" || range[2] === "" ? size - 1 : +range[2];
      start = Math.max(0, start); end = Math.min(end, size - 1);
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, e.status || 500, { error: e instanceof BudgetError ? `Spending guardrail: ${e.message}` : e.message });
  }
});

(async () => {
  if (config.nebiusKey) {
    try { console.log("Token Factory models:", await resolveModels()); ready = true; }
    catch (e) { console.error("Token Factory unavailable:", e.message); }
  } else console.log("No NEBIUS_API_KEY set: studio disabled (showcase games still playable).");
  try { setSpentBase(await store.totalSpend()); } catch (e) { console.error("Spend total unavailable:", e.message); }
  console.log(`Spent so far: $${spending().totalUsd.toFixed(4)} of $${config.hardCapUsd} hard cap`);
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws")) return socket.destroy();
    currentUser(req).then((u) => handleUpgrade(req, socket, head, u?.name), () => handleUpgrade(req, socket, head, null));
  });
  server.listen(config.port, () => console.log(`Napkin Arcade on http://localhost:${config.port}`));
})();
