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
// ---------- who can play: everyone, or my circle ----------
let members = null, groups = null;
function renderShare() {
  document.querySelectorAll('input[name="vis"]').forEach((r) => (r.checked = r.value === state.visibility));
  $("circleBox").hidden = state.visibility !== "circle";
  if (!groups) fetch("/api/my/groups").then((r) => r.json()).then((j) => { groups = j.groups || []; renderGroups(); });
  else renderGroups();
  if (state.visibility === "circle" && !members) loadCircle();
}
function renderMembers() {
  $("members").innerHTML = members.length ? members.map((m) => `<span>${esc(m.email)}<button type="button" title="Remove" data-unshare="${esc(m.email)}">✕</button></span>`).join("") : '<span class="muted" style="background:none;padding:0">No one yet — add a friend\'s email.</span>';
}
async function loadCircle(change) {
  const r = await fetch("/api/my/circle", change ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return ($("shareErr").textContent = j.error || "Something went wrong");
  $("shareErr").textContent = "";
  members = j.members; renderMembers();
  if (j.invited === true) $("shareNote").textContent = `✉️ Invite emailed to ${change.email}.`;
  if (j.invited === false) $("shareNote").textContent = `Added ${change.email}, but the invite email didn't go out — send them the ▶ Play link.`;
}
function renderGroups() {
  $("groupPick").innerHTML = groups.length ? groups.map((g) => `<option value="${g.gid}">👥 ${esc(g.name)} · ${g.members} ${g.members === 1 ? "member" : "members"}</option>`).join("") : '<option value="">You aren\'t in any groups yet — create one in the Studio</option>';
  $("groupPick").disabled = !groups.length;
  if (state.groupId) $("groupPick").value = state.groupId;
}
async function setVisibility(v) {
  $("shareErr").textContent = "";
  $("shareNote").textContent = "";
  if (v === "group" && !$("groupPick").value) { $("shareErr").textContent = "Create a group first (Studio → Groups), then share the game with it."; return renderShare(); }
  try {
    const j = await post(`/api/projects/${id}/visibility`, { visibility: v, groupId: v === "group" ? $("groupPick").value : undefined });
    state.visibility = v; state.groupId = v === "group" ? $("groupPick").value : null;
    if (v === "group") $("shareNote").textContent = `👥 Only members of ${groups.find((g) => g.gid === state.groupId)?.name || "the group"} can play this game now.`;
    if (j.notified) $("shareNote").textContent = `✉️ Emailed ${j.notified} ${j.notified === 1 ? "person" : "people"} in your circle about this game.`;
  } catch (err) { $("shareErr").textContent = err.message; }
  renderShare();
}
document.querySelectorAll('input[name="vis"]').forEach((r) => (r.onchange = () => setVisibility(r.value)));
$("groupPick").onchange = () => { if (state.visibility === "group" || document.querySelector('input[name="vis"][value="group"]').checked) setVisibility("group"); };
$("circleAdd").onsubmit = async (e) => { e.preventDefault(); await loadCircle({ email: $("circleEmail").value }); if (!$("shareErr").textContent) $("circleEmail").value = ""; };
$("members").onclick = (e) => { const b = e.target.closest("[data-unshare]"); if (b && confirm(`Remove ${b.dataset.unshare} from your circle? They'll lose access to all your circle-only games.`)) loadCircle({ email: b.dataset.unshare, remove: true }); };

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
  renderChat(); renderFeedback(); renderVersions(); renderShare(); renderPublish();
  if (first) loadStores();
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

// ---------- publish everywhere ----------
const pageUrl = () => `${location.origin}/play/${id}`;
function renderPublish() {
  const embed = `<iframe src="${pageUrl()}?embed=1" width="960" height="540" allow="autoplay; fullscreen; gamepad" style="border:0;max-width:100%" title="${(state.title || "Game").replace(/"/g, "")}"></iframe>`;
  $("embedCode").textContent = embed; $("embedCode").dataset.code = embed;
  $("pwaBuilder").href = `https://www.pwabuilder.com/reportcard?site=${encodeURIComponent(pageUrl())}`;
  const m = state.monetize || {};
  $("mAdsense").value = m.adsenseClient || ""; $("mAppAndroid").value = m.appAndroid || ""; $("mAppIos").value = m.appIos || "";
  $("mIntAndroid").value = m.interstitialAndroid || ""; $("mIntIos").value = m.interstitialIos || ""; $("mEvery").value = String(m.every || 3); $("mTest").checked = m.test !== false;
}
async function download(target, query = "") {
  const card = document.querySelector(`[data-export="${target}"]`) || $("pubAdsToggle");
  card.classList.add("busy");
  try {
    const r = await fetch(`/api/projects/${id}/export/${target}${query}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export failed");
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "")?.[1] || `${target}.zip`;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await r.blob()), download: name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) { $("err").textContent = err.message; }
  card.classList.remove("busy");
}
document.querySelectorAll("[data-export]").forEach((a) => (a.onclick = () => download(a.dataset.export)));
$("pubAdsToggle").onclick = () => { $("adForm").hidden = !$("adForm").hidden; };
$("adForm").onsubmit = (e) => {
  e.preventDefault();
  const q = new URLSearchParams({ ios: $("adIos").value.trim(), android: $("adAndroid").value.trim(), cta: $("adCta").value.trim() || "Play now", seconds: $("adSeconds").value || "30" });
  download("playable", `?${q}`);
};
$("copyEmbed").onclick = async () => { try { await navigator.clipboard.writeText($("embedCode").dataset.code); $("copyEmbed").textContent = "Copied ✓"; setTimeout(() => ($("copyEmbed").textContent = "Copy embed"), 1500); } catch {} };
$("monForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const j = await post(`/api/projects/${id}/monetize`, { adsenseClient: $("mAdsense").value, appAndroid: $("mAppAndroid").value, appIos: $("mAppIos").value, interstitialAndroid: $("mIntAndroid").value, interstitialIos: $("mIntIos").value, every: +$("mEvery").value, test: $("mTest").checked, adsenseTest: $("mTest").checked });
    state.monetize = j.monetize; renderPublish();
    const on = [j.monetize.adsenseClient && "web", (j.monetize.interstitialAndroid || j.monetize.interstitialIos) && "app"].filter(Boolean);
    $("monNote").textContent = on.length ? `✓ Saved — ${on.join(" and ")} ads on${j.monetize.test ? " (test mode)" : ""}. Re-download the mobile export to include app ads.` : "✓ Saved — no ads (fill in an id that matches Google's format to turn them on).";
  } catch (err) { $("monNote").textContent = err.message; }
};

// ---------- app stores: connect, build in the cloud, release ----------
let stores = null, storesPoll = null;
const fileText = (input) => new Promise((ok, no) => { const f = input.files?.[0]; if (!f) return no(new Error("Choose the key file.")); const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsText(f); });
const STATE = { queued: "queued", building: "building", uploading: "uploading", uploaded: "uploaded", testflight: "in TestFlight", in_review: "in review", live: "live", failed: "failed" };
async function loadStores() {
  const r = await fetch(`/api/projects/${id}/stores`);
  if (!r.ok) return;
  stores = await r.json(); renderStores();
  clearTimeout(storesPoll);
  if (stores.releases.some((x) => ["queued", "building", "uploading"].includes(x.state))) storesPoll = setTimeout(loadStores, 10000);
}
function renderStores() {
  const s = stores, box = $("storesBox");
  if (!s.enabled) { box.innerHTML = '<p class="muted" style="font-size:13px">App store connections aren\'t enabled on this server yet. The app project download above builds and signs itself with GitHub Actions.</p>'; return; }
  const conn = (key, name, c, form) => `<div class="conn"><b>${name}</b>${c.connected ? `<small class="on">✓ Connected · ${esc(c.label)}</small><button class="btn" type="button" data-disconnect="${key}">Disconnect</button>` : `<small>Not connected</small>${form}`}</div>`;
  const google = `<form class="subform" style="grid-template-columns:1fr;margin:0;padding:0;border:0;background:none" data-connect="google"><label>Service-account key (.json)<input type="file" accept=".json,application/json" name="file"></label><button class="btn primary">Connect Google Play</button></form>`;
  const apple = `<form class="subform" style="grid-template-columns:1fr;margin:0;padding:0;border:0;background:none" data-connect="apple"><label>Issuer ID<input name="issuerId" placeholder="69a6de7f-…"></label><label>Key ID<input name="keyId" maxlength="10" placeholder="ABC123DEFG"></label><label>Team ID<input name="teamId" maxlength="10" placeholder="A1B2C3D4E5"></label><label>API key (.p8)<input type="file" accept=".p8" name="file"></label><button class="btn primary">Connect App Store</button></form>`;
  const rel = (r) => `<div class="rel"><div class="head"><span>${r.platform === "ios" ? "🍎 iOS" : "🤖 Android"} ${esc(r.versionName)} <span class="muted" style="font-weight:500">(${r.versionCode})</span></span><span class="st ${r.state}">${STATE[r.state] || r.state}</span></div>
    <ol>${(r.steps || []).slice(-4).map((x) => `<li>${esc(x.text)}</li>`).join("")}</ol>
    <div class="row" style="margin-top:8px">${r.platform === "android" && r.state === "uploaded" ? `<button class="btn primary" data-rel="${r.rid}" data-act="promote">Promote to production</button>` : ""}${r.platform === "ios" && r.state === "uploaded" ? `<button class="btn" data-rel="${r.rid}" data-act="refresh">Check TestFlight</button>` : ""}${r.platform === "ios" && ["uploaded", "testflight"].includes(r.state) ? `<button class="btn primary" data-rel="${r.rid}" data-act="submit">Submit for App Review</button>` : ""}</div></div>`;
  box.innerHTML = `<div class="conns">${conn("google", "Google Play", s.google, google)}${conn("apple", "App Store Connect", s.apple, apple)}</div>
    <form class="subform" id="storeIds"><label>Android package name<input id="sAndroid" placeholder="com.yourstudio.${(state.title || "game").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "game"}" value="${esc(s.app.androidPackage)}"></label><label>iOS bundle id<input id="sIos" placeholder="com.yourstudio.${(state.title || "game").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "game"}" value="${esc(s.app.iosBundle)}"></label><button class="btn">Save store ids</button></form>
    <form class="subform" id="relForm"><label style="grid-column:1/-1">What's new (optional)<input id="relNotes" maxlength="500" placeholder="New stage, faster taxi, bug fixes"></label>
      <button class="btn primary" type="button" data-release="android" ${s.builds ? "" : "disabled"}>🚀 Android → Play internal testing</button><button class="btn primary" type="button" data-release="ios" ${s.builds ? "" : "disabled"}>🚀 iOS → TestFlight</button>
      ${s.builds ? "" : '<p class="muted" style="margin:0;font-size:12px">Cloud builds aren\'t switched on for this server yet — connections and store ids are saved; releases start once builds are enabled. Meanwhile the app project download builds itself with GitHub Actions.</p>'}</form>
    <p class="muted" id="storeNote" style="font-size:12.5px;margin:8px 0 0"></p>
    ${s.releases.map(rel).join("")}
    ${s.keystore ? `<p style="font-size:12.5px;margin:10px 0 0">🔑 <a href="/api/projects/${id}/stores/keystore">Download this game's Android upload key</a> — keep a backup; Google needs it for every update.</p>` : ""}
    <div class="outside"><b>Done outside Napkin Arcade (one time):</b> developer accounts (Google $25 once, Apple $99/year) · create the app in the Play Console and upload its first build there · create the app record in App Store Connect · store listing, content rating and privacy forms · new personal Play accounts must run a 14-day closed test with 12 testers before production.</div>`;
  box.querySelectorAll("[data-connect]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault(); $("storeNote").textContent = "";
    try {
      const text = await fileText(f.elements.file);
      const payload = f.dataset.connect === "google" ? { serviceAccount: text } : { issuerId: f.elements.issuerId.value, keyId: f.elements.keyId.value, teamId: f.elements.teamId.value, p8: text };
      await post(`/api/stores/${f.dataset.connect}`, payload); await loadStores();
    } catch (err) { $("storeNote").textContent = err.message; }
  }));
  box.querySelectorAll("[data-disconnect]").forEach((b) => (b.onclick = async () => { if (!confirm("Disconnect this store? Its key is deleted from Napkin Arcade.")) return; await fetch(`/api/stores/${b.dataset.disconnect}`, { method: "DELETE" }); loadStores(); }));
  $("storeIds").onsubmit = async (e) => { e.preventDefault(); try { await post(`/api/projects/${id}/stores`, { androidPackage: $("sAndroid").value, iosBundle: $("sIos").value }); await loadStores(); $("storeNote").textContent = "✓ Store ids saved."; } catch (err) { $("storeNote").textContent = err.message; } };
  box.querySelectorAll("[data-release]").forEach((b) => (b.onclick = async () => { $("storeNote").textContent = ""; try { await post(`/api/projects/${id}/releases`, { platform: b.dataset.release, notes: $("relNotes").value }); await loadStores(); } catch (err) { $("storeNote").textContent = err.message; } }));
  box.querySelectorAll("[data-rel]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { const j = await post(`/api/projects/${id}/releases/${b.dataset.rel}`, { action: b.dataset.act }); if (j.note) $("storeNote").textContent = j.note; await loadStores(); } catch (err) { $("storeNote").textContent = err.message; b.disabled = false; } }));
}

resetLab();
resetScreen();
load().then(approveFromInbox);
