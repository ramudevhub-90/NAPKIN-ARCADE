// Game workshop: chat with the studio (memory per game), versions/rollback, player feedback inbox.
// Live progress arrives over AppSync (Cognito-authenticated) or, locally, over SSE.
import { subscribeStudio } from "/realtime.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const id = location.pathname.split("/")[3];
const ENGINE = "/engine3d/runtime.html";
const SUGGEST = ["Make it a bit easier at the start", "Add a boss in the last stage", "Change the hero's color to bright pink", "Add a double-points power-up", "Make the game longer"];
let state = null, stopLive = null;

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  if (!r.ok) throw new Error(j.error || "Something went wrong");
  return j;
};

// ---------- sandboxed frames (preview + hidden QA lab) ----------
const pending = {};
let labReady = {};
addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.taskId && pending[d.taskId]) { pending[d.taskId](d); delete pending[d.taskId]; }
  if (d.type === "ready" && e.source === $("lab").contentWindow) labReady.resolve?.();
});
function rpc(frame, msg, timeout = 120e3) {
  return new Promise((res) => {
    const taskId = Math.random().toString(36).slice(2);
    pending[taskId] = res;
    frame.contentWindow.postMessage({ ...msg, taskId }, "*");
    setTimeout(() => { if (pending[taskId]) { delete pending[taskId]; res(null); } }, timeout);
  });
}
function resetLab() {
  labReady = {}; labReady.promise = new Promise((r) => (labReady.resolve = r));
  $("lab").src = ENGINE + "?lab=" + Date.now();
  return labReady.promise;
}
// The preview screen plays any version — the live one or a private draft — loaded by the owner's page.
let screenReady = null, previewing = null;
function resetScreen() {
  screenReady = new Promise((r) => { const h = (e) => { if (e.source === $("screen").contentWindow && e.data?.type === "ready") { removeEventListener("message", h); r(); } }; addEventListener("message", h); });
  $("screen").src = `${ENGINE}?screen=${Date.now()}`;
}
async function showPreview(v) {
  v = v || state.liveVersion;
  previewing = v;
  const r = await fetch(`/api/projects/${id}/version/${v}`);
  if (!r.ok) return;
  const payload = await r.json();
  await screenReady;
  rpc($("screen"), { cmd: "load", payload, mode: "view" }, 30e3);
  $("previewLabel").textContent = v === state.liveVersion ? `Previewing v${v} · LIVE` : v > state.liveVersion ? `Previewing v${v} · DRAFT (only you can see this)` : `Previewing v${v} · previous version`;
  renderVersions();
}

// Browser tasks the studio sends while it works on this game.
const queue = [];
let running = false;
async function runTask(t) {
  let result = null;
  await labReady.promise;
  if (t.kind === "test") {
    result = await rpc($("lab"), { cmd: "test", payload: t.data.payload, runs: t.data.runs, maxTime: t.data.maxTime }, 150e3);
    if (!result) { await resetLab(); result = { compileError: "The game froze during testing (probably an infinite loop) and was stopped." }; }
  } else if (t.kind === "render") result = await rpc($("lab"), { cmd: "render-models", models: t.data.models }, 50e3);
  await post(`/api/projects/${id}/task`, { taskId: t.taskId, result });
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) { const t = queue.shift(); try { await runTask(t); } catch {} }
  running = false;
}

// ---------- rendering ----------
function renderChat() {
  const msgs = state.chat.length ? state.chat : [{ role: "studio", text: `Hi! I'm the studio lead for “${state.title}”. Tell me what you'd like to change — gameplay, difficulty, characters, colors, new power-ups — and the team will build it, test it with bots and ship a new version. I remember everything we've changed so far.` }];
  $("chat").innerHTML = msgs.map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.version ? `<small>version ${m.version}</small>` : ""}</div>`).join("");
  $("chat").scrollTop = $("chat").scrollHeight;
}
function renderFeedback() {
  const fb = [...state.feedback].reverse();
  const pendingN = fb.filter((f) => f.status === "pending").length;
  $("fbCount").textContent = pendingN ? `(${pendingN})` : "";
  $("feedback").innerHTML = fb.length ? fb.map((f) => `<div class="fb"><div class="meta"><span><b class="kind ${f.kind}">${f.kind === "bug" ? "🐞 Bug" : "✨ Enhancement"}</b> · ${esc(f.name)} · ${new Date(f.at).toLocaleString()}${f.reports > 1 ? ` · seen ${f.reports}×` : ""}</span><span class="status ${f.status}">${f.status}</span></div>${esc(f.text)}
    ${f.status === "pending" ? `<div class="row" style="margin-top:8px"><button class="btn primary" data-approve="${f.id}">✓ Approve & apply</button><button class="btn" data-reject="${f.id}">✕ Reject</button></div>` : ""}</div>`).join("")
    : '<p class="muted">No feedback yet. Share your game — players can send feedback from the play page.</p>';
}
function renderVersions() {
  $("versions").innerHTML = [...state.versions].reverse().map((v) => {
    const live = v.v === state.liveVersion, draft = v.v > state.liveVersion;
    const pill = live ? '<span class="pill live">LIVE</span>' : draft ? '<span class="pill draft">DRAFT</span>' : '<span class="pill">previous</span>';
    const act = live ? "" : `<button class="btn ${draft ? "primary" : ""}" data-publish="${v.v}">${draft ? "Publish" : "Restore"}</button>`;
    return `<div class="${v.v === previewing ? "on" : ""}"><b>v${v.v}</b><span>${esc(v.summary)}${v.score != null ? ` <span class="muted">· fun ${v.score}</span>` : ""}</span>${pill}<span class="vbtns"><button class="btn" data-preview="${v.v}">Preview</button>${act}</span></div>`;
  }).join("");
}
function setBusy(busy, text = "") {
  $("send").disabled = busy; $("text").disabled = busy;
  document.querySelectorAll("[data-approve]").forEach((b) => (b.disabled = busy));
  $("progress").innerHTML = busy ? `<b>●</b> ${esc(text || "The studio is working… keep this page open while it tests the game.")}` : "";
}
async function load() {
  const r = await fetch(`/api/projects/${id}/workshop`);
  if (r.status === 401) return location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  const j = await r.json();
  if (!r.ok) { $("title").textContent = j.error || "Not found"; return; }
  const first = !state;
  state = j;
  $("title").textContent = j.title || "Untitled game";
  $("tagline").textContent = j.tagline || "";
  $("ver").textContent = j.version > j.liveVersion ? `live v${j.liveVersion} · draft v${j.version}` : `live v${j.liveVersion}`;
  $("playLink").href = `/play/${id}`; $("friendsLink").href = `/play/${id}?friends=1`;
  renderChat(); renderFeedback(); renderVersions();
  if (first) showPreview(j.liveVersion);
  setBusy(j.busy);
  if (j.busy) listen();
}

// Live studio events for this game (AppSync subscription, or SSE locally). Resolves once live.
async function listen() {
  if (stopLive) return;
  const sub = subscribeStudio(id, (e) => {
    if (e.type === "task") { queue.push(e); pump(); }
    if (e.type === "agent" && e.text) setBusy(true, e.text);
    if (e.type === "error") $("err").textContent = e.text;
    if (e.type === "done") { stopLive?.(); stopLive = null; setBusy(false); load().then(() => showPreview(state.version)); }
  });
  stopLive = sub.close;
  await sub.ready;
}

$("compose").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  $("err").textContent = "";
  try {
    await labReady.promise;
    setBusy(true, "Connecting to the studio…");
    await listen(); // subscribe first so no studio task is missed
    await post(`/api/projects/${id}/chat`, { text });
    $("text").value = "";
    state.chat.push({ role: "user", text }); renderChat();
    setBusy(true, "Planning the change…");
  } catch (err) { $("err").textContent = err.message; setBusy(false); stopLive?.(); stopLive = null; }
};
$("chips").innerHTML = SUGGEST.map((s) => `<button type="button">${esc(s)}</button>`).join("");
$("chips").onclick = (e) => { if (e.target.tagName === "BUTTON") { $("text").value = e.target.textContent; $("text").focus(); } };
$("tabChat").onclick = () => { $("paneChat").hidden = false; $("paneFb").hidden = true; $("tabChat").classList.add("on"); $("tabFb").classList.remove("on"); };
$("tabFb").onclick = () => { $("paneChat").hidden = true; $("paneFb").hidden = false; $("tabFb").classList.add("on"); $("tabChat").classList.remove("on"); };
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-approve],[data-reject],[data-publish],[data-preview]");
  if (!a) return;
  $("err").textContent = "";
  try {
    if (a.dataset.approve) { await labReady.promise; await listen(); await post(`/api/projects/${id}/feedback/${a.dataset.approve}`, { action: "approve" }); $("tabChat").click(); setBusy(true, "Applying the player's feedback…"); }
    if (a.dataset.reject) await post(`/api/projects/${id}/feedback/${a.dataset.reject}`, { action: "reject" });
    if (a.dataset.preview) return showPreview(+a.dataset.preview);
    if (a.dataset.publish && confirm(`${+a.dataset.publish < state.liveVersion ? "Restore" : "Publish"} version ${a.dataset.publish}? Every player will get it right away.`)) { await post(`/api/projects/${id}/publish`, { version: +a.dataset.publish }); await load(); return showPreview(+a.dataset.publish); }
    if (!a.dataset.publish) await load();
  } catch (err) { $("err").textContent = err.message; }
});

// Arrived from the feedback inbox with "Approve & apply": start it once the test lab is up.
async function approveFromInbox() {
  const fid = new URLSearchParams(location.search).get("approve");
  if (!fid) return;
  history.replaceState(null, "", location.pathname);
  const f = state?.feedback.find((x) => x.id === fid);
  if (!f || f.status !== "pending") return;
  document.querySelector(`[data-approve="${fid}"]`)?.click();
}

resetLab();
resetScreen();
load().then(approveFromInbox);
