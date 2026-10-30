// Neon Cab Rush — example lane runner for the Napkin Arcade 3D runtime.
// The player drives forward along -Z; traffic and roadblocks fill the lanes ahead.

export const META = {
  title: "Neon Cab Rush",
  tagline: "Weave through midnight traffic and get your passenger home.",
  controls: "lanes", action: "jump", forward: "auto",
  controlsText: "← → change lane · Space hop",
};

export const TUNING = {
  lives: 3, length: 1800, startSpeed: 22, maxSpeed: 37, accel: 0.4,
  laneSnap: 12, jumpPower: 11, gravity: 30,
  rowGap: 44, trafficSpeed: 16, barrierChance: 0.15, carChance: 0.4, coinChance: 0.7,
  powerChance: 0.14, shieldTime: 6, magnetTime: 8, comboWindow: 1.6,
};

export const MODELS = [
  { name: "taxi", colors: { main: "#ffc61a" }, parts: [
    { shape: "box", size: [1.95, 0.64, 4.3], pos: [0, 0.64, 0], round: 0.24, color: "$main", mat: "paint" },
    { shape: "box", size: [1.98, 0.16, 4.0], pos: [0, 0.78, 0], color: "#ffffff", mat: "checker", color2: "#111111" },
    { shape: "box", size: [1.62, 0.56, 2.15], pos: [0, 1.2, 0.2], round: 0.2, color: "#0d141c", mat: "glass" },
    { shape: "box", size: [0.9, 0.28, 0.42], pos: [0, 1.62, 0.2], round: 0.06, color: "#fff2a8", mat: "glow", intensity: 1.4 },
    { shape: "wheel", size: [0.4, 0.32], pos: [0.9, 0.4, 1.4], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "wheel", size: [0.4, 0.32], pos: [0.9, 0.4, -1.4], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "cylinder", size: [0.22, 0.22, 0.34], pos: [0.9, 0.4, 1.4], rot: [0, 0, 90], color: "#d9dde6", mat: "chrome", mirror: "x" },
    { shape: "cylinder", size: [0.22, 0.22, 0.34], pos: [0.9, 0.4, -1.4], rot: [0, 0, 90], color: "#d9dde6", mat: "chrome", mirror: "x" },
    { shape: "box", size: [0.46, 0.15, 0.06], pos: [0.62, 0.72, -2.16], color: "#fff6d8", mat: "glow", intensity: 5, mirror: "x" },
    { shape: "box", size: [0.5, 0.13, 0.06], pos: [0.6, 0.74, 2.16], color: "#ff1030", mat: "glow", intensity: 4, mirror: "x" },
  ] },
  { name: "shield bubble", parts: [{ shape: "sphere", size: [1.8, 1.4, 2.8], pos: [0, 1.2, 0], color: "#3ef0ff", mat: "glass", opacity: 0.22, anim: "pulse" }, { shape: "torus", size: [1.9, 0.05], pos: [0, 1.2, 0], rot: [90, 0, 0], color: "#3ef0ff", mat: "glow", intensity: 2, anim: "spin" }] },
];
const POWERS = { shield: ["gem", "#3ef0ff", "SHIELD!"], magnet: ["star", "#ffd23f", "COIN MAGNET!"], life: ["heart", "#ff3b6b", "+1 LIFE"] };

const CAR_COLORS = ["#e8202a", "#2f7fd1", "#f2f2f2", "#1d1d24", "#7a3cff", "#20b07a"];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "city-night", layout: "strip", width: 12, lanes: 3, track: "road" });
  G.lane = api.mp ? [1, 0, 2][api.mp.slot % 3] : 1; // racers start in different lanes
  G.player = api.spawn("taxi", { tag: "player", pos: [api.laneX(G.lane), 0, 0] });
  G.vy = 0; G.speed = T.startSpeed; G.nextRow = -70; G.stage = 0; G.finish = null;
  G.shield = 0; G.magnet = 0; G.combo = 0; G.comboT = 0; G.bubble = null;
  api.follow(G.player, { offset: [0, 4.2, 9.5], look: [0, 1.2, -12] });
  api.message("STAGE 1", "Downtown — pick up fares!", 2.2);
}

function spawnRow(api, z) {
  const T = api.tuning, G = api.data;
  const free = api.int(0, 2); // one lane is always open
  for (let l = 0; l < 3; l++) {
    const x = api.laneX(l);
    if (l === free) {
      if (api.chance(T.powerChance)) {
        const kind = api.chance(0.15) ? "life" : api.chance(0.5) ? "shield" : "magnet";
        api.spawn(POWERS[kind][0], { tag: "pickup", pos: [x, 0.8, z], scale: 1.6, color: POWERS[kind][1], data: { kind } });
      } else if (api.chance(T.coinChance)) for (let k = 0; k < 5; k++) api.spawn("coin", { tag: "pickup", pos: [x, 0.5, z - k * 3], data: { kind: "coin" } });
    } else if (api.chance(T.barrierChance)) {
      api.spawn("barrier", { tag: "hazard", pos: [x, 0, z], data: { kind: "roadblock" } });
    } else if (api.chance(T.carChance + 0.12 * G.stage)) {
      const big = api.chance(0.2);
      api.spawn(big ? "truck" : "car", { tag: "hazard", pos: [x, 0, z], color: api.pick(CAR_COLORS), vel: [0, 0, -T.trafficSpeed], data: { kind: big ? "truck" : "traffic" } });
    }
  }
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player;

  // Drive forward, faster and faster.
  G.speed = Math.min(T.maxSpeed, G.speed + T.accel * dt);
  P.pos.z -= G.speed * dt;
  P.speed = G.speed;
  const dist = -P.pos.z;
  api.progress(dist / T.length);
  api.speedFx((G.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed));

  // Lane changes with a little body roll.
  if (api.input.left && G.lane > 0) { G.lane--; api.sfx("whoosh"); }
  if (api.input.right && G.lane < 2) { G.lane++; api.sfx("whoosh"); }
  const tx = api.laneX(G.lane), dx = tx - P.pos.x;
  P.pos.x = api.damp(P.pos.x, tx, T.laneSnap, dt);
  P.obj.rotation.y = -dx * 0.06; P.obj.rotation.z = -dx * 0.03;

  // Hop.
  if (api.input.actionPressed && P.pos.y <= 0.01) { G.vy = T.jumpPower; api.sfx("jump"); }
  G.vy -= T.gravity * dt;
  P.pos.y = Math.max(0, P.pos.y + G.vy * dt);
  if (P.pos.y === 0 && G.vy < -6) { api.burst(P.pos, "#9fb0ff", { count: 10, speed: 3 }); api.sfx("land"); }
  if (P.pos.y === 0) G.vy = Math.max(G.vy, 0);
  P.obj.rotation.x = api.clamp(G.vy * 0.015, -0.15, 0.15);

  // Stages.
  const s = dist > T.length * 0.66 ? 2 : dist > T.length * 0.33 ? 1 : 0;
  if (s !== G.stage) { G.stage = s; api.message(`STAGE ${s + 1}`, ["", "Rush hour!", "Highway madness!"][s], 2); api.sfx("power"); }

  // Fill the road ahead.
  while (G.nextRow > P.pos.z - 150 && G.nextRow > -T.length + 60) {
    spawnRow(api, G.nextRow);
    G.nextRow -= T.rowGap * (1 - 0.14 * G.stage) * api.range(0.9, 1.2);
  }
  if (!G.finish && P.pos.z < -T.length + 160) G.finish = api.spawn("finish", { tag: "goal", pos: [0, 0, -T.length] });
  if (P.pos.z <= -T.length) return api.win("Passenger delivered — 5 stars!");

  // Power-ups.
  G.shield = Math.max(0, G.shield - dt); G.magnet = Math.max(0, G.magnet - dt); G.comboT -= dt;
  if (G.comboT <= 0) G.combo = 0;
  if (G.shield > 0 && !G.bubble) G.bubble = api.spawn("shield bubble", { tag: "prop", pos: [P.pos.x, P.pos.y, P.pos.z] });
  if (G.bubble) { G.bubble.pos.copy(P.pos); G.bubble.obj.visible = G.shield > 1.5 || Math.floor(G.shield * 8) % 2 === 0; if (G.shield <= 0) { api.remove(G.bubble); G.bubble = null; } }
  if (G.magnet > 0) for (const c of api.entities("pickup")) if (c.data.kind === "coin" && c.pos.distanceTo(P.pos) < 14) c.pos.lerp(P.pos, Math.min(1, dt * 7));

  // Collisions.
  const h = api.hits(P, "hazard");
  if (h && G.shield > 0) { api.explode(h.pos, "#3ef0ff"); api.remove(h); api.addScore(15, P.pos, "#3ef0ff"); api.popup("SMASH +15", P.pos, "#3ef0ff"); }
  else if (h && api.hurt(h.data.kind)) { api.explode(h.pos); api.remove(h); G.speed *= 0.65; G.combo = 0; }
  const c = api.hits(P, "pickup", 0.3);
  if (c && c.data.kind !== "coin" && POWERS[c.data.kind]) {
    const [, color, label] = POWERS[c.data.kind];
    if (c.data.kind === "shield") G.shield = T.shieldTime;
    if (c.data.kind === "magnet") G.magnet = T.magnetTime;
    if (c.data.kind === "life") api.lives = Math.min(5, api.lives + 1);
    api.message(label, "", 1.2); api.sfx("power"); api.flash(color, 0.25); api.collect(c, 25, color);
  } else if (c) {
    G.combo++; G.comboT = T.comboWindow;
    const mult = 1 + Math.floor(G.combo / 5);
    api.collect(c, 10 * mult);
    if (G.combo % 5 === 0) { api.popup(`COMBO x${mult}`, P.pos, "#ff2fa0"); api.sfx("power"); }
  }

  // Close calls, taillight trails and cleanup.
  for (const e of api.entities()) {
    if (e === P || e === G.bubble) continue;
    if (e.tag === "hazard" && !e.data.passed && e.pos.z > P.pos.z + 2) {
      e.data.passed = true;
      if (Math.abs(e.pos.x - P.pos.x) < 4.6 && !api.invulnerable) { api.addScore(5); api.popup("CLOSE CALL +5", P.pos, "#3ef0ff"); }
    }
    if (e.pos.z > P.pos.z + (e.tag === "pickup" ? 3 : 25)) api.remove(e);
  }
  if (G.speed > T.startSpeed + 6) api.trail(P, "#ff2a4a", { size: 0.35, life: 0.25 });
}
