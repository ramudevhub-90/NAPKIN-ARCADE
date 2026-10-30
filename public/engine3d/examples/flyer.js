// Ring Rider — example flying game for the Napkin Arcade 3D runtime.
// The ship flies forward along -Z automatically; steer in X and Y through rings, dodge rocks.

export const META = {
  title: "Ring Rider",
  tagline: "Thread the neon rings through an asteroid storm.",
  controls: "steer", action: "boost", forward: "auto",
  controlsText: "Arrows / WASD steer · Space boost",
};

export const TUNING = {
  lives: 3, length: 2200, speed: 30, boostSpeed: 52, boostTime: 1.0, boostCooldown: 3,
  steer: 14, ceiling: 9, halfWidth: 9, gap: 38, rockChance: 0.5, ringPoints: 20, shieldChance: 0.12, shieldTime: 6,
};

export const MODELS = [
  { name: "glider", colors: { main: "#3ef0ff" }, parts: [
    { shape: "capsule", size: [0.45, 2.2], pos: [0, 1, 0], rot: [90, 0, 0], color: "#e9eef7", mat: "paint" },
    { shape: "box", size: [4.6, 0.12, 1.3], pos: [0, 0.95, 0.3], round: 0.05, color: "$main", mat: "paint" },
    { shape: "box", size: [1.8, 0.1, 0.7], pos: [0, 1.0, 1.55], color: "$main", mat: "paint" },
    { shape: "box", size: [0.1, 0.8, 0.7], pos: [0, 1.4, 1.5], color: "$main", mat: "paint" },
    { shape: "sphere", size: [0.36, 0.3, 0.6], pos: [0, 1.32, -0.55], color: "#101826", mat: "glass" },
    { shape: "cylinder", size: [0.3, 0.2, 0.2], pos: [0, 1, 1.72], rot: [90, 0, 0], color: "#ff8a3d", mat: "glow", intensity: 4 },
    { shape: "box", size: [0.5, 0.06, 0.2], pos: [2.2, 0.98, 0.5], color: "#ff2fa0", mat: "glow", intensity: 3, mirror: "x" },
  ] },
];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "space", layout: "strip", width: T.halfWidth * 2, track: "none" });
  G.player = api.spawn("glider", { tag: "player", pos: [0, 4, 0] });
  G.boost = 0; G.cool = 0; G.next = -60; G.stage = 0; G.streak = 0; G.shield = 0;
  api.follow(G.player, { offset: [0, 2.6, 9], look: [0, 0.6, -14], smooth: 6 });
  api.message("LAUNCH!", "Fly through the rings", 2);
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player;
  G.cool -= dt;
  if (api.input.actionPressed && G.cool <= 0) { G.boost = T.boostTime; G.cool = T.boostCooldown; api.sfx("power"); }
  G.boost -= dt;
  const speed = G.boost > 0 ? T.boostSpeed : T.speed;
  P.pos.z -= speed * dt;
  P.pos.x = api.clamp(P.pos.x + api.input.x * T.steer * dt, -T.halfWidth, T.halfWidth);
  P.pos.y = api.clamp(P.pos.y + api.input.y * T.steer * 0.8 * dt, 0.8, T.ceiling);
  P.obj.rotation.z = api.damp(P.obj.rotation.z, -api.input.x * 0.6, 8, dt);
  P.obj.rotation.x = api.damp(P.obj.rotation.x, api.input.y * 0.3, 8, dt);
  api.speedFx(G.boost > 0 ? 1 : 0.2);
  api.trail(P, G.boost > 0 ? "#ff8a3d" : "#3ef0ff", { size: 0.6 });
  api.progress(-P.pos.z / T.length);

  const s = -P.pos.z > T.length * 0.66 ? 2 : -P.pos.z > T.length * 0.33 ? 1 : 0;
  if (s !== G.stage) { G.stage = s; api.message(`SECTOR ${s + 1}`, ["", "The storm thickens", "Core of the storm!"][s]); }

  while (G.next > P.pos.z - 220 && G.next > -T.length + 80) {
    api.spawn("ring", { tag: "pickup", pos: [api.range(-T.halfWidth + 2, T.halfWidth - 2), api.range(0.5, T.ceiling - 4), G.next], radius: 1.6, height: 4.8, data: { kind: "ring" } });
    if (api.chance(T.shieldChance)) api.spawn("gem", { tag: "pickup", scale: 1.6, color: "#39ff88", pos: [api.range(-T.halfWidth + 1, T.halfWidth - 1), api.range(1, T.ceiling - 2), G.next - 16], data: { kind: "shield" } });
    const rocks = 1 + (G.stage === 2 ? 1 : 0) + (api.chance(T.rockChance) ? 1 : 0);
    for (let i = 0; i < rocks; i++) {
      const sc = api.range(1.2, 2.6);
      api.spawn("rock", { tag: "hazard", scale: sc, pos: [api.range(-T.halfWidth, T.halfWidth), api.range(0, T.ceiling - 1), G.next - api.range(8, 22)], spin: api.range(-1, 1), vel: [api.range(-2, 2), 0, 0], data: { kind: "asteroid" } });
    }
    G.next -= T.gap * api.range(0.8, 1.2) * (1 - 0.15 * G.stage);
  }
  if (P.pos.z <= -T.length) return api.win("You rode the storm!");

  G.shield = Math.max(0, G.shield - dt);
  if (G.shield > 0) api.trail(P, "#39ff88", { size: 1.4, life: 0.2 });
  const h = api.hits(P, "hazard");
  if (h && G.shield > 0) { api.explode(h.pos, "#39ff88"); api.remove(h); api.addScore(10, P.pos, "#39ff88"); }
  else if (h && api.hurt(h.data.kind)) { api.explode(h.pos); api.remove(h); G.streak = 0; }
  const r = api.hits(P, "pickup");
  if (r && r.data.kind === "shield") { G.shield = T.shieldTime; api.message("SHIELD UP", "", 1.2); api.sfx("power"); api.collect(r, 25, "#39ff88"); }
  else if (r) {
    G.streak++;
    const mult = 1 + Math.floor(G.streak / 4);
    api.collect(r, T.ringPoints * mult, "#3ef0ff"); api.flash("#3ef0ff", 0.15);
    if (G.streak % 4 === 0) { api.popup(`PERFECT STREAK x${mult}`, P.pos, "#ff2fa0"); api.sfx("power"); }
  }
  for (const e of api.entities()) if (e !== P && e.pos.z > P.pos.z + 12) {
    if (e.data.kind === "ring") G.streak = 0; // missed a ring
    api.remove(e);
  }
}
