// Star Pup Panic — example arena game for the Napkin Arcade 3D runtime.
// Free movement in an open arena: collect stars, dodge chasing ghosts, survive the waves.

export const META = {
  title: "Star Pup Panic",
  tagline: "Grab every star in Candy Park before the ghosts grab you.",
  controls: "move", action: "dash", forward: "input",
  controlsText: "Arrows / WASD move · Space dash",
};

export const TUNING = {
  lives: 3, waves: 3, starsPerWave: 8, moveSpeed: 9, dashSpeed: 24, dashTime: 0.18, dashCooldown: 1.2,
  ghostSpeed: 3.0, ghostSpeedPerWave: 0.8, ghostsPerWave: 2, arenaSize: 44, rushTime: 6, comboWindow: 2.5,
};

export const MODELS = [
  { name: "pup", colors: { main: "#f2c58a" }, parts: [
    { shape: "sphere", size: [0.62, 0.55, 0.8], pos: [0, 0.75, 0], color: "$main", mat: "fur" },
    { shape: "sphere", size: [0.48], pos: [0, 1.35, -0.55], color: "$main", mat: "fur" },
    { shape: "sphere", size: [0.2, 0.16, 0.22], pos: [0, 1.25, -0.98], color: "#fff1dc", mat: "fur" },
    { shape: "sphere", size: [0.08], pos: [0, 1.31, -1.18], color: "#1a1a1a", mat: "glass" },
    { shape: "sphere", size: [0.08], pos: [0.18, 1.48, -0.94], color: "#111111", mat: "glass", mirror: "x" },
    { shape: "sphere", size: [0.18, 0.32, 0.1], pos: [0.36, 1.68, -0.45], rot: [0, 0, -25], color: "#8a5a32", mat: "fur", mirror: "x", anim: "flap" },
    { shape: "capsule", size: [0.13, 0.3], pos: [0.3, 0.28, -0.35], color: "$main", mat: "fur", mirror: "x", anim: "swing" },
    { shape: "capsule", size: [0.13, 0.3], pos: [0.3, 0.28, 0.35], color: "$main", mat: "fur", mirror: "x", anim: "swing" },
    { shape: "torus", size: [0.3, 0.06], pos: [0, 1.0, -0.62], rot: [90, 0, 0], color: "#ff2fa0", mat: "glow", intensity: 1.2 },
  ] },
  { name: "candy ghost", colors: { main: "#b46bff" }, parts: [
    { shape: "capsule", size: [0.62, 0.7], pos: [0, 1.1, 0], color: "$main", mat: "glass", opacity: 0.9 },
    { shape: "sphere", size: [0.15, 0.2, 0.08], pos: [0.22, 1.45, -0.56], color: "#ffffff", mat: "glow", intensity: 2.5, mirror: "x" },
    { shape: "sphere", size: [0.18], pos: [0.45, 0.35, 0], color: "$main", mat: "glass", mirror: "x", anim: "bob" },
  ] },
];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "candy", layout: "arena", size: T.arenaSize, track: "candy" });
  const sx = api.mp ? (api.mp.slot - (api.mp.players - 1) / 2) * 3 : 0; // racers start apart
  G.player = api.spawn("pup", { tag: "player", pos: [sx, 0, 6] });
  G.wave = 0; G.dash = 0; G.cool = 0; G.collected = 0; G.total = T.waves * T.starsPerWave; G.face = 0; G.rush = 0; G.combo = 0; G.comboT = 0;
  api.follow(G.player, { offset: [0, 15, 12], look: [0, 0, -3], smooth: 4 });
  nextWave(api);
}

function nextWave(api) {
  const T = api.tuning, G = api.data, half = T.arenaSize / 2 - 3;
  G.wave++;
  api.message(`WAVE ${G.wave}`, G.wave === T.waves ? "Final wave!" : "Collect all the stars!", 2);
  for (let i = 0; i < T.starsPerWave; i++) api.spawn("star", { tag: "pickup", pos: [api.range(-half, half), 0.6, api.range(-half, half)] });
  api.spawn("gem", { tag: "pickup", pos: [api.range(-half, half), 0.6, api.range(-half, half)], scale: 1.5, color: "#39ff88", data: { kind: "rush" } });
  for (let i = 0; i < T.ghostsPerWave; i++) {
    const a = api.range(0, Math.PI * 2);
    const color = api.pick(["#b46bff", "#5fd3ff", "#ff5fa8"]);
    api.spawn("candy ghost", { tag: "hazard", pos: [Math.cos(a) * half, 0, Math.sin(a) * half], color, data: { kind: "ghost", wobble: api.range(0, 6), color } });
  }
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player, half = T.arenaSize / 2 - 1;

  // Move (forward = -Z) with an optional dash.
  let mx = api.input.x, mz = -api.input.y;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  G.cool -= dt;
  if (api.input.actionPressed && G.cool <= 0 && len > 0.1) { G.dash = T.dashTime; G.cool = T.dashCooldown; api.sfx("whoosh"); }
  const sp = G.dash > 0 ? T.dashSpeed : T.moveSpeed;
  if (G.dash > 0) { G.dash -= dt; api.trail(P, "#ff9ad5", { size: 0.7 }); }
  P.pos.x = api.clamp(P.pos.x + mx * sp * dt, -half, half);
  P.pos.z = api.clamp(P.pos.z + mz * sp * dt, -half, half);
  if (len > 0.1) G.face = Math.atan2(-mx, -mz);
  P.obj.rotation.y = api.damp(P.obj.rotation.y, G.face, 14, dt);
  P.pos.y = len > 0.1 ? Math.abs(Math.sin(api.time * 14)) * 0.18 : 0;

  // Ghosts drift toward the pup, faster each wave.
  const gs = T.ghostSpeed + (G.wave - 1) * T.ghostSpeedPerWave;
  const wasRush = G.rush > 0;
  G.rush = Math.max(0, G.rush - dt); G.comboT -= dt; if (G.comboT <= 0) G.combo = 0;
  for (const g of api.entities("hazard")) {
    const dx = P.pos.x - g.pos.x, dz = P.pos.z - g.pos.z, d = Math.hypot(dx, dz) || 1;
    g.data.wobble += dt;
    const flee = G.rush > 0 ? -0.7 : 1; // scared ghosts run away at reduced speed
    g.vel.set((dx / d) * gs * flee + Math.cos(g.data.wobble * 1.3) * 1.5, 0, (dz / d) * gs * flee + Math.sin(g.data.wobble) * 1.5);
    g.pos.x = api.clamp(g.pos.x, -half, half); g.pos.z = api.clamp(g.pos.z, -half, half);
    if (G.rush > 0) api.tint(g, G.rush < 1.5 && Math.floor(G.rush * 6) % 2 ? "#ffffff" : "#2f5bff", 0.6);
    else if (wasRush) api.tint(g, g.data.color, 0.2);
    g.obj.rotation.y = Math.atan2(-g.vel.x, -g.vel.z);
    g.pos.y = 0.3 + Math.sin(api.time * 3 + g.data.wobble) * 0.2;
  }

  // Collisions.
  const h = api.hits(P, "hazard");
  if (h && G.rush > 0) {
    // Eat the scared ghost: it respawns at the far wall.
    api.addScore(100, h.pos, "#2f5bff"); api.popup("GHOST +100", h.pos, "#7fa0ff"); api.explode(h.pos, "#7fa0ff");
    const a = api.range(0, Math.PI * 2); h.pos.set(Math.cos(a) * half, 0, Math.sin(a) * half);
  } else if (h && G.dash <= 0 && api.hurt("ghost")) {
    const a = Math.atan2(h.pos.z - P.pos.z, h.pos.x - P.pos.x);
    h.pos.x = api.clamp(h.pos.x + Math.cos(a) * 12, -half, half); h.pos.z = api.clamp(h.pos.z + Math.sin(a) * 12, -half, half);
  }
  const s = api.hits(P, "pickup", 0.4);
  if (s && s.data.kind === "rush") { G.rush = T.rushTime; api.message("SUGAR RUSH!", "Eat the ghosts!", 1.5); api.sfx("power"); api.flash("#39ff88", 0.3); api.collect(s, 50, "#39ff88"); }
  else if (s) {
    G.combo++; G.comboT = T.comboWindow;
    const mult = Math.min(5, G.combo);
    api.collect(s, 25 * mult, "#ffd23f"); G.collected++; api.progress(G.collected / G.total);
    if (G.combo > 1) api.popup(`x${mult} CHAIN`, P.pos, "#ff2fa0");
  }

  if (!api.entities("pickup").some((e) => e.data.kind !== "rush")) {
    for (const r of api.entities("pickup")) api.remove(r);
    if (G.wave >= T.waves) return api.win("Candy Park is safe!");
    nextWave(api);
  }
}
