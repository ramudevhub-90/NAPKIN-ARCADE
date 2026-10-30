// Bot playtesters: headless runs of the real game code at three skill levels.
// A generic bot reads the scene (player, hazards, pickups, goal) and dodges by predicting
// closest approach; a game may export its own `bot(api, skill)` for special mechanics.
import { createRuntime, DT } from "./runtime.js";

export const SKILLS = {
  novice: { react: 0.32, horizon: 0.9, noise: 0.14, margin: 0.1, jumpT: 0.3, dirs: 5 },
  casual: { react: 0.18, horizon: 1.5, noise: 0.05, margin: 0.35, jumpT: 0.36, dirs: 9 },
  expert: { react: 0.06, horizon: 2.4, noise: 0.0, margin: 0.6, jumpT: 0.42, dirs: 9 },
};

const DIRS9 = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const center = (e) => e.pos.y + e.height / 2;

// Lane games: pick the lane whose next hazard arrives latest.
function laneBot(api, skill, mem, meta) {
  const p = api.player, w = api.world, lanes = w?.lanes || 3;
  const laneOf = (x) => { let best = 0; for (let i = 1; i < lanes; i++) if (Math.abs(api.laneX(i) - x) < Math.abs(api.laneX(best) - x)) best = i; return best; };
  if (mem.lane == null || Math.abs(api.laneX(mem.lane) - p.pos.x) > (w.width / lanes) * 1.2) mem.lane = laneOf(p.pos.x);
  const laneW = w.width / lanes;
  const hit = (L) => {
    let t = Infinity, low = true, h0 = null;
    for (const h of api.entities("hazard")) {
      if (Math.abs(h.pos.x - api.laneX(L)) > (h.hx ?? h.radius) + (p.hx ?? p.radius) + skill.margin * 0.3) continue;
      const rz = (h.hz ?? h.radius) + (p.hz ?? p.radius), dz = p.pos.z - h.pos.z, close = h._v.z - p._v.z;
      if (dz < -rz) continue;
      const tt = close > 0.1 ? Math.max(0, (dz - rz) / close) : dz < rz + 1 ? 0 : Infinity;
      if (tt < t) { t = tt; low = h.height < 2.4; h0 = h; }
    }
    return { t, low, h: h0 };
  };
  const cur = hit(mem.lane), out = { x: 0, y: meta.forward === "input" ? 1 : 0, action: false };
  if (cur.t < skill.horizon) {
    let best = null;
    for (const L of [mem.lane - 1, mem.lane + 1]) if (L >= 0 && L < lanes) { const o = hit(L); if (o.t > 0.3 && (!best || o.t > best.o.t)) best = { L, o }; }
    if (best && best.o.t > cur.t + 0.15) { out.x = Math.sign(best.L - mem.lane); mem.lane = best.L; }
    else if (meta.action === "jump" && cur.low && cur.t < skill.jumpT) out.action = true;
  } else {
    const c = api.nearest(p, "pickup", 40);
    if (c && c.pos.z < p.pos.z - 2) { const L = laneOf(c.pos.x); if (L !== mem.lane && hit(mem.lane + Math.sign(L - mem.lane)).t > skill.horizon) { out.x = Math.sign(L - mem.lane); mem.lane += out.x; } }
  }
  return out;
}

// Free-moving and steering games: sample directions, predict, keep the safest.
function sampleBot(api, skill, mem, meta) {
  const p = api.player, steer = meta.controls === "steer";
  const hv = steer ? Math.hypot(p._v.x, p._v.y) : Math.hypot(p._v.x, p._v.z);
  mem.S = Math.max(mem.S || (steer ? 9 : 7), Math.min(40, hv));
  const S = mem.S, hazards = api.entities("hazard"), target = api.nearest(p, "pickup", 60) || api.nearest(p, "goal");
  const W = api.world, lim = W?.layout === "arena" ? W.size / 2 - 1 : (W?.width || 12) / 2;
  let best = null;
  const dirs = meta.axes === "x" ? [[0, 0], [1, 0], [-1, 0]] : DIRS9.slice(0, skill.dirs);
  for (const [dx, dy] of dirs) {
    const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    let clear = 9;
    for (const tau of [0.2, 0.45, 0.8, 1.2, 1.7, 2.3]) {
      if (tau > skill.horizon) break;
      const px = p.pos.x + ux * S * tau, py = steer ? center(p) + uy * S * 0.8 * tau : center(p), pz = steer ? p.pos.z + p._v.z * tau : p.pos.z - uy * S * tau;
      if (Math.abs(px) > lim + 0.5 || (!steer && Math.abs(pz) > lim + 0.5)) clear = Math.min(clear, -1);
      for (const h of hazards) {
        const hx = h.pos.x + h._v.x * tau, hy = center(h) + h._v.y * tau, hz = h.pos.z + h._v.z * tau;
        const d = steer ? Math.hypot(px - hx, py - hy, pz - hz) : Math.hypot(px - hx, pz - hz);
        const r = h.radius + p.radius + (steer ? Math.max(0, h.height / 2 - h.radius) * 0.5 : 0);
        clear = Math.min(clear, d - r - skill.margin * (1 - tau / 3));
      }
    }
    let score = Math.min(clear, 3) * 10;
    if (target) {
      const tx = target.pos.x - p.pos.x, tz = steer ? center(target) - center(p) : -(target.pos.z - p.pos.z), tl = Math.hypot(tx, tz) || 1;
      score += ((ux * tx + uy * tz) / tl) * 4;
    }
    if (!best || score > best.score) best = { score, dx, dy, clear };
  }
  let jump = false;
  if (meta.action === "jump" && p.pos.y < 0.05) {
    // Hop low obstacles that are about to arrive in our path.
    for (const h of hazards) {
      if (h.height > 1.3) continue;
      const dz = p.pos.z - h.pos.z, close = h._v.z - p._v.z, rz = (h.hz ?? h.radius) + (p.hz ?? p.radius);
      if (dz < -rz || close < 0.1 || Math.abs(h.pos.x - p.pos.x) > (h.hx ?? h.radius) + (p.hx ?? p.radius)) continue;
      const t = (dz - rz) / close;
      if (t < skill.jumpT && t > 0.02) { jump = true; break; }
    }
  }
  return { x: best.dx, y: best.dy, action: jump || (meta.action !== "none" && meta.action !== "jump" && best.clear < 0.3 && api.rand() < 0.5) };
}

export function genericBot(api, skill, mem, meta = {}) {
  const p = api.player;
  if (!p) return { x: 0, y: 0, action: false };
  if (mem.pulse > 0) { mem.pulse--; return mem.out; }
  if (mem.release > 0) { mem.release--; return { x: 0, y: mem.out?.y || 0, action: false }; }
  mem.clock = (mem.clock || 0) - DT;
  if (mem.clock > 0) return mem.hold || { x: 0, y: 0, action: false };
  mem.clock = skill.react * (0.7 + api.rand() * 0.6);
  const lanes = meta.controls === "lanes";
  let out = lanes ? laneBot(api, skill, mem, meta) : sampleBot(api, skill, mem, meta);
  if (api.rand() < skill.noise) out = { x: api.pick([-1, 0, 1]), y: lanes ? out.y : api.pick([-1, 0, 1]), action: api.rand() < 0.2 };
  if (lanes && (out.x !== 0 || out.action)) { mem.pulse = 3; mem.release = 4; mem.out = out; mem.hold = { x: 0, y: out.y, action: false }; return out; }
  mem.hold = out;
  return out;
}

// Play one session headless; returns telemetry.
export function playSession(gameModule, payload, skillName, seed, maxTime = 150) {
  const skill = SKILLS[skillName];
  const rt = createRuntime({ game: gameModule, models: payload.models, tuning: payload.tuning, seed });
  const meta = { controls: "move", action: "none", forward: "auto", ...(gameModule.META || {}) };
  const mem = {};
  let steps = 0;
  const maxSteps = Math.round(maxTime / DT);
  while (rt.state.status === "playing" && steps < maxSteps) {
    let i;
    try { i = gameModule.bot ? gameModule.bot(rt.api, skill, mem) : genericBot(rt.api, skill, mem, meta); }
    catch { i = genericBot(rt.api, skill, mem, meta); }
    rt.setInput(i || {});
    rt.step(DT);
    steps++;
  }
  const s = rt.snapshot();
  const hurts = rt.state.events.filter((e) => e.type === "hurt").map((e) => ({ t: e.t, cause: e.cause, progress: e.progress }));
  return { skill: skillName, seed, outcome: s.status === "playing" ? "timeout" : s.status, time: s.time, score: s.score, progress: s.progress, pickups: s.pickups, hurts, cause: s.cause, error: s.error, spawned: s.spawned, travel: s.travel, warnings: [...rt.state.warnings] };
}

// Run a batch of sessions, yielding to the browser between runs.
export async function runBots(gameModule, payload, { runs = 6, skills = ["novice", "casual", "expert"], maxTime = 150, onProgress } = {}) {
  const results = [];
  let k = 0;
  for (const s of skills) for (let i = 0; i < runs; i++) {
    results.push(playSession(gameModule, payload, s, 1000 + i * 77 + k, maxTime));
    onProgress?.(++k / (skills.length * runs));
    await new Promise((r) => setTimeout(r, 0));
    if (results.at(-1).error) return results; // crashed: report immediately
  }
  return results;
}

// Multiplayer readiness, checked on every game before it ships: two racers in the same seeded
// world must both have a player, start in different spots and get the same course.
export function multiplayerCheck(gameModule, payload, seed = 4242) {
  const race = (slot) => {
    const rt = createRuntime({ game: gameModule, models: payload.models, tuning: payload.tuning, seed, mp: { slot, players: 2 } });
    const start = rt.playerPose();
    for (let i = 0; i < Math.round(3 / DT) && rt.state.status === "playing"; i++) { rt.setInput({}); rt.step(DT); }
    const s = rt.snapshot();
    return { start, error: s.error, spawned: ["hazard", "pickup", "goal"].map((t) => `${t} ${s.spawned[t] || 0}`).join(", ") };
  };
  let a, b;
  try { a = race(0); b = race(1); } catch (e) { return [`The game crashes in a 2-player race: ${e.message || e}`]; }
  const out = [];
  if (a.error || b.error) out.push(`The game crashes in a 2-player race (api.mp = { slot: ${a.error ? 0 : 1}, players: 2 }): ${(a.error || b.error).message}`);
  else if (!a.start || !b.start) out.push('Rivals are drawn from the entity tagged "player", but none exists right after setup(). Spawn the player in setup().');
  else {
    if (Math.hypot(a.start.x - b.start.x, a.start.z - b.start.z) < 1) out.push(`Both racers start at the same spot (x ${a.start.x}, z ${a.start.z}), so they sit on top of each other. In setup(), start each racer apart using api.mp.slot — e.g. lane = api.mp ? api.mp.slot % lanes : middle lane, or x = api.mp ? (api.mp.slot - (api.mp.players - 1) / 2) * 3 : 0.`);
    if (a.spawned !== b.spawned) out.push(`The two racers get different worlds (slot 0: ${a.spawned}; slot 1: ${b.spawned}). Build the course only with api.rand/api.int/api.pick, and never let api.mp change what spawns — only where the player starts.`);
  }
  return out;
}
