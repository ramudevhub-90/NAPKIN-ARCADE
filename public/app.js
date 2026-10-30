// Napkin Arcade studio UI: create a project, follow the AI team live, and run the browser
// side of the studio: bot tests in a hidden sandboxed lab, vision playtests on the live screen.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const AGENTS = {
  art: ["🎨 Art director", "Nemotron Super VL"], designer: ["🧠 Creative director", "Nemotron 3 Ultra"],
  artist: ["🧊 3D artist", "Nemotron 3 Super"], developer: ["🧑‍💻 Developer", "Nemotron 3 Ultra"],
  bots: ["🤖 QA bots", "15 bots run the real code"], testers: ["👀 AI playtesters", "Super VL sees the screen"], lead: ["🧭 Studio lead", "Nemotron 3 Ultra"],
};
const SAMPLES = {
  text: "A penguin delivers pizza across floating icebergs. Seals try to steal the pizza. Collect fish for bonus points. The last level is a stormy night with icy water.",
  taxi: "Taxi racing inside a crowded neon city at night. Dodge traffic, pick up passengers, get them home before the meter runs out.",
};
const PERSONA_NAMES = { mia: "Mia, 7", joe: "Grandpa Joe", sam: "Sam, speedrunner" };
const ENGINE = "/engine3d/runtime.html";

let image = null, project = null, design = null, codeNotes = [];

// ---------- input ----------
function setImage(dataUrl) {
  image = dataUrl;
  $("preview").hidden = !dataUrl; $("dropText").hidden = !!dataUrl; $("clearImg").hidden = !dataUrl;
  if (dataUrl) $("preview").src = dataUrl;
}
$("clearImg").onclick = (e) => { e.stopPropagation(); setImage(null); $("file").value = ""; };
async function readFile(file) {
  const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = URL.createObjectURL(file); });
  const s = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  setImage(c.toDataURL("image/jpeg", 0.85));
}
$("drop").onclick = () => $("file").click();
$("file").onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
$("drop").ondragover = (e) => { e.preventDefault(); $("drop").classList.add("over"); };
$("drop").ondragleave = () => $("drop").classList.remove("over");
$("drop").ondrop = (e) => { e.preventDefault(); $("drop").classList.remove("over"); e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]); };
for (const b of document.querySelectorAll("[data-sample]")) b.onclick = async () => {
  if (b.dataset.sample === "drawing") {
    const blob = await (await fetch("samples/cat_vs_cucumbers.jpg")).blob();
    await readFile(blob); $("idea").value = "";
  } else { setImage(null); $("idea").value = SAMPLES[b.dataset.sample]; }
};

// ---------- sandboxed game frames ----------
const pending = {};
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
let labReady = {};
function resetLab() {
  labReady = {}; labReady.promise = new Promise((r) => (labReady.resolve = r));
  $("lab").src = ENGINE + "?lab=" + Date.now();
  return labReady.promise;
}
let screenReady = null;
function resetScreen() {
  screenReady = new Promise((r) => { $("screen").onload = () => setTimeout(r, 300); });
  $("screen").src = ENGINE + "?screen=" + Date.now();
  return screenReady;
}

// ---------- studio UI ----------
function log(text, cls = "") { const d = document.createElement("div"); d.className = cls; d.innerHTML = text; $("log").prepend(d); }
function setAgent(id, state, text) {
  const el = $("agent-" + id); if (!el) return;
  if (state) el.className = "agent " + state;
  if (text) el.querySelector(".t").textContent = text;
}
function buildTeam() {
  $("team").innerHTML = Object.entries(AGENTS).map(([id, [n, m]]) => `<div class="agent" id="agent-${id}"><div class="h">${n}<span class="dot"></span></div><div class="m">${m}</div><div class="t">Waiting…</div></div>`).join("");
}
const scores = [];
// The studio board fills the screen until the first playable build: idea → design → 3D models + reviews.
const board = { idea: "", design: null, models: [], reviews: {}, round: 0 };
function renderBoard() {
  const b = $("board"), d = board.design;
  if (!d) { b.innerHTML = `<span class="kick">Your idea</span><h3>${esc(board.idea || "Your drawing")}</h3><div class="wait"><i></i>The creative director (Nemotron 3 Ultra) is designing the game…</div>`; return; }
  const cast = [{ name: d.player?.name, role: "player" }, ...(d.entities || [])].filter((x) => x?.name).slice(0, 10);
  const models = board.models.length ? `<div class="models">${board.models.map((m) => { const r = board.reviews[m.name]; return `<figure><img src="${m.image}" alt="">${r ? `<span class="sc" style="color:${r >= 7 ? "var(--green)" : "var(--amber)"}">${r}/10</span>` : ""}<figcaption>${esc(m.name)}</figcaption></figure>`; }).join("")}</div>` : `<div class="wait"><i></i>The 3D artist is building the models…</div>`;
  b.innerHTML = `<span class="kick">Game design · ${esc(d.template || "")}</span><h3>${esc(d.title)}</h3><p class="tagline">${esc(d.tagline || "")}</p>
    <div class="cols"><div class="box"><b>Stages</b><ol>${(d.stages || []).slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>${d.twist ? `<b style="margin-top:10px">Twist</b>${esc(d.twist)}` : ""}<b style="margin-top:10px">Cast</b><div class="cast">${cast.map((x) => `<span class="${esc(x.role)}">${esc(x.name)}</span>`).join("")}</div></div>
    <div class="box"><b>3D models${board.round > 1 ? " · revised after review" : ""}</b>${models}</div></div>`;
}
function emptyPanels() {
  if (!scores.length) $("scores").innerHTML = '<p class="placeholder">Fun scores appear after the first bot playtest.</p>';
  if (!$("levels").textContent.trim()) $("levels").innerHTML = '<p class="placeholder">15 bots (novice, casual, expert) play every build.</p>';
}
function renderScores() { $("scores").innerHTML = scores.map((s) => `<div class="bar"><b>${s.total}</b><i style="height:${Math.max(4, s.total)}%"></i>Build ${s.build}</div>`).join(""); }
function renderReport(rep, build) {
  $("levels").innerHTML = `<div class="muted" style="font-size:12px">Build ${build}</div>` + ["novice", "casual", "expert"].filter((k) => rep[k]).map((k) => {
    const w = Math.round(rep[k].winRate * 100);
    return `<div class="lvrow"><span>${k}</span><span class="track"><i style="width:${w}%"></i></span><b>${w}%</b></div><div class="muted" style="font-size:11.5px;margin:-2px 0 6px">avg ${rep[k].avgSeconds}s · ${Math.round(rep[k].avgProgress * 100)}% through · ${rep[k].avgPickups} pickups</div>`;
  }).join("");
}
function showCode(code, note) {
  if (note) codeNotes.push(note);
  $("codeBox").hidden = false;
  $("codeTitle").textContent = `Game code written by Nemotron — ${code.split("\n").length} lines (${codeNotes.length} version${codeNotes.length > 1 ? "s" : ""})`;
  $("codeNotes").innerHTML = codeNotes.map((n, i) => `v${i + 1}: ${esc(n)}`).join("<br>");
  $("code").textContent = code;
}
function addThought(who, text, action) {
  const t = document.createElement("div");
  t.innerHTML = `<b>${esc(who)}:</b> “${esc(text)}” <span class="muted">→ ${esc(action)}</span>`;
  $("thoughts").prepend(t);
}
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json().catch(() => ({})); };

let busyScreen = false;
async function showOnScreen(payload, label) {
  if (busyScreen) return;
  await screenReady;
  const r = await rpc($("screen"), { cmd: "load", payload, mode: "view" }, 30e3);
  if (r?.error) log(`✖ Preview error: ${esc(r.error.message)}`, "err");
  if (label) $("screenLabel").textContent = label;
}

// ---------- browser tasks from the studio ----------
async function runTask(t) {
  let result = null;
  if (t.kind === "test") {
    await labReady.promise;
    result = await rpc($("lab"), { cmd: "test", payload: t.data.payload, runs: t.data.runs, maxTime: t.data.maxTime }, 150e3);
    if (!result) { await resetLab(); result = { compileError: "The game froze during testing (probably an infinite loop) and was stopped." }; }
  } else if (t.kind === "render") {
    await labReady.promise;
    result = await rpc($("lab"), { cmd: "render-models", models: t.data.models }, 50e3);
  } else if (t.kind === "playtest") {
    result = await playtest(t.data);
  }
  await post(`/api/projects/${project}/task`, { taskId: t.taskId, result });
}
const taskQueue = [];
let taskRunning = false;
async function pumpTasks() {
  if (taskRunning) return;
  taskRunning = true;
  while (taskQueue.length) { const t = taskQueue.shift(); try { await runTask(t); } catch (e) { log("✖ " + esc(e.message), "err"); await post(`/api/projects/${project}/task`, { taskId: t.taskId, result: null }); } }
  taskRunning = false;
}

// AI playtesters: Nemotron Super VL looks at the real 3D frame and chooses each move.
async function playtest({ payload, personas }) {
  busyScreen = true;
  await screenReady;
  await rpc($("screen"), { cmd: "load", payload, mode: "view" }, 30e3);
  const sessions = [];
  for (const pid of personas) {
    const name = PERSONA_NAMES[pid] || pid;
    $("screenLabel").textContent = `👀 ${name} is playtesting “${payload.title}”…`;
    let r = await rpc($("screen"), { cmd: "agent-start", persona: name }, 20e3);
    if (!r?.frame) continue;
    const meta = { title: payload.title, tagline: payload.pitch, ...(r.meta || {}) };
    const memory = [], logLines = [];
    for (let d = 0; d < 8 && r?.snapshot?.status === "playing"; d++) {
      const a = await post(`/api/projects/${project}/act`, { persona: pid, frame: r.frame, memory, meta });
      if (!a.action) break;
      addThought(name, a.thought, a.action);
      r = await rpc($("screen"), { cmd: "agent-act", action: a.action, seconds: a.seconds, thought: a.thought, persona: name }, 20e3);
      if (!r) break;
      const happened = r.events.join(", ") || "nothing special";
      logLines.push(`thought: "${a.thought}" · did: ${a.action} ${a.seconds}s · result: ${happened} · score ${r.snapshot.score}, lives ${r.snapshot.lives}, progress ${Math.round(r.snapshot.progress * 100)}%`);
      memory.push(`${a.action} → ${happened}`);
    }
    sessions.push({ persona: pid, log: logLines, outcome: r?.snapshot || null });
  }
  rpc($("screen"), { cmd: "agent-end" }, 5e3);
  busyScreen = false;
  $("screenLabel").textContent = "Playtesters are writing their notes…";
  const j = await post(`/api/projects/${project}/summary`, { title: payload.title, sessions });
  for (const t of j.testers || []) log(`<b>👀 ${esc(t.name)}</b> rated ${esc(t.fun)}/10 — ${esc(t.liked)}${t.frustrated ? `<br>Frustrated: ${esc(t.frustrated)}` : ""}<br>Suggests: ${esc(t.suggestion)}`);
  return { testers: j.testers || [] };
}

function onEvent(e) {
  switch (e.type) {
    case "agent": setAgent(e.agent, e.state, e.text); log(`<b>${AGENTS[e.agent]?.[0] || e.agent}:</b> ${esc(e.text)}`); break;
    case "design": design = e.design; board.design = e.design; renderBoard(); $("screenLabel").textContent = `“${design.title}” — ${design.tagline}`; break;
    case "code": showCode(e.code, e.note); break;
    case "modelshots": if (e.images.length) { board.models = e.images; board.round = e.round || 1; renderBoard(); } if (e.images.length) log(`<b>🧊 3D models${e.round > 1 ? " (revised)" : ""}:</b><div class="shots">${e.images.map((m) => `<figure><img src="${m.image}" alt=""><figcaption>${esc(m.name)}</figcaption></figure>`).join("")}</div>`); break;
    case "modelreviews": for (const r of e.reviews) board.reviews[r.name] = r.score; renderBoard(); log(`<b>🎨 Art review:</b> ${e.reviews.map((r) => `${esc(r.name)} ${r.score}/10${r.problems.length ? ` — ${esc(r.problems.slice(0, 2).join("; "))}` : ""}`).join("<br>")}`); break;
    case "qa": log(e.ok ? "✅ <b>QA:</b> build runs" : `🐞 <b>QA found a bug:</b> ${esc(e.problem)}`, e.ok ? "" : "err"); break;
    case "build": $("board").classList.add("off"); $("buildChip").textContent = `Build ${e.build}`; showOnScreen(e.payload, `“${e.payload.title}” — build ${e.build} (bot preview)`); break;
    case "swarm": renderReport(e.report, e.build); break;
    case "score": scores.push(e); renderScores(); break;
    case "review": log(`<b>🧭 Diagnosis:</b> ${e.diagnosis.map(esc).join(" ")}`); break;
    case "trials": log(`<b>🧪 Tested ${e.trials.length} ideas</b> (baseline ${e.baseline}): ${e.trials.map((t) => `${t.kept ? "✅" : "✖"} ${esc(t.label)} → ${t.score ?? "invalid"}`).join(" · ")}`); break;
    case "task": taskQueue.push(e); pumpTasks(); break;
    case "error": log("✖ " + esc(e.text), "err"); $("build").disabled = false; break;
    case "final": showFinal(e); break;
    case "done": $("build").disabled = false; loadMe(); break;
  }
}

let publicOrigin = location.origin;
function showFinal(e) {
  const url = `${publicOrigin}/play/${project}`;
  $("final").classList.remove("hidden");
  $("final").innerHTML = `<div><h2>Your game is live</h2><div class="big">“${esc(e.payload.title)}” · fun score ${e.total}/100</div>
    <p class="muted">${esc(e.design?.tagline || "")}</p>
    <a class="play" href="${url}" target="_blank" rel="noopener">▶ Play now</a><a class="play" style="background:var(--panel2);color:var(--ink)" href="/studio/game/${project}">💬 Keep improving it</a><code>${esc(url)}</code>
    <ul>${(e.design?.stages || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div><div id="qr"></div>`;
  if (window.qrcode) { const q = qrcode(0, "M"); q.addData(url); q.make(); $("qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2 }); }
  showOnScreen(e.payload, `“${e.payload.title}” — final build ${e.build}`);
}

$("build").onclick = async () => {
  const idea = $("idea").value.trim();
  if (!image && !idea) { $("hint").textContent = "Add a drawing or type an idea first."; return; }
  $("build").disabled = true; $("hint").textContent = "";
  $("studio").classList.remove("hidden"); buildTeam(); scores.length = 0; renderScores(); codeNotes = [];
  $("log").innerHTML = ""; $("thoughts").innerHTML = ""; $("levels").innerHTML = ""; $("final").classList.add("hidden"); $("codeBox").hidden = true;
  Object.assign(board, { idea, design: null, models: [], reviews: {}, round: 0 }); renderBoard(); $("board").classList.remove("off"); emptyPanels();
  await Promise.all([resetLab(), resetScreen()]);
  const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idea, image }) });
  const j = await r.json();
  if (r.status === 401) return location.replace("/login?next=/studio");
  if (!r.ok) { $("hint").textContent = j.error; $("build").disabled = false; return; }
  loadMe();
  project = j.id;
  $("studio").scrollIntoView({ behavior: "smooth" });
  const es = new EventSource(`/api/projects/${project}/events`);
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => es.close();
};

// Account bar and "My games".
async function loadMe() {
  const { user } = await (await fetch("/api/auth/me")).json();
  if (!user) return location.replace("/login?next=/studio");
  const left = Math.max(0, user.dailyBuilds - user.buildsToday);
  $("who").textContent = user.name; $("avatar").textContent = (user.name || "?").trim()[0].toUpperCase();
  $("buildsText").textContent = `${left} of ${user.dailyBuilds} builds left today`; $("buildsBar").style.width = `${(100 * left) / Math.max(1, user.dailyBuilds)}%`;
  $("me").hidden = false;
  const { projects = [] } = await (await fetch("/api/my/projects")).json();
  const newFb = projects.reduce((n, p) => n + (p.pendingFeedback || 0), 0);
  $("inboxCount").textContent = newFb; $("inboxCount").classList.toggle("hidden", !newFb);
  if (projects.length) $("myGames").innerHTML = projects.map((p) => `<a href="${p.ready ? `/studio/game/${p.id}` : "#"}"><b>${esc(p.title || (p.status === "failed" ? "Build failed" : "Building…"))}</b><span>${esc(p.tagline || p.idea)}</span><span>${new Date(p.created).toLocaleString()}${p.ready ? ` · v${p.version}` : ""}${p.score != null ? ` · fun ${p.score}` : ""}${p.visibility === "circle" ? " · 🔒 circle only" : ""}${p.pendingFeedback ? ` · <b style="color:var(--accent)">📬 ${p.pendingFeedback} new feedback</b>` : ""}</span></a>`).join("");
  const { groups = [] } = await (await fetch("/api/my/groups")).json();
  $("groupList").innerHTML = groups.map((g) => `<a href="/studio/groups/${g.gid}"><b>👥 ${esc(g.name)}</b><span>${esc(g.about || "")}</span><span>${g.members} ${g.members === 1 ? "member" : "members"} · ${g.owner ? "you run it" : "run by " + esc(g.ownerName)}</span></a>`).join("");
  renderTournaments(projects, groups);
  const { games: shared = [] } = await (await fetch("/api/shared")).json();
  $("shared").hidden = !shared.length;
  $("sharedGames").innerHTML = shared.map((p) => `<a href="/play/${p.id}"><b>${esc(p.title || "Untitled game")}</b><span>${esc(p.tagline || p.idea)}</span><span>🔒 by ${esc(p.by)}${p.score != null ? ` · fun ${p.score}` : ""}</span></a>`).join("");
}
// ---- tournaments ----
const SHOWCASE = [["example-runner", "Neon Cab Rush"], ["example-flyer", "Ring Rider"], ["example-arena", "Star Pup Panic"], ["example-skier", "Frost Fall"], ["example-meteors", "Meteor Mayhem"], ["example-reef", "Reef Rush"]];
const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${n}`; } };
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
// Any currency: the visitor's own first, then the common ones, then every ISO currency by name.
const REGION_CURRENCY = { IN: "INR", US: "USD", GB: "GBP", AE: "AED", SG: "SGD", AU: "AUD", CA: "CAD", JP: "JPY", CN: "CNY", HK: "HKD", KR: "KRW", ID: "IDR", MY: "MYR", PH: "PHP", TH: "THB", VN: "VND", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", ZA: "ZAR", NG: "NGN", KE: "KES", EG: "EGP", BR: "BRL", MX: "MXN", AR: "ARS", CL: "CLP", CO: "COP", NZ: "NZD", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", TR: "TRY", RU: "RUB", IL: "ILS", UA: "UAH" };
const EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
function fillCurrencies() {
  if ($("tCur").options.length) return;
  const region = (navigator.languages || []).map((l) => /-([A-Z]{2})$/i.exec(l)?.[1]?.toUpperCase()).find(Boolean) || ((Intl.DateTimeFormat().resolvedOptions().timeZone || "").startsWith("Asia/Kolkata") || (Intl.DateTimeFormat().resolvedOptions().timeZone || "").startsWith("Asia/Calcutta") ? "IN" : "US");
  const mine = EURO.includes(region) ? "EUR" : REGION_CURRENCY[region] || "USD";
  let all = []; try { all = Intl.supportedValuesOf("currency"); } catch { all = ["USD", "EUR", "GBP", "INR", "JPY"]; }
  let names; try { const d = new Intl.DisplayNames(["en"], { type: "currency" }); names = (c) => d.of(c) || c; } catch { names = (c) => c; }
  const top = [...new Set([mine, "USD", "EUR", "GBP", "INR", "AED", "SGD", "JPY", "AUD", "CAD"])];
  const opt = (c) => `<option value="${c}">${c} · ${esc(names(c))}</option>`;
  $("tCur").innerHTML = `<optgroup label="Popular">${top.map(opt).join("")}</optgroup><optgroup label="All currencies">${all.filter((c) => !top.includes(c)).sort((a, b) => names(a).localeCompare(names(b))).map(opt).join("")}</optgroup>`;
  $("tCur").value = mine;
}
async function renderTournaments(projects, groups) {
  fillCurrencies();
  const mine = projects.filter((p) => p.ready);
  $("tGame").innerHTML = (mine.length ? `<optgroup label="Your games">${mine.map((p) => `<option value="${p.id}">${esc(p.title || "Untitled game")}${p.visibility !== "public" ? ` (${p.visibility === "group" ? "group game" : "circle-only"})` : ""}</option>`).join("")}</optgroup>` : "") + `<optgroup label="Showcase games">${SHOWCASE.map(([id, t]) => `<option value="${id}">${t}</option>`).join("")}</optgroup>`;
  $("tAccess").innerHTML = '<option value="link">Anyone with the link</option>' + groups.map((g) => `<option value="group:${g.gid}">Only ${esc(g.name)} members</option>`).join("");
  if (!$("tStart").value) { const now = new Date(Date.now() + 5 * 60e3); $("tStart").value = localInput(now); $("tEnd").value = localInput(new Date(now.getTime() + 7 * 864e5)); }
  const { tournaments = [] } = await (await fetch("/api/my/tournaments")).json();
  $("tourList").innerHTML = tournaments.map((t) => `<a class="tour" href="/t/${t.code}"><span class="st ${t.status}">${t.status}</span><b>🏆 ${esc(t.name)}</b><span>🎮 ${esc(t.game.title)}</span><span>${t.prize?.amount ? money(t.prize.amount, t.prize.currency) : "Bragging rights"} · ${t.entrants} ${t.entrants === 1 ? "player" : "players"} · ${t.host ? "you host" : "you're in"}</span></a>`).join("");
}
$("hostForm").onsubmit = async (e) => {
  e.preventDefault(); $("tErr").textContent = ""; $("tCreate").disabled = true;
  const [access, groupId] = $("tAccess").value.split(":");
  const body = { name: $("tName").value, about: $("tAbout").value, gameId: $("tGame").value, startsAt: new Date($("tStart").value).toISOString(), endsAt: new Date($("tEnd").value).toISOString(), access, groupId, prize: { amount: +$("tAmount").value || 0, currency: $("tCur").value, split: $("tSplit").value, note: $("tNote").value } };
  const r = await fetch("/api/tournaments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return (location.href = `/t/${j.code}`);
  $("tErr").textContent = j.error || "Couldn't create the tournament."; $("tCreate").disabled = false;
};
$("newGroup").onsubmit = async (e) => {
  e.preventDefault(); $("groupErr").textContent = ""; $("groupCreate").disabled = true;
  const r = await fetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("groupName").value, about: $("groupAbout").value }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return (location.href = `/studio/groups/${j.gid}`);
  $("groupErr").textContent = j.error || "Couldn't create the group."; $("groupCreate").disabled = false;
};
$("logout").onclick = async () => { await fetch("/api/auth/logout", { method: "POST" }); try { localStorage.removeItem("na_tokens"); } catch {} location.href = "/"; };
loadMe();

(async () => {
  const s = await (await fetch("/api/status")).json();
  if (s.publicUrl) publicOrigin = s.publicUrl.replace(/\/$/, "");
  $("mode").textContent = s.live ? "LIVE · Nemotron on Nebius" : "OFFLINE"; $("mode").className = "badge " + (s.live ? "live" : "");
  $("hint").textContent = s.live ? "" : "The studio is offline on this server.";
})();
