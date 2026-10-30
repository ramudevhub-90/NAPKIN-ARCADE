// Napkin Arcade 3D runtime: renderer + post-processing, entities, collisions, camera,
// input, scoring and game feel. AI-written games call only the `api` object.
// The same runtime runs headless (no renderer) for fast bot playtesting.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { buildModel, cloneModel, animateModel, LIBRARY } from "./models.js";
import { buildWorld, PRESETS } from "./world.js";
import { Particles } from "./fx.js";

export const DT = 1 / 60;
export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.35 }, flash: { value: new THREE.Vector4(0, 0, 0, 0) } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float amount; uniform vec4 flash; varying vec2 vUv;
    void main(){ vec2 d = vUv - 0.5; float ca = dot(d, d) * 0.006;
      vec4 c = vec4(texture2D(tDiffuse, vUv + d * ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * ca).b, 1.0);
      c.rgb *= 1.0 - dot(d, d) * amount * 2.2; c.rgb = mix(c.rgb, flash.rgb, flash.a); gl_FragColor = c; }`,
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const v3 = (a, d = [0, 0, 0]) => (a?.isVector3 ? a.clone() : new THREE.Vector3(...(Array.isArray(a) ? a.map((x, i) => +x || d[i] || 0) : d)));

export function createRuntime({ canvas = null, game, models = [], tuning = {}, seed = 1, ui = null, sfx = null, quality = 1, mp = null }) {
  const headless = !canvas;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 3000);
  camera.position.set(0, 6, 10);
  let renderer = null, composer = null, bloom = null, finish = null;
  if (!headless) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75) * quality);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 0.85);
    composer.addPass(bloom);
    finish = new ShaderPass(FinishShader); composer.addPass(finish);
    composer.addPass(new OutputPass());
  }
  const rng = mulberry32(seed);
  const T = { ...(game.TUNING || {}), ...(tuning || {}) };

  // ---- models ----
  const defs = new Map();
  for (const [k, v] of Object.entries(LIBRARY)) defs.set(norm(k), { name: k, ...v });
  for (const m of [...(Array.isArray(game.MODELS) ? game.MODELS : []), ...(models || [])]) if (m?.name) defs.set(norm(m.name), m);
  const protos = new Map(), warnings = new Set();
  function findDef(name) {
    const n = norm(name);
    if (defs.has(n)) return defs.get(n);
    for (const [k, d] of defs) if (k.includes(n) || n.includes(k)) return d;
    warnings.add(`Unknown model "${name}" (used a crate)`);
    return defs.get("crate");
  }
  function proto(name, color) {
    const key = name + "|" + (color || "");
    if (!protos.has(key)) protos.set(key, buildModel(findDef(name), color ? { main: color } : {}));
    return protos.get(key);
  }

  // ---- state ----
  const st = { spawned: {}, travel: 0, time: 0, score: 0, lives: Math.max(1, Math.round(+T.lives || 3)), status: "playing", progress: 0, cause: null, pickups: 0, hurts: 0, invuln: 0, events: [], error: null, warnings };
  const ents = [];
  let world = null, focus = new THREE.Vector3(), particles = headless ? null : new Particles(scene);
  const cam = { target: null, offset: new THREE.Vector3(0, 4.2, 9), look: new THREE.Vector3(0, 1.2, -10), smooth: 5, lookAt: new THREE.Vector3(), fov: 62, kick: 0, shake: 0 };
  let flash = { c: new THREE.Color(), a: 0 };
  const raw = { x: 0, y: 0, action: false }, prev = { x: 0, y: 0, action: false };
  const input = { x: 0, y: 0, action: false, left: false, right: false, up: false, down: false, actionPressed: false };
  const log = (type, data = {}) => { const e = { type, t: +st.time.toFixed(2), ...data }; st.events.push(e); if (st.events.length > 400) st.events.shift(); return e; };

  // Per-entity material control: models share materials, so tinting clones them first.
  function ownMaterials(e) {
    if (!e._mats) { e._mats = []; e.obj.traverse((n) => { if (n.isMesh) { n.material = n.material.clone(); e._mats.push(n.material); } }); }
    return e._mats;
  }
  function materialFacade(e) {
    const all = (fn) => ownMaterials(e).forEach(fn);
    return {
      set color(c) { const col = new THREE.Color(c); all((m) => m.color?.copy(col)); }, get color() { return ownMaterials(e)[0]?.color || new THREE.Color(); },
      set emissive(c) { const col = new THREE.Color(c); all((m) => m.emissive?.copy(col)); }, get emissive() { return ownMaterials(e)[0]?.emissive || new THREE.Color(); },
      set emissiveIntensity(v) { all((m) => { if ("emissiveIntensity" in m) m.emissiveIntensity = v; }); }, get emissiveIntensity() { return ownMaterials(e)[0]?.emissiveIntensity ?? 0; },
      set opacity(v) { all((m) => { m.transparent = v < 1; m.opacity = v; }); }, get opacity() { return ownMaterials(e)[0]?.opacity ?? 1; },
      set visible(v) { e.obj.visible = v; }, get visible() { return e.obj.visible; },
    };
  }
  const tmp = new THREE.Vector3();
  const api = {
    THREE, scene, camera, tuning: T, T, headless, data: {},
    // In a multiplayer race: this racer's start slot (0..players-1) and the number of racers; null when solo.
    mp: mp ? Object.freeze({ slot: Math.max(0, mp.slot | 0), players: Math.max(1, mp.players | 0) }) : null,
    get time() { return st.time; }, get score() { return st.score; }, get lives() { return st.lives; }, set lives(v) { st.lives = v; ui?.lives(v); },
    get status() { return st.status; }, get progressValue() { return st.progress; },
    input,
    rand: rng, range: (a, b) => a + rng() * (b - a), int: (a, b) => Math.floor(a + rng() * (b - a + 1)), pick: (arr) => arr[Math.floor(rng() * arr.length)], chance: (p) => rng() < p,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)), lerp: (a, b, t) => a + (b - a) * t, damp: (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt)),
    vec: (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z),

    env(opts = {}) {
      if (headless) {
        const lanes = Math.max(1, Math.min(6, +opts.lanes || 3)), width = Math.max(4, Math.min(60, +opts.width || 12));
        world = { layout: opts.layout === "arena" ? "arena" : "strip", width, size: +opts.size || 80, lanes, laneX: (i) => (i - (lanes - 1) / 2) * (width / lanes), update() {} };
      } else {
        world = buildWorld(scene, renderer, opts, rng);
        const p = world.preset;
        bloom.strength = p.bloom[0]; bloom.radius = p.bloom[1]; bloom.threshold = p.bloom[2];
        renderer.toneMappingExposure = p.exposure;
      }
      return world;
    },
    laneX: (i) => (world ? world.laneX(i) : (i - 1) * 4),
    get world() { return world; },

    model: (name, color) => cloneModel(proto(name, color)),
    spawn(name, o = {}) {
      const obj = typeof name === "string" ? cloneModel(proto(name, o.color)) : name;
      const s = +o.scale || 1;
      obj.scale.setScalar(s);
      obj.position.copy(v3(o.pos));
      if (o.rotY) obj.rotation.y = +o.rotY;
      const ud = obj.userData || {};
      const sz = ud.size || { x: 1, z: 1 };
      const hx = +o.radius || Math.max(0.2, (sz.x / 2) * s * 0.85), hz = +o.radius || Math.max(0.2, (sz.z / 2) * s * 0.85);
      const e = { obj, name: typeof name === "string" ? name : "custom", tag: o.tag || "prop", hx, hz, radius: +o.radius || (hx + hz) / 2, height: +o.height || (ud.height || 1) * s,
        vel: v3(o.vel), spin: +o.spin || 0, data: o.data || {}, alive: true, speed: null, _prev: obj.position.clone(), _v: new THREE.Vector3() };
      Object.defineProperty(e, "pos", { get: () => obj.position });
      if (!obj.material) Object.defineProperty(obj, "material", { get: () => materialFacade(e), configurable: true });
      scene.add(obj); ents.push(e);
      st.spawned[e.tag] = (st.spawned[e.tag] || 0) + 1;
      if (e.tag === "player" && !st.start) st.start = obj.position.clone();
      return e;
    },
    tint(e, color, glow = 0) { if (!e?.obj || headless) return; const col = new THREE.Color(color); for (const m of ownMaterials(e)) { m.color?.copy(col); if (m.emissive) { m.emissive.copy(col); m.emissiveIntensity = glow; } } },
    remove(e) {
      if (!e || !e.alive) return;
      // A pickup removed while touching the player counts as collected, however the game handles it.
      const pl = api.player;
      if (e.tag === "pickup" && pl && st.status === "playing" && api.hit(pl, e, 1.5)) { st.pickups++; log("pickup", { name: e.name }); }
      e.alive = false; scene.remove(e.obj);
    },
    entities: (tag) => ents.filter((e) => e.alive && (!tag || e.tag === tag)),
    get player() { return ents.find((e) => e.alive && e.tag === "player") || null; },
    hit(a, b, pad = 0) {
      if (!a?.alive || !b?.alive) return false;
      // Oriented-ish boxes: footprint half-extents, swapped when the model is turned sideways.
      const ext = (e) => (Math.abs(Math.sin(e.obj.rotation.y)) > 0.7 ? [e.hz, e.hx] : [e.hx, e.hz]);
      const [ax, az] = ext(a), [bx, bz] = ext(b);
      return Math.abs(a.pos.x - b.pos.x) < ax + bx + pad && Math.abs(a.pos.z - b.pos.z) < az + bz + pad && a.pos.y < b.pos.y + b.height && b.pos.y < a.pos.y + a.height;
    },
    hits(a, tag, pad = 0) { for (const e of ents) if (e !== a && e.alive && e.tag === tag && api.hit(a, e, pad)) return e; return null; },
    nearest(from, tag, maxDist = Infinity) { let best = null, bd = maxDist; for (const e of ents) if (e.alive && e.tag === tag && e !== from) { const d = e.pos.distanceTo(from.pos ?? from); if (d < bd) { bd = d; best = e; } } return best; },

    follow(e, o = {}) { cam.target = e; if (o.offset) cam.offset.copy(v3(o.offset)); if (o.look) cam.look.copy(v3(o.look)); if (o.smooth) cam.smooth = +o.smooth; if (o.fov) cam.fov = +o.fov; if (e) { camera.position.copy(e.pos).add(cam.offset); cam.lookAt.copy(e.pos).add(cam.look); } },
    speedFx(v) { cam.kick = Math.max(0, Math.min(1, +v || 0)); },
    shake(a = 0.5) { cam.shake = Math.min(2, cam.shake + a); },
    flash(color = "#ffffff", a = 0.5) { flash.c.set(color); flash.a = a; },

    addScore(n = 1, pos = null, color = "#ffd23f") { st.score += n; ui?.score(st.score); if (pos && n) api.popup(`+${n}`, pos, color); },
    collect(e, points = 10, color = "#ffd23f") { if (!e?.alive) return; api.addScore(points, e.pos, color); api.burst(e.pos, color, { count: 18, speed: 5 }); api.sfx("coin"); api.remove(e); },
    hurt(cause = "hit", pos = null) {
      if (st.invuln > 0 || st.status !== "playing") return false;
      st.lives--; st.hurts++; st.invuln = +T.invulnerable || 1.6; ui?.lives(st.lives);
      const p = pos || api.player?.pos; log("hurt", { cause, x: p ? +p.x.toFixed(1) : 0, z: p ? +p.z.toFixed(1) : 0, progress: +st.progress.toFixed(3) });
      api.shake(0.8); api.flash("#ff2040", 0.35); api.sfx("crash"); if (p) api.burst(p, "#ff7a2a", { count: 30, speed: 8 });
      if (st.lives <= 0) api.lose(cause);
      return true;
    },
    get invulnerable() { return st.invuln > 0; },
    win(text = "You win!") { if (st.status !== "playing") return; st.status = "won"; st.progress = 1; log("win"); api.sfx("win"); api.flash("#ffffff", 0.4); ui?.end(true, text, st); },
    lose(cause = "game over") { if (st.status !== "playing") return; st.status = "lost"; st.cause = cause; log("lose", { cause, progress: +st.progress.toFixed(3) }); api.sfx("lose"); ui?.end(false, cause, st); },
    progress(p) { st.progress = Math.max(0, Math.min(1, +p || 0)); ui?.progress(st.progress); },
    message(text, sub = "", seconds = 2) { log("message", { text }); ui?.message(text, sub, seconds); },
    event(name, data = {}) { log(name, data); },
    popup(text, pos, color = "#ffffff") {
      if (!ui || headless || !pos) return;
      tmp.copy(pos).add(new THREE.Vector3(0, 1.5, 0)).project(camera);
      if (tmp.z < 1) ui.popup(String(text), (tmp.x + 1) / 2, (1 - tmp.y) / 2, color);
    },
    burst(pos, color = "#ffffff", o = {}) { particles?.emit(pos, color, o); },
    explode(pos, color = "#ff7a2a") { if (!particles) return; particles.emit(pos, color, { count: 60, speed: 12, life: 0.9, size: 0.9 }); particles.emit(pos, "#ffe08a", { count: 25, speed: 6, life: 0.5, size: 1.2 }); api.shake(1.2); api.sfx("boom"); },
    trail(e, color = "#3ef0ff", o = {}) { if (particles && e?.alive) particles.emit(e.pos, color, { count: 1, speed: 0.6, life: 0.45, size: 0.45, gravity: 0, ...o }); },
    sfx(name) { if (!headless) sfx?.play(name); },
  };

  function updateCamera(dt) {
    const t = cam.target;
    if (t?.alive || t?.obj) {
      const want = tmp.copy(t.pos).add(cam.offset);
      camera.position.lerp(want, 1 - Math.exp(-cam.smooth * dt));
      cam.lookAt.lerp(new THREE.Vector3().copy(t.pos).add(cam.look), 1 - Math.exp(-cam.smooth * 1.5 * dt));
      focus.copy(t.pos);
    }
    camera.lookAt(cam.lookAt);
    if (cam.shake > 0.001) { camera.position.x += (Math.random() - 0.5) * cam.shake * 0.5; camera.position.y += (Math.random() - 0.5) * cam.shake * 0.5; cam.shake *= Math.exp(-6 * dt); }
    const fov = cam.fov + cam.kick * 16;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov += (fov - camera.fov) * (1 - Math.exp(-4 * dt)); camera.updateProjectionMatrix(); }
  }

  function step(dt = DT) {
    if (st.status !== "playing") { if (!headless) { updateRivals(dt); particles?.update(dt); world?.update(dt, focus); updateCamera(dt); } return; }
    input.left = raw.x < -0.5 && !(prev.x < -0.5); input.right = raw.x > 0.5 && !(prev.x > 0.5);
    input.up = raw.y > 0.5 && !(prev.y > 0.5); input.down = raw.y < -0.5 && !(prev.y < -0.5);
    input.actionPressed = raw.action && !prev.action;
    input.x = raw.x; input.y = raw.y; input.action = raw.action;
    Object.assign(prev, raw);
    st.time += dt;
    try { game.update(api, dt); }
    catch (e) { st.error = { message: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 4).join("\n") }; st.status = "error"; log("error", st.error); ui?.end(false, "Game crashed: " + st.error.message, st); return; }
    const pl0 = api.player; if (pl0 && st.start) st.travel = Math.max(st.travel, pl0.pos.distanceTo(st.start));
    if (st.invuln > 0) { st.invuln -= dt; const pl = api.player; if (pl) pl.obj.visible = st.invuln <= 0 || Math.floor(st.invuln * 12) % 2 === 0; }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      if (!e.alive) { ents.splice(i, 1); continue; }
      if (e.vel.lengthSq()) e.obj.position.addScaledVector(e.vel, dt);
      if (e.spin) e.obj.rotation.y += e.spin * dt;
      e._v.subVectors(e.obj.position, e._prev).divideScalar(dt); e._prev.copy(e.obj.position);
      if (!headless) animateModel(e.obj, st.time, e.speed ?? e._v.length());
    }
    if (!headless) {
      updateRivals(dt);
      world?.update(dt, focus); particles?.update(dt); updateCamera(dt);
      if (flash.a > 0) flash.a = Math.max(0, flash.a - dt * 2.5);
    } else if (cam.target) focus.copy(cam.target.pos);
  }

  function render() {
    if (headless) return;
    const w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
    if (w && h && (canvas._w !== w || canvas._h !== h)) {
      canvas._w = w; canvas._h = h;
      renderer.setSize(w, h, false); composer.setSize(w, h); bloom.resolution.set(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    finish.uniforms.flash.value.set(flash.c.r, flash.c.g, flash.c.b, flash.a);
    composer.render();
  }

  // Run the game's setup.
  try { game.setup?.(api); if (!world) api.env({}); }
  catch (e) { st.error = { message: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 4).join("\n") }; st.status = "error"; log("error", st.error); }
  if (!headless) { updateCamera(1); render(); }

  // Multiplayer rivals: translucent copies of the player model with name tags (no collisions).
  const rivals = new Map();
  function nameTag(text, color) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const x = c.getContext("2d"); x.font = "bold 34px Inter, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillStyle = "rgba(10,10,20,.6)"; x.beginPath(); x.roundRect(8, 8, 240, 48, 24); x.fill();
    x.fillStyle = color; x.fillText(text.slice(0, 14), 128, 33);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    // Fixed on-screen size (no perspective growth when the rival is right beside you).
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false }));
    sp.scale.set(0.12, 0.03, 1); sp.renderOrder = 999;
    return sp;
  }
  function setRivals(list) {
    if (headless) return;
    const seen = new Set();
    for (const r of list || []) {
      seen.add(r.id);
      let g = rivals.get(r.id);
      if (!g) {
        const model = api.player?.name || "hero";
        const obj = cloneModel(proto(model));
        const mats = [];
        obj.traverse((n) => { if (n.isMesh) { n.material = n.material.clone(); n.material.transparent = true; n.material.opacity = 0.7; n.material.depthWrite = false; if (n.material.color) n.material.color.lerp(new THREE.Color(r.color), 0.45); if (n.material.emissive) { n.material.emissive.set(r.color); n.material.emissiveIntensity = 0.6; } n.castShadow = false; mats.push(n.material); } });
        const tag = nameTag(r.name, r.color); tag.position.y = (obj.userData.height || 1.5) + 1.2; obj.add(tag);
        scene.add(obj);
        g = { obj, mats, target: new THREE.Vector3(r.x, r.y, r.z), ry: r.ry || 0 };
        obj.position.copy(g.target);
        rivals.set(r.id, g);
      }
      g.target.set(+r.x || 0, +r.y || 0, +r.z || 0); g.ry = +r.ry || 0; g.obj.visible = r.status !== "lost";
    }
    for (const [id, g] of rivals) if (!seen.has(id)) { scene.remove(g.obj); rivals.delete(id); }
  }
  function updateRivals(dt) {
    for (const g of rivals.values()) {
      g.obj.position.lerp(g.target, 1 - Math.exp(-10 * dt));
      g.obj.rotation.y += (g.ry - g.obj.rotation.y) * (1 - Math.exp(-10 * dt));
      animateModel(g.obj, st.time, 20);
      // A rival on top of you turns almost see-through, so your own car always reads clearly.
      const me = api.player, near = me ? Math.hypot(g.obj.position.x - me.pos.x, g.obj.position.z - me.pos.z) : 99;
      const op = near < 2.5 ? 0.15 : near < 5 ? 0.15 + (near - 2.5) * 0.22 : 0.7;
      for (const m of g.mats) m.opacity += (op - m.opacity) * Math.min(1, 12 * dt);
    }
  }

  return {
    api, state: st, scene, camera, renderer, step, render, setRivals,
    playerPose() { const p = api.player; return p ? { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2), ry: +p.obj.rotation.y.toFixed(2) } : null; },
    setInput(i) { raw.x = Math.max(-1, Math.min(1, +i.x || 0)); raw.y = Math.max(-1, Math.min(1, +i.y || 0)); raw.action = !!i.action; },
    entities: () => ents,
    snapshot: () => ({ time: +st.time.toFixed(2), score: st.score, lives: st.lives, status: st.status, progress: +st.progress.toFixed(3), cause: st.cause, pickups: st.pickups, hurts: st.hurts, error: st.error, spawned: { ...st.spawned }, travel: +st.travel.toFixed(1) }),
    dispose() { composer?.dispose?.(); renderer?.dispose(); },
  };
}
export { PRESETS };
