// Napkin Arcade server: studio API, live events (SSE), AI playtester actions and game hosting.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./env.js";
import { chat, parseJson, resolveModels, spending, onSpend, BudgetError } from "./llm.js";
import { runStudio } from "./studio3d.js";
import { actMessages3d, PERSONAS, testerSummaryMessages } from "./prompts3d.js";
import { requestCode, verifyCode, logout, me, currentUser, chargeBuild, mailMode } from "./auth.js";
import { createRoom, handleUpgrade } from "./rooms.js";
import { topScores, submitScore } from "./scores.js";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PUBLIC = path.join(ROOT, "public");
const PROJECTS = path.join(ROOT, "data", "projects");
fs.mkdirSync(PROJECTS, { recursive: true });
const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };

const live = new Map(); // id -> { events, clients, done, budget, playtest }
const starts = [];
let ready = false;

const pdir = (id) => path.join(PROJECTS, id);
const save = (id, name, data) => fs.writeFileSync(path.join(pdir(id), name), typeof data === "string" ? data : JSON.stringify(data));
const load = (id, name) => { const f = path.join(pdir(id), name); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };

function emitTo(p, ev) {
  const e = { ...ev, ts: Date.now() };
  p.events.push(e);
  for (const res of p.clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
}
onSpend((s) => { for (const p of live.values()) if (!p.done) emitTo(p, { type: "spend", ...s, project: +p.budget.spent.toFixed(5) }); });

function createProject({ idea, image, user }) {
  if (!ready) throw Object.assign(new Error("The studio needs a Nebius API key on the server. Try a showcase game instead."), { status: 503 });
  const now = Date.now();
  while (starts.length && now - starts[0] > 3600e3) starts.shift();
  if (starts.length >= config.liveRunsPerHour) throw Object.assign(new Error("The studio is busy this hour. Try a showcase game instead."), { status: 429 });
  if (!idea && !image) throw Object.assign(new Error("Draw something or type an idea first."), { status: 400 });
  chargeBuild(user);
  starts.push(now);
  const id = crypto.randomBytes(4).toString("hex");
  fs.mkdirSync(pdir(id));
  const hasDrawing = typeof image === "string" && image.startsWith("data:image/");
  if (hasDrawing) save(id, "drawing.txt", image);
  save(id, "meta.json", { id, idea: idea || "", hasDrawing, created: new Date().toISOString(), owner: user.email, ownerName: user.name });

  const p = { id, events: [], clients: new Set(), done: false, budget: { spent: 0, cap: config.campaignCapUsd }, tasks: {} };
  live.set(id, p);
  const project = { id, idea: idea || "", hasDrawing, image: hasDrawing ? image : null };
  // Game code runs only in the browser's sandboxed iframes: the server hands out tasks and waits.
  const browser = (kind, data, timeout = 240e3) => new Promise((resolve) => {
    const taskId = crypto.randomBytes(5).toString("hex");
    p.tasks[taskId] = resolve;
    emitTo(p, { type: "task", taskId, kind, data });
    setTimeout(() => { if (p.tasks[taskId]) { delete p.tasks[taskId]; resolve(null); } }, timeout);
  });
  (async () => {
    try {
      const out = await runStudio({ project, budget: p.budget, emit: (e) => emitTo(p, e), browser });
      save(id, "game3d.json", { ...out.payload, design: out.design, score: out.total });
    } catch (e) {
      emitTo(p, { type: "error", text: e instanceof BudgetError ? `Stopped by spending guardrail: ${e.message}` : e.message });
    }
    emitTo(p, { type: "done", projectCost: +p.budget.spent.toFixed(5), ...spending() });
    p.done = true;
    save(id, "events.json", p.events.filter((e) => e.type !== "task"));
    for (const res of p.clients) res.end();
    p.clients.clear();
  })();
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

function listProjects(filter) {
  const out = [];
  for (const id of fs.readdirSync(PROJECTS)) {
    const m = JSON.parse(load(id, "meta.json") || "null"); if (!m) continue;
    const graw = load(id, "game3d.json"), g = graw ? JSON.parse(graw) : null;
    if (!filter(m, g)) continue;
    out.push({ id, idea: m.idea, created: m.created, by: m.ownerName || "Napkin Arcade", ready: !!g, title: g?.title || g?.design?.title || null, tagline: g?.pitch || g?.design?.tagline || "", preset: g?.design?.preset || null, score: g?.score ?? null });
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/api/status") return json(res, 200, { live: ready, models: config.models, ...spending(), projectCapUsd: config.campaignCapUsd, publicUrl: process.env.PUBLIC_URL || null });

    // ---- accounts (email one-time codes) ----
    if (url.pathname === "/api/auth/code" && req.method === "POST") return json(res, 200, await requestCode(await body(req, 1e4)));
    if (url.pathname === "/api/auth/verify" && req.method === "POST") return json(res, 200, { user: verifyCode(res, await body(req, 1e4)) });
    if (url.pathname === "/api/auth/logout" && req.method === "POST") { logout(req, res); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/auth/me") return json(res, 200, { user: me(req), mail: mailMode });

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in to create games." });
      const b = await body(req);
      return json(res, 200, { id: createProject({ idea: String(b.idea || "").slice(0, 600), image: b.image, user }) });
    }
    if (url.pathname === "/api/my/projects") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      return json(res, 200, { projects: listProjects((m) => m.owner === user.email) });
    }
    if (url.pathname === "/api/gallery") return json(res, 200, { games: listProjects((m, g) => !!g).slice(0, 24) });
    if (url.pathname === "/api/scores") {
      const game = url.searchParams.get("game") || "";
      const known = /^example-[a-z]+$/.test(game) || (/^[a-z0-9]+$/.test(game) && load(game, "game3d.json"));
      if (!known) return json(res, 404, { error: "Game not found" });
      if (req.method === "POST") return json(res, 200, submitScore(game, await body(req, 1e4), req.socket.remoteAddress));
      return json(res, 200, { top: topScores(game) });
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const b = await body(req, 1e4);
      const ok = /^example-[a-z]+$/.test(b.game || "") || (/^[a-z0-9]+$/.test(b.game || "") && load(b.game, "game3d.json"));
      if (!ok) return json(res, 404, { error: "Game not found" });
      return json(res, 200, { room: createRoom(b.game) });
    }

    if (parts[0] === "api" && parts[1] === "projects" && /^[a-z0-9-]+$/.test(parts[2] || "")) {
      const id = parts[2], p = live.get(id), what = parts[3];
      if (what === "events") {
        const events = p ? p.events : JSON.parse(load(id, "events.json") || "null");
        if (!events) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const e of events) if (e.type !== "task" || p?.tasks[e.taskId]) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (!p || p.done) return res.end();
        p.clients.add(res);
        req.on("close", () => p.clients.delete(res));
        return;
      }
      if (what === "game3d") {
        const g = load(id, "game3d.json");
        return g ? json(res, 200, JSON.parse(g)) : json(res, 404, { error: "This game is not ready yet." });
      }
      if (what === "task" && req.method === "POST" && p) {
        const b = await body(req, 3e6);
        const done = p.tasks[b.taskId];
        if (done) { delete p.tasks[b.taskId]; done(b.result ?? null); }
        return json(res, 200, { ok: !!done });
      }
      if (what === "drawing") {
        const d = load(id, "drawing.txt");
        if (!d) return json(res, 404, { error: "no drawing" });
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
    if (url.pathname === "/studio") {
      if (!currentUser(req)) { res.writeHead(302, { Location: "/login?next=/studio" }); return res.end(); }
      return page("studio.html");
    }
    // Play pages: /play/<id>
    if (parts[0] === "play" && parts[1]) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return fs.createReadStream(path.join(PUBLIC, "play3d.html")).pipe(res);
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ...CORS });
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
  console.log(`Spent so far: $${spending().totalUsd.toFixed(4)} of $${config.hardCapUsd} hard cap`);
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws")) return socket.destroy();
    handleUpgrade(req, socket, head, currentUser(req)?.name);
  });
  server.listen(config.port, () => console.log(`Napkin Arcade on http://localhost:${config.port}`));
})();
