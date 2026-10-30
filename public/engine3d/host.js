// Sandboxed game host. Runs AI-written game code inside an opaque-origin iframe and
// talks to the studio with postMessage: load / view / test (bots) / trial / agent play.
// Opened directly (?id=… or ?example=…) it is the public play page.
import { createRuntime, DT } from "./runtime.js";
import { runBots, genericBot, SKILLS } from "./bots.js";
import { Sfx } from "./fx.js";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildModel } from "./models.js";

// Studio photo booth: renders each 3D model at a 3/4 angle for the art director to review.
let booth = null;
function renderModels(models, size = 384) {
  if (!booth) {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#2a2d3a");
    const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.8;
    scene.add(new THREE.HemisphereLight("#ffffff", "#444455", 1.2));
    const sun = new THREE.DirectionalLight("#ffffff", 2.2); sun.position.set(4, 8, 3); sun.castShadow = true; scene.add(sun);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#3a3e4f", roughness: 0.9 })); floor.receiveShadow = true; scene.add(floor);
    booth = { renderer, scene, camera: new THREE.PerspectiveCamera(35, 1, 0.05, 200), canvas };
  }
  const out = [];
  for (const def of models) {
    const obj = buildModel(def);
    obj.rotation.y = Math.PI * 0.8; // front (-Z) turned toward the camera at a 3/4 angle
    booth.scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    booth.camera.position.set(c.x + r * 1.5, c.y + r * 1.1, c.z + r * 2.4); booth.camera.lookAt(c);
    booth.renderer.render(booth.scene, booth.camera);
    out.push({ name: def.name, image: booth.canvas.toDataURL("image/jpeg", 0.8) });
    booth.scene.remove(obj);
  }
  return out;
}

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sfx = new Sfx();
let userPaused = false, best = 0;
const quiet = params.get("quiet") === "1";
const autoplay = params.get("autoplay") === "1";
let mp = null; // { seed, sendTimer, ended }
let mod = null, payload = null, rt = null, mode = "idle", paused = false, botMem = {}, agentInput = null, viewRestart = null;

async function compile(p) {
  if (p.example) return import(`./examples/${p.example}.js`);
  const url = URL.createObjectURL(new Blob([p.code], { type: "text/javascript" }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}
const meta = () => ({ controls: "move", action: "none", forward: "auto", ...(mod?.META || {}) });

// ---------- HUD ----------
let bannerTimer = null;
const ui = {
  score(n) { $("score").innerHTML = `<small>SCORE</small>${n}`; },
  lives(n) { $("lives").textContent = n > 0 ? "❤".repeat(Math.min(n, 8)) : "✖"; $("lives").style.color = "#ff4f7b"; },
  progress(p) { $("prog").style.width = (p * 100).toFixed(1) + "%"; },
  message(t, sub = "", s = 2) {
    const b = $("banner"); b.querySelector("b").textContent = t; b.querySelector("span").textContent = sub; b.classList.add("show");
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.remove("show"), s * 1000);
  },
  popup(text, x, y, color) {
    const d = document.createElement("div"); d.className = "pop"; d.textContent = text; d.style.left = x * 100 + "%"; d.style.top = y * 100 + "%"; d.style.color = color;
    $("pops").appendChild(d); setTimeout(() => d.remove(), 950);
  },
  end(won, text, st) {
    if (mp && mode === "play") {
      if (!mp.ended) { mp.ended = true; parent.postMessage({ type: "mp-end", result: { won: won ? 1 : 0, progress: +st.progress.toFixed(3), score: st.score, time: +st.time.toFixed(1) } }, "*"); }
      ui.message(won ? "FINISHED!" : "OUT!", "Waiting for the others…", 4);
      return;
    }
    if (mode === "view") { clearTimeout(viewRestart); viewRestart = setTimeout(() => mode === "view" && start("view"), 2200); return; }
    if (mode !== "play") return;
    if (st.error) parent.postMessage({ type: "runtime-error", error: st.error }, "*");
    parent.postMessage({ type: "game-end", result: { won: won ? 1 : 0, progress: +st.progress.toFixed(3), score: st.score, time: +st.time.toFixed(1) } }, "*");
    setTimeout(() => {
      $("eTitle").textContent = won ? "YOU MADE IT!" : st.error ? "OOPS!" : "GAME OVER";
      $("eSub").textContent = won ? text : st.error ? text : `Stopped by: ${text}`;
      const newBest = st.score > best;
      if (newBest) best = st.score;
      $("eStats").innerHTML = [["Score", st.score], ["Best", best], ["Time", st.time.toFixed(1) + "s"], ["Progress", Math.round(st.progress * 100) + "%"]].map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join("") + (newBest && st.score > 0 ? '<div style="flex-basis:100%;background:none;color:#ffd23f;font-weight:800">★ NEW PERSONAL BEST ★</div>' : "");
      $("end").classList.remove("hidden");
    }, 900);
  },
};

// ---------- player input (keyboard + touch) ----------
const keys = new Set(), pulse = { x: 0, y: 0, a: 0, fx: 0, fy: 0, fa: 0 };
const KEYMAP = { ArrowLeft: "l", KeyA: "l", ArrowRight: "r", KeyD: "r", ArrowUp: "u", KeyW: "u", ArrowDown: "d", KeyS: "d", Space: "a", Enter: "a", KeyJ: "a" };
addEventListener("keydown", (e) => {
  sfx.unlock();
  if (!$("intro").classList.contains("hidden") && (e.code === "Space" || e.code === "Enter")) { e.preventDefault(); return begin(); }
  if (!$("end").classList.contains("hidden") && (e.code === "Space" || e.code === "Enter" || e.code === "KeyR")) { e.preventDefault(); return again(); }
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === "KeyR" && mode === "play") again();
  if (e.code === "KeyM") { sfx.muted = !sfx.muted; $("mute").textContent = sfx.muted ? "🔇" : "🔊"; }
  if ((e.code === "KeyP" || e.code === "Escape") && mode !== "agent") togglePause();
});
addEventListener("keyup", (e) => keys.delete(KEYMAP[e.code]));
let touch = null, joy = { x: 0, y: 0 };
const stageEl = $("stage");
stageEl.addEventListener("pointerdown", (e) => { sfx.unlock(); touch = { x: e.clientX, y: e.clientY, t: performance.now(), swiped: false }; });
stageEl.addEventListener("pointermove", (e) => {
  if (!touch) return;
  const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
  if (meta().controls === "lanes") {
    if (!touch.swiped && Math.hypot(dx, dy) > 36) {
      touch.swiped = true;
      if (Math.abs(dx) > Math.abs(dy)) { pulse.x = Math.sign(dx); pulse.fx = 4; }
      else { pulse.y = -Math.sign(dy); pulse.fy = 4; if (dy < 0 && meta().action === "jump") { pulse.a = 1; pulse.fa = 4; } }
    }
  } else { joy.x = Math.max(-1, Math.min(1, dx / 60)); joy.y = Math.max(-1, Math.min(1, -dy / 60)); if (Math.hypot(dx, dy) > 14) touch.swiped = true; }
});
const endTouch = () => { if (touch && !touch.swiped && performance.now() - touch.t < 300) { pulse.a = 1; pulse.fa = 5; } touch = null; joy.x = joy.y = 0; };
stageEl.addEventListener("pointerup", endTouch); stageEl.addEventListener("pointercancel", endTouch);

function humanInput() {
  let x = (keys.has("r") ? 1 : 0) - (keys.has("l") ? 1 : 0) + joy.x, y = (keys.has("u") ? 1 : 0) - (keys.has("d") ? 1 : 0) + joy.y, action = keys.has("a");
  if (pulse.fx > 0) { x = pulse.x; pulse.fx--; } if (pulse.fy > 0) { y = pulse.y; pulse.fy--; } if (pulse.fa > 0) { action = true; pulse.fa--; }
  return { x, y, action };
}

// ---------- pause ----------
function togglePause(force) {
  userPaused = force ?? !userPaused;
  $("pause").textContent = userPaused ? "▶" : "⏸";
  $("paused").classList.toggle("hidden", !userPaused);
  if (userPaused) {
    const M = meta();
    $("mTitle").textContent = M.title || payload?.title || "";
    $("mKeys").innerHTML = [M.controlsText || (M.controls === "lanes" ? "← → change lane" : "Arrows / WASD to move"), M.action && M.action !== "none" ? `Space: ${M.action}` : ""].filter(Boolean).map((k) => `<span>${k}</span>`).join("");
    $("mSound").textContent = sfx.muted ? "🔇 Sound: off" : "🔊 Sound: on";
    $("mRestart").hidden = mode !== "play";
    $("mQuit").textContent = mp ? "🚪 Leave race" : "⏹ Quit to title";
    $("mQuit").hidden = mode !== "play";
  }
}
$("pause").onclick = (e) => { e.stopPropagation(); togglePause(); };
$("mute").onclick = (e) => { e.stopPropagation(); sfx.unlock(); sfx.muted = !sfx.muted; $("mute").textContent = sfx.muted ? "🔇" : "🔊"; };
// In-game menu (every game): resume, restart, quit, sound.
$("paused").onclick = (e) => { if (e.target === $("paused")) togglePause(false); };
$("mResume").onclick = () => { sfx.play("click"); togglePause(false); };
$("mRestart").onclick = () => { togglePause(false); again(); };
$("mQuit").onclick = () => {
  togglePause(false);
  if (mp) { parent.postMessage({ type: "mp-leave" }, "*"); mp = null; return start("view"); }
  showIntro();
};
$("mSound").onclick = () => { sfx.unlock(); sfx.muted = !sfx.muted; $("mute").textContent = sfx.muted ? "🔇" : "🔊"; $("mSound").textContent = sfx.muted ? "🔇 Sound: off" : "🔊 Sound: on"; };
$("eTitleBtn").onclick = () => { $("end").classList.add("hidden"); showIntro(); };

// ---------- game loop ----------
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!rt) return;
  if (paused || userPaused || document.hidden) { last = now; return; }
  acc += Math.min(0.1, (now - last) / 1000); last = now;
  let n = 0;
  while (acc >= DT && n++ < 6) {
    let i = { x: 0, y: 0, action: false };
    if (mode === "play") i = autoplay ? (mod.bot ? safeBot() : genericBot(rt.api, SKILLS.expert, botMem, worldMeta())) : humanInput();
    else if (mode === "view") i = mod.bot ? safeBot() : genericBot(rt.api, SKILLS.casual, botMem, worldMeta());
    else if (mode === "agent" && agentInput) i = agentInput();
    rt.setInput(i);
    rt.step(DT);
    acc -= DT;
  }
  rt.render();
}
requestAnimationFrame(frame);
const worldMeta = () => ({ ...meta(), halfWidth: (rt.api.world?.width || 12) / 2, laneW: (rt.api.world?.width || 12) / (rt.api.world?.lanes || 3) });
function safeBot() { try { return mod.bot(rt.api, SKILLS.casual, botMem) || {}; } catch { return genericBot(rt.api, SKILLS.casual, botMem, worldMeta()); } }

function start(m, seed) {
  if (m !== "play") togglePause(false);
  mode = m; botMem = {}; paused = false; agentInput = null;
  clearTimeout(viewRestart);
  $("end").classList.add("hidden"); $("intro").classList.add("hidden");
  rt?.dispose();
  stageEl.innerHTML = "";
  const canvas = document.createElement("canvas"); stageEl.appendChild(canvas);
  rt = createRuntime({ canvas, game: mod, models: payload.models, tuning: payload.tuning, seed: seed ?? (m === "play" ? (Math.random() * 1e9) | 0 : 7), ui, sfx });
  $("hud").hidden = quiet; ui.score(0); ui.lives(rt.state.lives); ui.progress(0);
  if (quiet) sfx.muted = true;
  $("tag").textContent = m === "view" && !quiet ? "🤖 Bot is playing — preview" : "";
  $("flashErr").textContent = rt.state.error ? "Game error: " + rt.state.error.message : "";
  if (rt.state.error) parent.postMessage({ type: "runtime-error", error: rt.state.error }, "*");
  const title = mod.META?.title || payload.title;
  if (m === "play" && title) ui.message(title, mod.META?.tagline || "", 2.2);
}
function showIntro() {
  const M = meta();
  $("iTitle").textContent = M.title || payload.title || "Napkin Arcade";
  $("iPitch").textContent = M.tagline || payload.pitch || "";
  const ctl = M.controlsText || (M.controls === "lanes" ? "← → change lane" : "Arrow keys / WASD to move");
  $("iKeys").innerHTML = [ctl, M.action !== "none" ? `Space: ${M.action}` : "", "Touch: swipe / drag, tap"].filter(Boolean).map((k) => `<span>${k}</span>`).join("");
  start("view");
  $("tag").textContent = "";
  $("intro").classList.remove("hidden");
}
function begin() { sfx.unlock(); sfx.play("click"); start("play"); parent.postMessage({ type: "game-start" }, "*"); }
function again() { sfx.play("click"); start("play"); parent.postMessage({ type: "game-start" }, "*"); }
$("iGo").onclick = begin; $("eGo").onclick = again;

// ---------- studio protocol ----------
function capture(w = 640) {
  rt.render();
  const src = rt.renderer.domElement, c = document.createElement("canvas");
  c.width = w; c.height = Math.round((w * src.height) / Math.max(1, src.width));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}
const AGENT_ACTIONS = { left: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 1, 0], down: [0, -1, 0], back: [0, -1, 0], action: [0, 0, 1], jump: [0, 0, 1], wait: [0, 0, 0], left_action: [-1, 0, 1], right_action: [1, 0, 1], up_left: [-1, 1, 0], up_right: [1, 1, 0] };
async function agentAct(action, seconds) {
  const [x, y, a] = AGENT_ACTIONS[action] || [0, 0, 0];
  const lanes = meta().controls === "lanes";
  let f = 0;
  agentInput = () => { f++; return lanes ? { x: f <= 4 ? x : 0, y: f <= 4 ? y : 0, action: a && f <= 6 } : { x, y, action: a && f <= 8 }; };
  const before = rt.state.events.length;
  paused = false;
  await new Promise((r) => setTimeout(r, Math.max(150, Math.min(2500, seconds * 1000))));
  paused = true; agentInput = null;
  const events = rt.state.events.slice(before).filter((e) => e.type !== "message" || true).map((e) => e.type === "hurt" ? `hit by ${e.cause}` : e.type === "message" ? `saw "${e.text}"` : e.type).slice(0, 8);
  return { events, snapshot: rt.snapshot(), frame: capture() };
}

addEventListener("message", async (ev) => {
  const m = ev.data || {};
  const reply = (data) => parent.postMessage({ taskId: m.taskId, ...data }, "*");
  try {
    switch (m.cmd) {
      case "load": {
        payload = m.payload;
        try { mod = await compile(payload); } catch (e) { return reply({ type: "loaded", error: { message: String(e.message || e) } }); }
        start(m.mode || "view");
        return reply({ type: "loaded", meta: meta(), error: rt.state.error });
      }
      case "view": return start("view");
      case "render-models": return reply({ type: "models", images: renderModels(m.models || []) });
      case "test": {
        let gm;
        try { gm = await compile(m.payload); } catch (e) { return reply({ type: "result", compileError: String(e.message || e) }); }
        const sessions = await runBots(gm, m.payload, { runs: m.runs || 6, maxTime: m.maxTime || 150 });
        return reply({ type: "result", meta: { controls: "move", action: "none", ...(gm.META || {}) }, sessions });
      }
      case "agent-start": {
        if (!mod) return reply({ type: "agent", error: "not loaded" });
        start("agent", 11); paused = true;
        $("tag").textContent = `👀 ${m.persona} is playtesting`;
        await new Promise((r) => setTimeout(r, 120));
        return reply({ type: "agent", frame: capture(), snapshot: rt.snapshot(), meta: meta() });
      }
      case "agent-act": {
        const t = $("thought"); t.innerHTML = `<em>${m.persona || ""}</em>${(m.thought || "").replace(/[<>&]/g, "")}`; t.classList.add("show");
        const out = await agentAct(m.action, +m.seconds || 0.6);
        return reply({ type: "agent", ...out });
      }
      case "agent-end": $("thought").classList.remove("show"); return start("view");
      // ---- multiplayer (the play page holds the WebSocket and relays) ----
      case "mp-lobby": mp = null; $("intro").classList.add("hidden"); return start("view");
      case "mp-start": {
        clearInterval(mp?.sendTimer);
        mp = { seed: m.seed, ended: false };
        start("play", m.seed);
        paused = true;
        $("intro").classList.add("hidden"); $("end").classList.add("hidden");
        for (const [i, t] of ["3", "2", "1"].entries()) setTimeout(() => { ui.message(t, "Get ready…", 0.9); sfx.play("click"); }, i * 1000);
        setTimeout(() => { paused = false; ui.message("GO!", "", 0.8); sfx.play("power"); }, 3000);
        mp.sendTimer = setInterval(() => {
          if (!rt || mode !== "play") return;
          const pose = rt.playerPose(); if (!pose) return;
          parent.postMessage({ type: "mp-state", s: { ...pose, score: rt.state.score, progress: +rt.state.progress.toFixed(3), status: rt.state.status, lives: rt.state.lives } }, "*");
        }, 100);
        return;
      }
      case "mp-rivals": return rt?.setRivals(m.rivals || []);
      case "best": best = Math.max(best, +m.score || 0); $("iBest").textContent = best ? `Your best: ${best}` : ""; return;
    }
  } catch (e) { reply({ type: "error", error: String(e?.message || e) }); }
});

// ---------- standalone play page ----------
(async () => {
  const id = params.get("id"), example = params.get("example");
  if (!id && !example) return parent.postMessage({ type: "ready" }, "*");
  try {
    const ex = example || (id?.startsWith("example-") ? id.slice(8) : null);
    payload = ex ? { example: ex } : await (await fetch(`../api/projects/${id}/game3d${params.get("t") ? `?t=${encodeURIComponent(params.get("t"))}` : ""}`)).json();
    if (payload.error) throw new Error(payload.error);
    mod = await compile(payload);
    if (params.get("mode") === "view" || params.get("mp") === "1") start("view");
    else if (autoplay) { sfx.muted = true; start("play"); }
    else showIntro();
    parent.postMessage({ type: "loaded", title: mod.META?.title || payload.title || "", tagline: mod.META?.tagline || payload.pitch || "" }, "*");
  } catch (e) { $("flashErr").textContent = "Could not load this game: " + e.message; }
})();
