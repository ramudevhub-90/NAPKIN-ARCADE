// Frost Fall — downhill slalom. Carve between pines, pass the gates, hop the logs.

export const META = {
  title: "Frost Fall",
  tagline: "Carve the mountain, nail every gate, beat the avalanche.",
  controls: "steer", axes: "x", action: "jump", forward: "auto",
  controlsText: "← → carve · Space hop",
};

export const TUNING = {
  lives: 3, length: 2400, startSpeed: 19, maxSpeed: 34, accel: 0.35, carve: 36, grip: 7,
  halfWidth: 10, jumpPower: 9.5, gravity: 26, rowGap: 26, treeChance: 0.7, gateEvery: 3, gatePoints: 50, comboWindow: 6,
};

export const MODELS = [
  { name: "skier", colors: { main: "#e8202a" }, parts: [
    { shape: "box", size: [0.18, 0.06, 2.2], pos: [0.22, 0.03, -0.1], round: 0.03, color: "#ff2fa0", mat: "paint", mirror: "x" },
    { shape: "box", size: [0.26, 0.3, 0.4], pos: [0.22, 0.2, 0], round: 0.06, color: "#222222", mat: "rubber", mirror: "x" },
    { shape: "capsule", size: [0.13, 0.5], pos: [0.22, 0.65, 0.05], rot: [15, 0, 0], color: "#2b2f6b", mat: "cloth", mirror: "x" },
    { shape: "capsule", size: [0.32, 0.45], pos: [0, 1.32, 0.08], rot: [20, 0, 0], color: "$main", mat: "paint" },
    { shape: "box", size: [0.5, 0.12, 0.34], pos: [0, 1.72, 0.0], round: 0.05, color: "#3ef0ff", mat: "fur" },
    { shape: "capsule", size: [0.1, 0.45], pos: [0.42, 1.3, -0.08], rot: [-35, 0, 18], color: "$main", mat: "paint", mirror: "x", anim: "swing" },
    { shape: "sphere", size: [0.26], pos: [0, 1.95, -0.05], color: "#ffd2b0", mat: "skin" },
    { shape: "sphere", size: [0.29, 0.24, 0.3], pos: [0, 2.04, 0.01], color: "#ffffff", mat: "paint" },
    { shape: "box", size: [0.42, 0.12, 0.12], pos: [0, 1.98, -0.25], round: 0.05, color: "#ffb000", mat: "glow", intensity: 1.4 },
    { shape: "cylinder", size: [0.025, 0.025, 1.3], pos: [0.56, 0.75, -0.25], rot: [25, 0, 0], color: "#d9dde6", mat: "chrome", mirror: "x" },
  ] },
  { name: "snowman", parts: [
    { shape: "sphere", size: [0.8], pos: [0, 0.75, 0], color: "#f7fbff", mat: "matte" },
    { shape: "sphere", size: [0.58], pos: [0, 1.9, 0], color: "#f7fbff", mat: "matte" },
    { shape: "sphere", size: [0.42], pos: [0, 2.75, 0], color: "#f7fbff", mat: "matte" },
    { shape: "cone", size: [0.08, 0.45], pos: [0, 2.72, -0.55], rot: [-90, 0, 0], color: "#ff7a1a", mat: "plastic" },
    { shape: "sphere", size: [0.06], pos: [0.15, 2.88, -0.36], color: "#111111", mat: "glass", mirror: "x" },
    { shape: "cylinder", size: [0.32, 0.32, 0.45], pos: [0, 3.32, 0], color: "#16161c", mat: "plastic" },
    { shape: "cylinder", size: [0.5, 0.5, 0.06], pos: [0, 3.1, 0], color: "#16161c", mat: "plastic" },
    { shape: "box", size: [0.9, 0.16, 0.5], pos: [0, 2.4, 0], round: 0.06, color: "#ff2fa0", mat: "fur" },
  ] },
  { name: "log", parts: [
    { shape: "cylinder", size: [0.42, 0.42, 4.6], rot: [0, 0, 90], pos: [0, 0.42, 0], color: "#7a4f22", mat: "wood" },
    { shape: "cylinder", size: [0.36, 0.36, 4.65], rot: [0, 0, 90], pos: [0, 0.42, 0], color: "#d9b07a", mat: "wood" },
  ] },
  { name: "gate", colors: { main: "#e8202a" }, parts: [
    { shape: "cylinder", size: [0.05, 0.05, 2.3], pos: [2.4, 1.15, 0], color: "#f2f2f2", mat: "plastic", mirror: "x" },
    { shape: "box", size: [0.7, 0.5, 0.04], pos: [2.75, 1.95, 0], color: "$main", mat: "glow", intensity: 0.8, mirror: "x" },
  ] },
];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "snow", layout: "strip", width: T.halfWidth * 2, track: "none" });
  const sx = api.mp ? (api.mp.slot - (api.mp.players - 1) / 2) * 3 : 0; // racers start apart
  G.player = api.spawn("skier", { tag: "player", pos: [sx, 0, 0] });
  G.vx = 0; G.vy = 0; G.speed = T.startSpeed; G.next = -40; G.row = 0; G.stage = 0; G.combo = 0; G.comboT = 0; G.gates = [];
  api.follow(G.player, { offset: [0, 4.2, 8], look: [0, 0.8, -12] });
  api.message("DROP IN!", "Pass between the gate flags", 2);
}

function spawnRow(api, z) {
  const T = api.tuning, G = api.data;
  G.row++;
  if (G.row % T.gateEvery === 0) {
    const x = api.range(-T.halfWidth + 3, T.halfWidth - 3);
    G.gates.push({ e: api.spawn("gate", { tag: "prop", pos: [x, 0, z], color: G.row % 2 ? "#e8202a" : "#2f7fd1" }), x, z, done: false });
    return;
  }
  const n = (api.chance(0.6) ? 1 : 0) + (G.stage >= 1 ? 1 : 0) + (G.stage === 2 && api.chance(0.5) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const x = api.range(-T.halfWidth, T.halfWidth), dz = api.range(-6, 6);
    if (api.chance(0.15 + 0.05 * G.stage)) api.spawn("log", { tag: "hazard", pos: [api.clamp(x, -T.halfWidth + 2.3, T.halfWidth - 2.3), 0, z + dz], data: { kind: "log" } });
    else if (api.chance(T.treeChance)) api.spawn("pine", { tag: "hazard", scale: api.range(1.1, 1.6), pos: [x, 0, z + dz], radius: 0.9, data: { kind: "tree" } });
    else api.spawn(api.chance(0.5) ? "snowman" : "rock", { tag: "hazard", pos: [x, 0, z + dz], data: { kind: "snowman" } });
  }
  if (api.chance(0.5)) {
    const x = api.range(-T.halfWidth + 1, T.halfWidth - 1);
    for (let k = 0; k < 4; k++) api.spawn("gem", { tag: "pickup", color: "#bfe8ff", pos: [x, 0.6, z - 10 - k * 2.5], data: { kind: "flake" } });
  }
  if (api.chance(0.04)) api.spawn("heart", { tag: "pickup", scale: 1.4, pos: [api.range(-T.halfWidth + 1, T.halfWidth - 1), 0.8, z - 14], data: { kind: "cocoa" } });
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player;
  G.speed = Math.min(T.maxSpeed, G.speed + T.accel * dt);
  P.pos.z -= G.speed * dt;
  P.speed = G.speed;
  api.progress(-P.pos.z / T.length);
  api.speedFx((G.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed) * 0.7);

  // Carving: steer with momentum, lean into turns, spray snow.
  G.vx = api.damp(G.vx, api.input.x * T.carve * 0.5, T.grip, dt);
  P.pos.x = api.clamp(P.pos.x + G.vx * dt, -T.halfWidth, T.halfWidth);
  P.obj.rotation.y = -G.vx * 0.03; P.obj.rotation.z = -G.vx * 0.025;
  if (Math.abs(G.vx) > 6 && P.pos.y === 0) api.burst(P.pos, "#ffffff", { count: 2, speed: 3, life: 0.4, size: 0.6, gravity: -4 });

  if (api.input.actionPressed && P.pos.y <= 0.01) { G.vy = T.jumpPower; api.sfx("jump"); }
  G.vy -= T.gravity * dt;
  P.pos.y = Math.max(0, P.pos.y + G.vy * dt);
  if (P.pos.y === 0) G.vy = Math.max(0, G.vy);

  const s = -P.pos.z > T.length * 0.66 ? 2 : -P.pos.z > T.length * 0.33 ? 1 : 0;
  if (s !== G.stage) { G.stage = s; api.message(["", "PINE FOREST", "AVALANCHE RUN"][s], ["", "Trees close in…", "Don't stop now!"][s], 2); api.sfx("power"); if (s === 2) api.shake(0.6); }

  while (G.next > P.pos.z - 160 && G.next > -T.length + 60) { spawnRow(api, G.next); G.next -= T.rowGap * (1 - 0.15 * G.stage); }
  if (!G.finish && P.pos.z < -T.length + 140) G.finish = api.spawn("finish", { tag: "goal", scale: 1.5, pos: [0, 0, -T.length] });
  if (P.pos.z <= -T.length) return api.win("Gold medal run!");

  // Slalom gates: pass between the flags to build a combo.
  G.comboT -= dt; if (G.comboT <= 0) G.combo = 0;
  for (const g of G.gates) if (!g.done && P.pos.z < g.z) {
    g.done = true;
    if (Math.abs(P.pos.x - g.x) < 2.3) {
      G.combo++; G.comboT = T.comboWindow;
      api.addScore(T.gatePoints * G.combo, P.pos, "#3ef0ff"); api.popup(G.combo > 1 ? `GATE x${G.combo}!` : "GATE!", P.pos, "#3ef0ff"); api.sfx("coin");
      api.burst(g.e.pos, "#3ef0ff", { count: 24, speed: 6 });
    } else { G.combo = 0; api.popup("MISSED GATE", P.pos, "#ff5a5a"); }
  }
  G.gates = G.gates.filter((g) => g.z < P.pos.z + 20);

  const h = api.hits(P, "hazard");
  if (h && api.hurt(h.data.kind)) { api.burst(h.pos, "#ffffff", { count: 40, speed: 7 }); api.remove(h); G.speed *= 0.6; G.combo = 0; }
  const c = api.hits(P, "pickup", 0.4);
  if (c?.data.kind === "cocoa") { api.lives = Math.min(5, api.lives + 1); api.message("HOT COCOA!", "+1 life", 1.2); api.sfx("power"); api.collect(c, 25, "#ff3b6b"); }
  else if (c) api.collect(c, 10, "#bfe8ff");
  for (const e of api.entities()) if (e !== P && e.pos.z > P.pos.z + (e.tag === "pickup" ? 3 : 20)) api.remove(e);
}
