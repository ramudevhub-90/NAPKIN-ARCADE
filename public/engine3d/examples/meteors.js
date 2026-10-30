// Meteor Mayhem — survive three waves of falling meteors in a volcano crater.
// Red rings mark where meteors will land; grab crystals, dash out of danger.

export const META = {
  title: "Meteor Mayhem",
  tagline: "The sky is falling. Grab the crystals. Don't stand on the red rings.",
  controls: "move", action: "dash", forward: "input",
  controlsText: "Arrows / WASD move · Space dash",
};

export const TUNING = {
  lives: 3, waves: 3, waveTime: 30, arenaSize: 38, moveSpeed: 9, dashSpeed: 26, dashTime: 0.18, dashCooldown: 1.1,
  warnTime: 1.1, blastRadius: 2.6, meteorEvery: 0.6, meteorEveryPerWave: 0.17, crystalEvery: 2.2, coolTime: 5,
};

export const MODELS = [
  { name: "ember bot", colors: { main: "#3a3f52" }, parts: [
    { shape: "sphere", size: [0.62, 0.58, 0.62], pos: [0, 1.0, 0], color: "$main", mat: "metal" },
    { shape: "sphere", size: [0.3], pos: [0, 1.0, -0.42], color: "#ff8a3d", mat: "glow", intensity: 3, anim: "pulse" },
    { shape: "box", size: [0.62, 0.16, 0.12], pos: [0, 1.38, -0.5], round: 0.06, color: "#3ef0ff", mat: "glow", intensity: 3 },
    { shape: "capsule", size: [0.12, 0.35], pos: [0.3, 0.3, 0], color: "#23252f", mat: "metal", mirror: "x", anim: "swing" },
    { shape: "capsule", size: [0.1, 0.4], pos: [0.7, 1.0, 0], rot: [0, 0, 25], color: "#23252f", mat: "metal", mirror: "x", anim: "swing" },
    { shape: "cylinder", size: [0.03, 0.03, 0.5], pos: [0, 1.75, 0], color: "#9aa0b4", mat: "chrome" },
    { shape: "sphere", size: [0.09], pos: [0, 2.02, 0], color: "#ff2040", mat: "glow", intensity: 4, anim: "blink" },
  ] },
  { name: "danger ring", parts: [
    { shape: "torus", size: [2.3, 0.1], pos: [0, 0.1, 0], rot: [90, 0, 0], color: "#ff2a1a", mat: "glow", intensity: 3, anim: "pulse" },
    { shape: "cylinder", size: [2.3, 2.3, 0.02], pos: [0, 0.05, 0], color: "#ff2a1a", mat: "glass", opacity: 0.25 },
  ] },
  { name: "meteor", parts: [
    { shape: "dodeca", size: [1.1], pos: [0, 1.1, 0], color: "#2b2220", mat: "stone" },
    { shape: "icosa", size: [0.95], pos: [0, 1.1, 0], color: "#ff6a1a", mat: "glow", intensity: 1.2 },
  ] },
];

export function setup(api) {
  const T = api.tuning, G = api.data;
  api.env({ preset: "volcano", layout: "arena", size: T.arenaSize, track: "rock" });
  const sx = api.mp ? (api.mp.slot - (api.mp.players - 1) / 2) * 3 : 0; // racers start apart
  G.player = api.spawn("ember bot", { tag: "player", pos: [sx, 0, 0] });
  G.wave = 1; G.time = 0; G.nextMeteor = 2; G.nextCrystal = 0.5; G.falling = []; G.dash = 0; G.cool = 0; G.safe = 0; G.face = 0;
  api.follow(G.player, { offset: [0, 17, 13], look: [0, 0, -2], smooth: 4 });
  api.message("WAVE 1", "Watch for the red rings!", 2);
}

export function update(api, dt) {
  const T = api.tuning, G = api.data, P = G.player, half = T.arenaSize / 2 - 1.5;
  G.time += dt;
  api.progress(G.time / (T.waves * T.waveTime));
  const w = Math.min(T.waves, 1 + Math.floor(G.time / T.waveTime));
  if (w !== G.wave) { G.wave = w; api.message(`WAVE ${w}`, w === T.waves ? "Final wave — survive!" : "Faster now!", 2); api.sfx("power"); api.lives = Math.min(5, api.lives + 1); }
  if (G.time >= T.waves * T.waveTime) return api.win("You survived the meteor storm!");

  // Movement with dash.
  let mx = api.input.x, mz = -api.input.y;
  const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
  G.cool -= dt;
  if (api.input.actionPressed && G.cool <= 0 && len > 0.1) { G.dash = T.dashTime; G.cool = T.dashCooldown; api.sfx("whoosh"); }
  const sp = G.dash > 0 ? T.dashSpeed : T.moveSpeed;
  if (G.dash > 0) { G.dash -= dt; api.trail(P, "#3ef0ff", { size: 0.8 }); }
  P.pos.x = api.clamp(P.pos.x + mx * sp * dt, -half, half);
  P.pos.z = api.clamp(P.pos.z + mz * sp * dt, -half, half);
  if (len > 0.1) G.face = Math.atan2(-mx, -mz);
  P.obj.rotation.y = api.damp(P.obj.rotation.y, G.face, 14, dt);
  P.speed = len * sp;

  // Meteors: a warning ring (tagged hazard so players read it as danger), then impact.
  G.nextMeteor -= dt;
  if (G.nextMeteor <= 0) {
    G.nextMeteor = Math.max(0.25, T.meteorEvery - (G.wave - 1) * T.meteorEveryPerWave) * api.range(0.7, 1.3);
    const aim = api.chance(0.6) ? [P.pos.x + api.range(-3, 3), P.pos.z + api.range(-3, 3)] : [api.range(-half, half), api.range(-half, half)];
    const x = api.clamp(aim[0], -half, half), z = api.clamp(aim[1], -half, half);
    const ring = api.spawn("danger ring", { tag: "hazard", pos: [x, 0, z], radius: T.blastRadius, height: 3, data: { kind: "meteor", t: T.warnTime } });
    const rock = api.spawn("meteor", { tag: "prop", pos: [x + 6, 30, z - 6], spin: 3 });
    G.falling.push({ ring, rock, x, z });
  }
  for (const f of G.falling) {
    f.ring.data.t -= dt;
    const k = 1 - Math.max(0, f.ring.data.t) / T.warnTime;
    f.rock.pos.set(f.x + 6 * (1 - k), 30 * (1 - k * k), f.z - 6 * (1 - k));
    api.trail(f.rock, "#ff7a2a", { size: 1.2, life: 0.35 });
    if (f.ring.data.t <= 0) {
      api.explode(f.rock.pos, "#ff6a1a");
      if (G.safe <= 0 && Math.hypot(P.pos.x - f.x, P.pos.z - f.z) < T.blastRadius + 0.4) api.hurt("meteor");
      api.remove(f.ring); api.remove(f.rock); f.done = true;
    }
  }
  G.falling = G.falling.filter((f) => !f.done);

  // Crystals and the cooling shield.
  G.nextCrystal -= dt; G.safe = Math.max(0, G.safe - dt);
  if (G.nextCrystal <= 0) {
    G.nextCrystal = T.crystalEvery * api.range(0.7, 1.3);
    const cool = api.chance(0.12);
    api.spawn("gem", { tag: "pickup", scale: cool ? 1.5 : 1.1, color: cool ? "#3ef0ff" : "#ffd23f", pos: [api.range(-half, half), 0.5, api.range(-half, half)], data: { kind: cool ? "cool" : "crystal" } });
  }
  if (G.safe > 0) api.trail(P, "#3ef0ff", { size: 1.6, life: 0.25 });
  const c = api.hits(P, "pickup", 0.5);
  if (c?.data.kind === "cool") { G.safe = T.coolTime; api.message("HEAT SHIELD!", "Meteors can't hurt you", 1.4); api.sfx("power"); api.collect(c, 40, "#3ef0ff"); }
  else if (c) api.collect(c, 20 + 10 * G.wave, "#ffd23f");
}
