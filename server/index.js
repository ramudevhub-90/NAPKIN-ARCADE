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
import { sendMail, circleInviteEmail, gameSharedEmail, groupInviteEmail } from "../aws/lib/mail.mjs";

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
// AI spend is tracked for the platform's hard cap only; it is never sent to creators.
onSpend((s) => { if (s.delta) store.addSpend(s.delta).catch(() => {}); });

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
      if (e instanceof BudgetError) console.error(`spending guardrail (${id}):`, e.message);
      emitTo(p, { type: "error", text: e instanceof BudgetError ? "The studio is at capacity right now — please try again a little later." : e.message });
      try { await onDone(null, p, e); } catch {}
    }
    emitTo(p, { type: "done" });
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
    if (!out) { await store.addChat(id, { role: "studio", text: `That change didn't work out: ${err?.message || "unknown error"}. The game is unchanged.` }); await setFb("pending"); return; } // back in the inbox so it can be approved again
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

const gameCard = (m) => ({ id: m.id, idea: m.idea, created: m.createdAt, by: m.ownerName || "Napkin Arcade", ready: m.status === "ready", status: m.status, version: m.version || 0, pendingFeedback: m.pendingFeedback || 0, title: m.title || null, tagline: m.tagline || "", preset: m.preset || null, score: m.score ?? null, visibility: m.visibility || "public", groupId: m.groupId || null });
// Private games: circle-only ones for the creator's circle, group ones for the group's members.
async function canPlay(req, meta) {
  const vis = meta.visibility || "public";
  if (vis === "public") return { ok: true };
  const user = await currentUser(req);
  if (!user) return { ok: false, user };
  if (user.sub === meta.owner) return { ok: true, user };
  if (vis === "group") return { ok: !!(await store.groupMember(meta.groupId, user.sub)), user };
  return { ok: await store.inCircle(meta.owner, user.email), user };
}
const PUBLIC_URL = () => (process.env.PUBLIC_URL || "https://napkinarcade.revenuerush.in").replace(/\/$/, "");
const inviteHits = new Map(); // sub -> timestamps (group email invites)

// ---- tournaments ----
const EXAMPLE_TITLES = { runner: "Neon Cab Rush", flyer: "Ring Rider", arena: "Star Pup Panic", skier: "Frost Fall", meteors: "Meteor Mayhem", reef: "Reef Rush" };
const SPLITS = { all: [100], "60-40": [60, 40], "50-30-20": [50, 30, 20] };
const tourStatus = (t, now = Date.now()) => (now < Date.parse(t.startsAt) ? "upcoming" : now < Date.parse(t.endsAt) ? "live" : "ended");
const runHits = new Map(); // sub -> last tournament run time
// Who may enter: anyone signed in (link tournaments) or members of the tournament's group.
async function tourAccess(t, user) {
  if (!user) return { ok: false, reason: "signin" };
  if (t.access === "group" && !(await store.groupMember(t.groupId, user.sub))) return { ok: false, reason: "group" };
  return { ok: true };
}
async function tourView(t, user) {
  const [{ ranked, waiting }, entry, access, group] = await Promise.all([store.tournamentStandings(t.tid), store.tournamentEntry(t.tid, user?.sub), tourAccess(t, user), t.access === "group" ? store.getGroup(t.groupId) : null]);
  const status = tourStatus(t), split = SPLITS[t.prize?.split] || SPLITS.all;
  const myRank = entry ? ranked.findIndex((e) => e.sub === user.sub) + 1 || null : null;
  return {
    code: t.code, tid: t.tid, name: t.name, about: t.about, hostName: t.hostName, host: !!user && user.sub === t.host,
    game: t.game, startsAt: t.startsAt, endsAt: t.endsAt, status, now: new Date().toISOString(),
    prize: { amount: t.prize?.amount || 0, currency: t.prize?.currency || "INR", note: t.prize?.note || "", split, places: split.map((pct) => Math.round(((t.prize?.amount || 0) * pct) / 100)) },
    access: t.access, group: group ? { name: group.name, gid: group.gid } : null, entrants: ranked.length + waiting.length,
    standings: ranked.slice(0, 100).map((e, i) => ({ rank: i + 1, name: e.name, score: e.best.score, progress: e.best.progress, won: e.best.won, time: e.best.time, runs: e.runs || 0, you: !!user && e.sub === user.sub })),
    you: { signedIn: !!user, entered: !!entry, best: entry?.best || null, runs: entry?.runs || 0, rank: myRank, canEnter: access.ok, reason: access.reason || null },
    url: `${PUBLIC_URL()}/t/${t.code}`,
  };
}
const knownGame = async (req, g) => {
  if (/^example-[a-z]+$/.test(g || "")) return true;
  const meta = /^[a-z0-9]+$/.test(g || "") && (await store.getGame(g));
  return meta?.status === "ready" && (await canPlay(req, meta)).ok;
};
// The game runs in a sandboxed (opaque-origin) frame that can't send the session cookie, so the
// play page hands it a short-lived signed ticket for a circle-only game's payload.
const TICKET_KEY = crypto.randomBytes(32);
const sign = (s) => crypto.createHmac("sha256", TICKET_KEY).update(s).digest("hex");
const playTicket = (id) => { const exp = Date.now() + 6 * 3600e3; return `${exp}.${sign(`${id}.${exp}`)}`; };
const validTicket = (id, t) => { const [exp, sig] = String(t || "").split("."); return +exp > Date.now() && /^[a-f0-9]{64}$/.test(sig || "") && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(`${id}.${exp}`))); };
const COUNTRY = /^(?!ALL$)[A-Z]{2}$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;
const scoreHits = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // Public status: whether the studio is live. AI spend and caps stay server-side.
    if (url.pathname === "/api/status") return json(res, 200, { live: ready, publicUrl: process.env.PUBLIC_URL || null });
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
    // My circle: people who can play my circle-only games.
    if (url.pathname === "/api/my/circle") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      if (req.method === "POST") {
        const b = await body(req, 2e3), email = String(b.email || "").trim().toLowerCase();
        if (!EMAIL.test(email)) return json(res, 400, { error: "That doesn't look like an email address." });
        let invited = null;
        if (b.remove) await store.removeFromCircle(user.sub, email);
        else {
          if (email === user.email) return json(res, 400, { error: "You can always play your own games." });
          const members = await store.circle(user.sub);
          if (members.length >= 200) return json(res, 400, { error: "Your circle is full (200 people)." });
          if (!members.some((m) => m.email === email)) {
            await store.addToCircle(user, email);
            // Email the invite with the creator's circle-only games; replies go to the creator.
            const games = (await store.myGames(user.sub)).filter((m) => m.status === "ready" && m.visibility === "circle");
            invited = await sendMail({ to: email, replyTo: user.email, ...circleInviteEmail({ from: user.name, to: email, games }) }).then(() => true, (e) => (console.error("invite email:", e.message), false));
          }
        }
        return json(res, 200, { invited, members: (await store.circle(user.sub)).map(({ email, at }) => ({ email, at })) });
      }
      return json(res, 200, { members: (await store.circle(user.sub)).map(({ email, at }) => ({ email, at })) });
    }
    if (url.pathname === "/api/shared") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      return json(res, 200, { games: (await store.sharedWithMe(user.email)).map(gameCard) });
    }
    // ---- groups: sub-communities with a join link ----
    if (url.pathname === "/api/my/groups") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      const groups = (await Promise.all((await store.myGroups(user.sub)).map((l) => store.getGroup(l.gid)))).filter(Boolean);
      return json(res, 200, { groups: groups.map((g) => ({ gid: g.gid, name: g.name, about: g.about, members: g.members || 0, owner: g.owner === user.sub, ownerName: g.ownerName })) });
    }
    if (url.pathname === "/api/groups" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      const b = await body(req, 4e3), name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 40), about = String(b.about || "").replace(/[<>]/g, "").trim().slice(0, 240);
      if (name.length < 2) return json(res, 400, { error: "Give your group a name." });
      if ((await store.myGroups(user.sub)).filter((l) => l.role === "owner").length >= 20) return json(res, 400, { error: "You can run up to 20 groups." });
      const g = await store.createGroup(user, name, about);
      return json(res, 200, { gid: g.gid });
    }
    if (parts[0] === "api" && parts[1] === "groups" && /^[a-f0-9]{10}$/.test(parts[2] || "")) {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      const g = await store.getGroup(parts[2]), me = g && (await store.groupMember(g.gid, user.sub));
      if (!g || !me) return json(res, 404, { error: "Group not found, or you're not a member." });
      const owner = g.owner === user.sub;
      if (req.method === "POST") {
        const b = await body(req, 4e3);
        if (b.action === "leave") {
          if (owner) return json(res, 400, { error: "You run this group, so you can't leave it." });
          await store.leaveGroup(g.gid, user.sub);
          return json(res, 200, { left: true });
        }
        if (b.action === "remove") {
          if (!owner) return json(res, 403, { error: "Only the group's owner can remove people." });
          if (b.sub === user.sub) return json(res, 400, { error: "You can't remove yourself." });
          await store.leaveGroup(g.gid, String(b.sub || ""));
        } else if (b.action === "reset") {
          if (!owner) return json(res, 403, { error: "Only the group's owner can reset the link." });
          g.code = await store.resetGroupLink(g);
        } else if (b.action === "invite") {
          const email = String(b.email || "").trim().toLowerCase();
          if (!EMAIL.test(email)) return json(res, 400, { error: "That doesn't look like an email address." });
          const now = Date.now(), hits = (inviteHits.get(user.sub) || []).filter((t) => now - t < 3600e3);
          if (hits.length >= 30) return json(res, 429, { error: "That's a lot of invites this hour. Try again later." });
          inviteHits.set(user.sub, [...hits, now]);
          const sent = await sendMail({ to: email, replyTo: user.email, ...groupInviteEmail({ from: user.name, to: email, group: g, joinUrl: `${PUBLIC_URL()}/g/${g.code}` }) }).then(() => true, (e) => (console.error("group invite:", e.message), false));
          if (!sent) return json(res, 502, { error: "The invite email didn't go out. Share the link instead." });
          return json(res, 200, { invited: email });
        } else return json(res, 400, { error: "Unknown action." });
      }
      const [members, games] = await Promise.all([store.groupMembers(g.gid), store.groupGames(g.gid)]);
      return json(res, 200, {
        gid: g.gid, name: g.name, about: g.about, ownerName: g.ownerName, owner, joinUrl: `${PUBLIC_URL()}/g/${g.code}`,
        members: members.map((m) => ({ sub: m.sub, name: m.name, role: m.role, at: m.at, you: m.sub === user.sub })).sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.at < b.at ? -1 : 1)),
        games: games.map(gameCard),
      });
    }
    // ---- tournaments ----
    if (url.pathname === "/api/tournaments" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in to host a tournament." });
      const b = await body(req, 6e3);
      const name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 60), about = String(b.about || "").replace(/[<>]/g, "").trim().slice(0, 400);
      if (name.length < 3) return json(res, 400, { error: "Give the tournament a name." });
      const start = Date.parse(b.startsAt), end = Date.parse(b.endsAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return json(res, 400, { error: "Pick a start and an end time." });
      if (start < Date.now() - 10 * 60e3) return json(res, 400, { error: "The start time is in the past." });
      if (end - start < 10 * 60e3) return json(res, 400, { error: "A tournament has to run for at least 10 minutes." });
      if (end - start > 90 * 864e5) return json(res, 400, { error: "A tournament can run for up to 90 days." });
      const amount = Math.round(+b.prize?.amount || 0);
      if (!(amount >= 0 && amount <= 1e8)) return json(res, 400, { error: "Prize money must be 0 or more." });
      const prize = { amount, currency: /^[A-Z]{3}$/.test(String(b.prize?.currency || "").toUpperCase()) ? String(b.prize.currency).toUpperCase() : "USD" /* any ISO 4217 code */, split: SPLITS[b.prize?.split] ? b.prize.split : "all", note: String(b.prize?.note || "").replace(/[<>]/g, "").trim().slice(0, 140) };
      // The game: a showcase game, or a ready game whose players can all reach it.
      const gameId = String(b.gameId || ""), ex = /^example-([a-z]+)$/.exec(gameId);
      let game, access = b.access === "group" ? "group" : "link", groupId = null;
      if (access === "group") {
        groupId = String(b.groupId || "");
        if (!(await store.groupMember(groupId, user.sub))) return json(res, 403, { error: "You can only run tournaments for groups you're in." });
      }
      if (ex && EXAMPLE_TITLES[ex[1]]) game = { id: gameId, title: EXAMPLE_TITLES[ex[1]] };
      else {
        const meta = /^[a-z0-9]+$/.test(gameId) && (await store.getGame(gameId));
        if (meta?.status !== "ready") return json(res, 400, { error: "Pick a game that's ready to play." });
        const vis = meta.visibility || "public";
        if (vis === "circle") return json(res, 400, { error: "That game is circle-only. Make it public, or share it with a group and run the tournament for that group." });
        if (vis === "group" && !(access === "group" && groupId === meta.groupId)) return json(res, 400, { error: "That game belongs to a group — run the tournament for that group." });
        game = { id: meta.id, title: meta.title || "Untitled game" };
      }
      if ((await store.myTournaments(user.sub)).filter((l) => l.role === "host").length >= 50) return json(res, 400, { error: "You can host up to 50 tournaments." });
      const t = await store.createTournament(user, { name, about, game, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), prize, access, groupId });
      return json(res, 200, { code: t.code });
    }
    if (url.pathname === "/api/my/tournaments") {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: "Please sign in." });
      const links = await store.myTournaments(user.sub);
      const tours = (await Promise.all(links.map((l) => store.getTournament(l.tid)))).filter(Boolean);
      return json(res, 200, { tournaments: tours.map((t) => ({ code: t.code, name: t.name, game: t.game, status: tourStatus(t), startsAt: t.startsAt, endsAt: t.endsAt, entrants: t.entrants || 0, prize: t.prize, host: t.host === user.sub })).sort((a, b) => ({ live: 0, upcoming: 1, ended: 2 })[a.status] - ({ live: 0, upcoming: 1, ended: 2 })[b.status] || (a.endsAt < b.endsAt ? -1 : 1)) });
    }
    if (parts[0] === "api" && parts[1] === "t" && parts[2]) {
      const t = await store.tournamentByCode(parts[2]);
      if (!t) return json(res, 404, { error: "This tournament link isn't valid." });
      const user = await currentUser(req);
      if (parts[3] === "score" && req.method === "POST") {
        if (!user) return json(res, 401, { error: "Sign in to compete." });
        if (tourStatus(t) !== "live") return json(res, 400, { error: tourStatus(t) === "upcoming" ? "The tournament hasn't started yet." : "The tournament has ended." });
        if (!(await store.tournamentEntry(t.tid, user.sub))) return json(res, 403, { error: "Enter the tournament first." });
        const last = runHits.get(user.sub) || 0;
        if (Date.now() - last < 5000) return json(res, 429, { error: "Slow down a little." });
        runHits.set(user.sub, Date.now());
        const b = await body(req, 2e3);
        const run = { score: Math.max(0, Math.min(1e7, Math.round(+b.score || 0))), progress: Math.max(0, Math.min(1, +b.progress || 0)), won: b.won ? 1 : 0, time: Math.max(0, Math.min(3600, +(+b.time || 0).toFixed(1))) };
        const improved = await store.recordTournamentRun(t.tid, user.sub, run);
        return json(res, 200, { improved, ...(await tourView(t, user)) });
      }
      if (req.method === "POST") {
        const action = (await body(req, 1e3)).action;
        if (action === "enter") {
          const a = await tourAccess(t, user);
          if (!a.ok) return json(res, a.reason === "signin" ? 401 : 403, { error: a.reason === "signin" ? "Sign in to enter." : "This tournament is for members of its group." });
          if (tourStatus(t) === "ended") return json(res, 400, { error: "The tournament has ended." });
          await store.enterTournament(t, user);
        } else if (action === "end") {
          if (!user || user.sub !== t.host) return json(res, 403, { error: "Only the host can end the tournament." });
          if (tourStatus(t) !== "ended") { await store.endTournamentNow(t.tid); t.endsAt = new Date().toISOString(); }
        } else return json(res, 400, { error: "Unknown action." });
        return json(res, 200, await tourView(await store.getTournament(t.tid), user));
      }
      return json(res, 200, await tourView(t, user));
    }
    // Join links: anyone can preview a group; signing in lets them join.
    if (parts[0] === "api" && parts[1] === "join" && parts[2]) {
      const g = await store.groupByCode(parts[2]);
      if (!g) return json(res, 404, { error: "This invite link isn't valid anymore. Ask for a new one." });
      const user = await currentUser(req);
      if (req.method === "POST") {
        if (!user) return json(res, 401, { error: "Please sign in to join." });
        if ((await store.myGroups(user.sub)).length >= 100) return json(res, 400, { error: "You're in a lot of groups already (100)." });
        await store.joinGroup(g, user);
        return json(res, 200, { gid: g.gid });
      }
      return json(res, 200, { name: g.name, about: g.about, ownerName: g.ownerName, members: g.members || 0, signedIn: !!user, member: !!(user && (await store.groupMember(g.gid, user.sub))), gid: g.gid });
    }
    if (url.pathname === "/api/gallery") return json(res, 200, { games: (await store.gallery(24)).map(gameCard) });
    if (url.pathname === "/api/scores") {
      const game = url.searchParams.get("game") || "";
      if (!(await knownGame(req, game))) return json(res, 404, { error: "Game not found" });
      const period = ["week", "month", "all"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "all";
      const country = COUNTRY.test(url.searchParams.get("country") || "") ? url.searchParams.get("country") : "ALL";
      if (req.method === "POST") {
        const ip = clientIp(req), now = Date.now(), hits = (scoreHits.get(ip) || []).filter((t) => now - t < 60e3);
        if (hits.length >= 12) return json(res, 429, { error: "Too many scores — slow down." });
        scoreHits.set(ip, [...hits, now]);
        const b = await body(req, 1e4);
        const entry = { name: String(b.name || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player", score: Math.max(0, Math.min(1e7, Math.round(+b.score || 0))), progress: Math.max(0, Math.min(1, +b.progress || 0)), won: b.won ? 1 : 0, time: Math.max(0, Math.min(3600, +b.time || 0)), ...(COUNTRY.test(b.country || "") ? { country: b.country } : {}) };
        const ts = await store.addScore(game, entry);
        // Where this score landed on each board (top 100), for the "you're #3 this week" message.
        const rankIn = async (opts) => (await store.topScores(game, 100, opts)).findIndex((t) => t.ts === ts) + 1 || null;
        const [week, month, all, local] = await Promise.all([rankIn({ period: "week" }), rankIn({ period: "month" }), rankIn({ period: "all" }), entry.country ? rankIn({ period: "week", country: entry.country }) : null]);
        return json(res, 200, { ts, ranks: { week, month, all, countryWeek: local }, top: await store.topScores(game, 10, { period, country }) });
      }
      return json(res, 200, { period, country, top: await store.topScores(game, 10, { period, country }) });
    }
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const b = await body(req, 1e4);
      if (!(await knownGame(req, b.game))) return json(res, 404, { error: "Game not found" });
      return json(res, 200, { room: createRoom(b.game) });
    }

    if (parts[0] === "api" && parts[1] === "projects" && /^[a-z0-9-]+$/.test(parts[2] || "")) {
      const id = parts[2], p = live.get(id), what = parts[3];
      // Studio tasks still waiting for the owner's browser (e.g. sent while the workshop was reloading).
      if (what === "pending") {
        if (p?.ownerSub && (await currentUser(req))?.sub !== p.ownerSub) return json(res, 403, { error: "Only the game's creator can watch the studio." });
        return json(res, 200, { tasks: p && !p.done ? p.events.filter((e) => e.type === "task" && p.tasks[e.taskId]) : [] });
      }
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
      // Can this visitor play the game? Circle-only games also get a ticket for the game frame.
      if (what === "access") {
        const meta = await store.getGame(id);
        if (meta?.status !== "ready") return json(res, 404, { error: "Game not found." });
        const { ok, user } = await canPlay(req, meta);
        const group = meta.visibility === "group" ? await store.getGroup(meta.groupId) : null;
        if (!ok) return json(res, 403, { error: "This game is private.", private: true, by: meta.ownerName || "its creator", group: group ? group.name : null, signedIn: !!user, email: user?.email || null });
        return json(res, 200, { ok: true, visibility: meta.visibility || "public", ticket: (meta.visibility || "public") !== "public" ? playTicket(id) : null });
      }
      if (what === "visibility" && req.method === "POST") {
        const { user, meta } = await ownedGame(req, id);
        const b = await body(req, 1e3), v = b.visibility;
        if (!["public", "circle", "group"].includes(v)) return json(res, 400, { error: "Choose everyone, your circle or a group." });
        if (v === "group" && !(await store.groupMember(String(b.groupId || ""), user.sub))) return json(res, 403, { error: "You can only share with groups you're in." });
        await store.setVisibility(id, v, v === "group" ? b.groupId : null);
        // Newly circle-only: let the people already in the circle know.
        let notified = 0;
        if (v === "circle" && meta.visibility !== "circle") {
          const game = { id, title: meta.title, tagline: meta.tagline };
          const sent = await Promise.all((await store.circle(user.sub)).map((m) => sendMail({ to: m.email, replyTo: user.email, ...gameSharedEmail({ from: user.name, to: m.email, game }) }).then(() => 1, (e) => (console.error("share email:", e.message), 0))));
          notified = sent.reduce((a, b) => a + b, 0);
        }
        return json(res, 200, { ok: true, visibility: v, notified });
      }
      if (what === "workshop") {
        const { meta, game } = await ownedGame(req, id);
        const [versions, chatLog, fb] = await Promise.all([store.versions(id), store.chat(id), store.feedback(id)]);
        return json(res, 200, { id, visibility: meta.visibility || "public", groupId: meta.groupId || null, title: meta.title || game.design?.title, tagline: meta.tagline || game.design?.tagline, design: game.design, version: meta.version, liveVersion: store.liveVersionOf(meta), versions: versions.map(({ v, summary, at, score }) => ({ v, summary, at, score })), changelog: meta.changelog || [], chat: chatLog.map(({ role, text, version, at }) => ({ role, text, version, at })), feedback: fb.map(({ id, text, name, status, at, kind, reports, auto }) => ({ id, text, name, status, at, kind: kind || "idea", reports: reports || 1, auto: !!auto })), busy: !!(p && !p.done) });
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
        const fmeta = await store.getGame(id);
        if (fmeta?.status !== "ready") return json(res, 404, { error: "Game not found." });
        if (!(await canPlay(req, fmeta)).ok) return json(res, 403, { error: "This game is private." });
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
        const gmeta = await store.getGame(id);
        if (gmeta && (gmeta.visibility || "public") !== "public" && !validTicket(id, url.searchParams.get("t")) && !(await canPlay(req, gmeta)).ok) return json(res, 403, { error: "This game is private." });
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
    if (parts[0] === "g" && /^[A-Za-z0-9]{8}$/.test(parts[1] || "")) return page("join.html");
    if (parts[0] === "t" && /^[A-Za-z0-9]{8}$/.test(parts[1] || "")) return page("tournament.html");
    if (parts[0] === "studio" && parts[1] === "groups" && /^[a-f0-9]{10}$/.test(parts[2] || "")) {
      if (!(await currentUser(req))) { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname)}` }); return res.end(); }
      return page("group.html");
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
