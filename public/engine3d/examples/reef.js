// Reef Rush — a clownfish races home through the coral reef: pearls, bubble rings,
// bobbing jellyfish, spiky pufferfish and, in the deep, a shark crossing your path.

export const META = {
  title: "Reef Rush",
  tagline: "Swim home through the reef. Chase pearls, dodge jellies, outrun the shark.",
  controls: "steer", action: "dash", forward: "auto",
  controlsText: "Arrows / WASD swim · Space dash",
};

export const TUNING = {
  lives: 3, length: 2100, speed: 18, dashSpeed: 34, dashTime: 0.6, dashCooldown: 2.5, steer: 11,
  halfWidth: 8, floor: 0.8, ceiling: 8, gap: 26, sharkEvery: 9, pearlChain: 6, comboWindow: 1.5,
};

export const MODELS = [
  { name: "clownfish", colors: { main: "#ff7a1a" }, parts: [
    { shape: "sphere", size: [0.5, 0.45, 0.9], pos: [0, 0.6, 0], color: "$main", mat: "paint" },
    { shape: "sphere", size: [0.52, 0.47, 0.13], pos: [0, 0.6, -0.35], color: "#ffffff", mat: "paint" },
    { shape: "sphere", size: [0.45, 0.4, 0.12], pos: [0, 0.6, 0.3], color: "#ffffff", mat: "paint" },
    { shape: "sphere", size: [0.13], pos: [0.27, 0.72, -0.6], color: "#ffffff", mat: "paint", mirror: "x" },
    { shape: "sphere", size: [0.07], pos: [0.33, 0.73, -0.67], color: "#111111", mat: "glass", mirror: "x" },
    { shape: "box", size: [0.06, 0.6, 0.45], pos: [0, 0.6, 0.98], round: 0.03, color: "$main", mat: "paint", anim: "bob" },
    { shape: "box", size: [0.06, 0.32, 0.5], pos: [0, 1.0, 0.05], round: 0.03, color: "$main", mat: "paint" },
    { shape: "sphere", size: [0.05, 0.2, 0.3], pos: [0.46, 0.5, -0.1], color: "$main", mat: "paint", mirror: "x", anim: "flap" },
  ] },
  { name: "jellyfish", colors: { main: "#ff6fd8" }, parts: [
    { shape: "sphere", size: [0.85, 0.6, 0.85], pos: [0, 2.0, 0], color: "$main", mat: "glass", opacity: 0.65 },
    { shape: "sphere", size: [0.5, 0.35, 0.5], pos: [0, 1.95, 0], color: "$main", mat: "glow", intensity: 1.8, anim: "pulse" },
    { shape: "capsule", size: [0.05, 1.3], pos: [0.35, 0.9, 0.2], color: "$main", mat: "glow", intensity: 1, mirror: "x", anim: "swing" },
    { shape: "capsule", size: [0.05, 1.1], pos: [0.2, 1.0, -0.3], color: "$main", mat: "glow", intensity: 1, mirror: "x", anim: "swing" },
  ] },
  { name: "pufferfish", parts: [
    { shape: "sphere", size: [0.75], pos: [0, 0.8, 0], color: "#ffd23f", mat: "paint" },
    { shape: "cone", size: [0.1, 0.4], pos: [0.78, 0.8, 0], rot: [0, 0, -90], color: "#c98a1a", mat: "plastic", mirror: "x" },
    { shape: "cone", size: [0.1, 0.4], pos: [0, 1.58, 0], color: "#c98a1a", mat: "plastic" },
    { shape: "cone", size: [0.1, 0.4], pos: [0.55, 1.35, 0.2], rot: [0, 0, -45], color: "#c98a1a", mat: "plastic", mirror: "x" },
    { shape: "cone", size: [0.1, 0.4], pos: [0.55, 0.25, 0.2], rot: [0, 0, -135], color: "#c98a1a", mat: "plastic", mirror: "x" },
    { shape: "sphere", size: [0.14], pos: [0.3, 1.0, -0.62], color: "#ffffff", mat: "paint", mirror: "x" },
    { shape: "sphere", size: [0.07], pos: [0.33, 1.0, -0.72], color: "#111111", mat: "glass", mirror: "x" },
  ] },
  { name: "shark", parts: [
    { shape: "capsule", size: [0.75, 3.2], pos: [0, 1.0, 0], rot: [90, 0, 0], color: "#6f7f92", mat: "paint" },
    { shape: "capsule", size: [0.55, 2.6], pos: [0, 0.75, 0], rot: [90, 0, 0], color: "#e9eef3", mat: "paint" },
    { shape: "pyramid", size: [0.6, 1.2], pos: [0, 2.0, 0.2], rot: [0, 45, 0], scale: [0.3, 1, 1], color: "#6f7f92", mat: "paint" },
    { shape: "box", size: [0.1, 1.4, 0.7], pos: [0, 1.2, 2.5], round: 0.05, color: "#6f7f92", mat: "paint", anim: "bob" },
    { shape: "sphere", size: [0.1], pos: [0.45, 1.25, -1.9], color: "#ff2040", mat: "glow", intensity: 3, mirror: "x" },
  ] },
  { name: "pearl", parts: [{ shape: "sphere", size: [0.3], pos: [0, 0.3, 0], color: "#fff5e6", mat: "glow", intensity: 1.3, anim: "bob" }] },
];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "underwater", layout: "strip", width: T.halfWidth * 2, track: "none" });
  const sx = api.mp ? (api.mp.slot - (api.mp.players - 1) / 2) * 3 : 0; // racers start apart
  G.player = api.spawn("clownfish", { tag: "player", pos: [sx, 3, 0] });
  G.next = -40; G.stage = 0; G.dash = 0; G.cool = 0; G.combo = 0; G.comboT = 0; G.sharkT = T.sharkEvery;
  api.follow(G.player, { offset: [0, 2.8, 8.5], look: [0, 0.4, -12], smooth: 5 });
  api.message("SWIM HOME!", "Collect pearls in a row for combos", 2);
}

function spawnSection(api, z) {
  const T = api.tuning, G = api.data;
  const px = api.range(-T.halfWidth + 1.5, T.halfWidth - 1.5), py = api.range(T.floor + 0.5, T.ceiling - 2);
  if (api.chance(0.35)) api.spawn("ring", { tag: "pickup", scale: 0.8, color: "#bff4ff", pos: [px, py - 1.8, z], radius: 1.4, height: 4, data: { kind: "ring" } });
  else for (let k = 0; k < T.pearlChain; k++) api.spawn("pearl", { tag: "pickup", pos: [px + Math.sin(k * 0.8) * 1.5, py, z - k * 2.2], data: { kind: "pearl" } });
  const n = 1 + G.stage + (api.chance(0.5) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const x = api.range(-T.halfWidth, T.halfWidth), y = api.range(T.floor - 0.8, T.ceiling - 2.5), dz = -api.range(8, 18);
    if (Math.hypot(x - px, y - py) < 2.2) continue; // keep the pearl line clear
    const jelly = api.chance(0.55);
    api.spawn(jelly ? "jellyfish" : "pufferfish", { tag: "hazard", pos: [x, y, z + dz], color: jelly ? api.pick(["#ff6fd8", "#b46bff", "#3ef0ff"]) : undefined, data: { kind: jelly ? "jellyfish" : "pufferfish", baseY: y, phase: api.range(0, 6) } });
  }
  if (api.chance(0.05)) api.spawn("heart", { tag: "pickup", scale: 1.4, pos: [api.range(-T.halfWidth + 1, T.halfWidth - 1), api.range(1.5, T.ceiling - 2), z - 12], data: { kind: "life" } });
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player;
  G.cool -= dt;
  if (api.input.actionPressed && G.cool <= 0) { G.dash = T.dashTime; G.cool = T.dashCooldown; api.sfx("whoosh"); }
  G.dash -= dt;
  const speed = G.dash > 0 ? T.dashSpeed : T.speed;
  P.pos.z -= speed * dt; P.speed = speed;
  P.pos.x = api.clamp(P.pos.x + api.input.x * T.steer * dt, -T.halfWidth, T.halfWidth);
  P.pos.y = api.clamp(P.pos.y + api.input.y * T.steer * 0.8 * dt, T.floor, T.ceiling);
  P.obj.rotation.z = api.damp(P.obj.rotation.z, -api.input.x * 0.5, 8, dt);
  P.obj.rotation.x = api.damp(P.obj.rotation.x, api.input.y * 0.35, 8, dt);
  api.speedFx(G.dash > 0 ? 0.8 : 0.1);
  if (api.chance(0.3)) api.burst(P.pos, "#dff8ff", { count: 1, speed: 1, life: 0.8, size: 0.25, gravity: 3 });
  api.progress(-P.pos.z / T.length);

  const s = -P.pos.z > T.length * 0.66 ? 2 : -P.pos.z > T.length * 0.33 ? 1 : 0;
  if (s !== G.stage) { G.stage = s; api.message(["", "JELLY FIELDS", "THE DEEP"][s], ["", "Mind the glow", "Something big is hunting…"][s], 2); api.sfx("power"); }

  while (G.next > P.pos.z - 150 && G.next > -T.length + 60) { spawnSection(api, G.next); G.next -= T.gap * (1 - 0.15 * G.stage) * api.range(0.85, 1.15); }
  if (!G.goal && P.pos.z < -T.length + 120) G.goal = api.spawn("portal", { tag: "goal", scale: 2, color: "#ffd23f", pos: [0, 0, -T.length] });
  if (P.pos.z <= -T.length) return api.win("Home sweet anemone!");

  // Bobbing jellies; in the deep, a shark sweeps across.
  for (const h of api.entities("hazard")) if (h.data.baseY != null) h.pos.y = h.data.baseY + Math.sin(api.time * 1.6 + h.data.phase) * 0.8;
  if (G.stage === 2) {
    G.sharkT -= dt;
    if (G.sharkT <= 0) {
      G.sharkT = T.sharkEvery * api.range(0.7, 1.2);
      const side = api.chance(0.5) ? 1 : -1;
      api.spawn("shark", { tag: "hazard", rotY: side * Math.PI / 2, pos: [side * (T.halfWidth + 10), api.range(T.floor, T.ceiling - 2), P.pos.z - 45], vel: [-side * 9, 0, 0], data: { kind: "shark" } });
      api.message("SHARK!", "", 1); api.sfx("boom");
    }
  }

  G.comboT -= dt; if (G.comboT <= 0) G.combo = 0;
  const h = api.hits(P, "hazard");
  if (h && api.hurt(h.data.kind)) { api.burst(h.pos, "#ff6fd8", { count: 30, speed: 6 }); if (h.data.kind !== "shark") api.remove(h); G.combo = 0; }
  const c = api.hits(P, "pickup", 0.3);
  if (c?.data.kind === "life") { api.lives = Math.min(5, api.lives + 1); api.message("+1 LIFE", "", 1); api.sfx("power"); api.collect(c, 25, "#ff3b6b"); }
  else if (c?.data.kind === "ring") { api.collect(c, 40, "#bff4ff"); api.flash("#bff4ff", 0.12); api.popup("BUBBLE RING +40", P.pos, "#bff4ff"); }
  else if (c) {
    G.combo++; G.comboT = T.comboWindow;
    const mult = 1 + Math.floor(G.combo / T.pearlChain);
    api.collect(c, 10 * mult, "#fff5e6");
    if (G.combo % T.pearlChain === 0) { api.popup(`PEARL CHAIN x${mult}`, P.pos, "#ff2fa0"); api.sfx("power"); }
  }
  for (const e of api.entities()) if (e !== P && (e.pos.z > P.pos.z + 14 || Math.abs(e.pos.x) > T.halfWidth + 14)) api.remove(e);
}
