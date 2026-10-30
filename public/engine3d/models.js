// 3D model kit: turns the 3D artist's JSON parts list into lit, shadowed three.js models.
// Parts are primitives (rounded boxes, spheres, wheels, stars…) with physically based
// material presets (car paint with clear coat, chrome, glass, glowing neon…).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const geoCache = new Map(), matCache = new Map(), texCache = new Map();
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.min(+v, 400) : d);

function extruded(shape, depth, r) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.25, bevelSize: r * 0.06, bevelSegments: 3, curveSegments: 16 });
  g.center();
  return g;
}
function starShape(r, points = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
    i ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return s;
}
function heartShape(r) {
  const s = new THREE.Shape(), k = r / 1.2;
  s.moveTo(0, -1.1 * k);
  s.bezierCurveTo(-1.6 * k, 0, -0.9 * k, 1.1 * k, 0, 0.45 * k);
  s.bezierCurveTo(0.9 * k, 1.1 * k, 1.6 * k, 0, 0, -1.1 * k);
  return s;
}

export function geometry(shape, s = [], round = 0) {
  const key = JSON.stringify([shape, s, round]);
  if (geoCache.has(key)) return geoCache.get(key);
  let g;
  switch (shape) {
    case "sphere": { const r = num(s[0], 0.5); g = new THREE.SphereGeometry(1, 32, 20); g.scale(r, num(s[1], r), num(s[2], r)); break; }
    case "cylinder": g = new THREE.CylinderGeometry(num(s[0], 0.5), s[1] === 0 ? 0.001 : num(s[1], num(s[0], 0.5)), num(s[2], 1), 32); break;
    case "cone": g = new THREE.ConeGeometry(num(s[0], 0.5), num(s[1], 1), 32); break;
    case "pyramid": g = new THREE.ConeGeometry(num(s[0], 0.5), num(s[1], 1), 4); break;
    case "torus": g = new THREE.TorusGeometry(num(s[0], 0.5), num(s[1], 0.12), 16, 48); break;
    case "capsule": g = new THREE.CapsuleGeometry(num(s[0], 0.3), num(s[1], 0.8), 8, 20); break;
    case "wheel": { const r = num(s[0], 0.4); g = new THREE.CylinderGeometry(r, r, num(s[1], 0.3), 28); g.rotateZ(Math.PI / 2); break; }
    case "icosa": g = new THREE.IcosahedronGeometry(num(s[0], 0.5), 0); break;
    case "dodeca": g = new THREE.DodecahedronGeometry(num(s[0], 0.5), 0); break;
    case "octa": g = new THREE.OctahedronGeometry(num(s[0], 0.5), 0); break;
    case "star": g = extruded(starShape(num(s[0], 0.5)), num(s[1], 0.18), num(s[0], 0.5)); break;
    case "heart": g = extruded(heartShape(num(s[0], 0.5)), num(s[1], 0.2), num(s[0], 0.5)); break;
    case "plane": g = new THREE.PlaneGeometry(num(s[0], 1), num(s[1], 1)); break;
    default: {
      const w = num(s[0], 1), h = num(s[1], w), d = num(s[2], w);
      const r = Math.min(+round || 0, Math.min(w, h, d) * 0.45);
      g = r > 0.005 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d);
    }
  }
  geoCache.set(key, g);
  return g;
}

function canvasTex(key, draw, size = 128) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement("canvas"); c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}
const checker = (a, b) => canvasTex("checker" + a + b, (x, n) => { for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) % 2 ? a : b; x.fillRect(i * n / 8, j * n / 8, n / 8, n / 8); } });
const stripes = (a, b) => canvasTex("stripes" + a + b, (x, n) => { x.fillStyle = a; x.fillRect(0, 0, n, n); x.fillStyle = b; for (let i = -n; i < n * 2; i += n / 4) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + n / 8, 0); x.lineTo(i + n / 8 - n, n); x.lineTo(i - n, n); x.fill(); } });

// Physically based material presets.
export function material(kind = "plastic", color = "#cccccc", opts = {}) {
  const key = JSON.stringify([kind, color, opts.color2, opts.intensity, opts.opacity]);
  if (matCache.has(key)) return matCache.get(key);
  const c = new THREE.Color(color);
  let m;
  switch (kind) {
    case "paint": m = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 }); break;
    case "metal": m = new THREE.MeshStandardMaterial({ color: c, metalness: 0.9, roughness: 0.28 }); break;
    case "chrome": m = new THREE.MeshStandardMaterial({ color: c, metalness: 1, roughness: 0.06 }); break;
    case "gold": m = new THREE.MeshStandardMaterial({ color: c, metalness: 1, roughness: 0.22, emissive: c, emissiveIntensity: 0.25 }); break;
    case "glass": m = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.5, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.6, transparent: opts.opacity < 1, opacity: opts.opacity ?? 1 }); break;
    case "rubber": m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0 }); break;
    case "matte": case "cloth": case "fur": m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, metalness: 0 }); break;
    case "skin": m = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.6, sheen: 0.4, sheenColor: new THREE.Color("#ffd9c7") }); break;
    case "wood": m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.82 }); break;
    case "stone": m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true }); break;
    case "ice": m = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.08, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.85, emissive: c, emissiveIntensity: 0.15 }); break;
    case "glow": case "neon": case "light": m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: opts.intensity ?? 2.6, roughness: 0.4 }); break;
    case "checker": m = new THREE.MeshStandardMaterial({ map: checker(color, opts.color2 || "#111111"), roughness: 0.6 }); break;
    case "stripes": m = new THREE.MeshStandardMaterial({ map: stripes(color, opts.color2 || "#ffffff"), roughness: 0.5 }); break;
    case "toon": m = new THREE.MeshToonMaterial({ color: c }); break;
    default: m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.42, metalness: 0.05 });
  }
  matCache.set(key, m);
  return m;
}

const D2R = Math.PI / 180;
// Build a model from {parts:[{shape,size,pos,rot,color,mat,round,mirror,anim,...}], scale}.
// The result is normalized: centered on x/z with its lowest point at y = 0.
export function buildModel(def = {}, recolor = {}) {
  const inner = new THREE.Group(), anims = [];
  const parts = Array.isArray(def.parts) ? def.parts.slice(0, 80) : [];
  const add = (p, mirrored) => {
    let color = String(p.color || "#cccccc");
    if (color.startsWith("$")) color = recolor[color.slice(1)] || def.colors?.[color.slice(1)] || "#e8e8e8";
    let mat;
    try { mat = material(p.mat || p.material || (p.glow ? "glow" : "plastic"), color, { color2: p.color2, intensity: p.intensity, opacity: p.opacity }); }
    catch { mat = material("plastic", "#cccccc"); }
    const mesh = new THREE.Mesh(geometry(p.shape, Array.isArray(p.size) ? p.size : [p.size], p.round), mat);
    const pos = Array.isArray(p.pos) ? p.pos.map((v) => +v || 0) : [0, 0, 0];
    const rot = Array.isArray(p.rot) ? p.rot.map((v) => (+v || 0) * D2R) : [0, 0, 0];
    if (mirrored) { pos[0] = -pos[0]; rot[1] = -rot[1]; rot[2] = -rot[2]; }
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    if (Array.isArray(p.scale)) mesh.scale.set(...p.scale.map((v) => +v || 1));
    const glowing = ["glow", "neon", "light"].includes(p.mat || p.material) || p.glow;
    mesh.castShadow = !glowing; mesh.receiveShadow = true;
    if (p.anim) anims.push({ mesh, type: p.anim, base: mesh.position.clone(), rot: mesh.rotation.clone(), phase: Math.random() * 6 });
    inner.add(mesh);
  };
  for (const p of parts) { add(p, false); if (p.mirror === "x" || p.mirror === true) add(p, true); }
  if (!inner.children.length) add({ shape: "box", size: [1, 1, 1], color: "#ff4fa3", round: 0.15 });
  const scale = num(def.scale, 1);
  inner.scale.setScalar(scale);
  const box = new THREE.Box3().setFromObject(inner), size = box.getSize(new THREE.Vector3());
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.userData = { anims, size, radius: Math.max(0.2, Math.max(size.x, size.z) * 0.42), height: size.y, name: def.name };
  return outer;
}

// Clone that shares geometry/materials but keeps its own animation list.
export function cloneModel(proto) {
  const o = proto.clone(true);
  const meshes = [], src = [];
  proto.traverse((n) => src.push(n)); o.traverse((n) => meshes.push(n));
  o.userData = { ...proto.userData, anims: proto.userData.anims.map((a) => ({ ...a, mesh: meshes[src.indexOf(a.mesh)], phase: Math.random() * 6 })) };
  return o;
}

// Animate part-level effects: spin, wheel, bob, flap, blink, pulse, swing.
export function animateModel(obj, t, speed = 0) {
  for (const a of obj.userData.anims || []) {
    const m = a.mesh; if (!m) continue;
    switch (a.type) {
      case "spin": m.rotation.y = a.rot.y + t * 3 + a.phase; break;
      case "wheel": m.rotation.x -= speed * 0.03; break;
      case "bob": m.position.y = a.base.y + Math.sin(t * 3 + a.phase) * 0.12; break;
      case "flap": m.rotation.z = a.rot.z + Math.sin(t * 14 + a.phase) * 0.6 * Math.sign(a.base.x || 1); break;
      case "swing": m.rotation.x = a.rot.x + Math.sin(t * 8 + a.phase) * 0.7 * Math.min(1, 0.2 + speed * 0.08) * (a.base.x >= 0 ? 1 : -1); break;
      case "pulse": m.scale.setScalar(1 + Math.sin(t * 5 + a.phase) * 0.12); break;
      case "blink": m.visible = Math.sin(t * 4 + a.phase) > -0.6; break;
    }
  }
}

// A built-in prop library the AI can use alongside its own models ("$main" = recolorable).
export const LIBRARY = {
  coin: { parts: [
    { shape: "cylinder", size: [0.5, 0.5, 0.12], rot: [90, 0, 0], color: "#ffc93c", mat: "gold", anim: "spin" },
    { shape: "torus", size: [0.5, 0.05], color: "#ffe08a", mat: "glow", intensity: 1.6, anim: "spin" }] },
  gem: { parts: [{ shape: "octa", size: [0.5], scale: [1, 1.4, 1], color: "$main", mat: "glow", intensity: 1.8, anim: "spin" }], colors: { main: "#3ef0ff" } },
  star: { parts: [{ shape: "star", size: [0.55, 0.2], color: "#ffd23f", mat: "glow", intensity: 2, anim: "spin" }] },
  heart: { parts: [{ shape: "heart", size: [0.5, 0.22], color: "#ff3b6b", mat: "glow", intensity: 2, anim: "spin" }] },
  ring: { parts: [{ shape: "torus", size: [2.4, 0.16], color: "$main", mat: "glow", intensity: 1.5, anim: "pulse" }], colors: { main: "#3ef0ff" } },
  finish: { parts: [
    { shape: "box", size: [0.6, 6, 0.6], pos: [5.5, 3, 0], color: "#f2f2f2", mat: "metal", mirror: "x" },
    { shape: "box", size: [11.6, 1.4, 0.4], pos: [0, 6.2, 0], color: "#ffffff", mat: "checker", color2: "#111111" },
    { shape: "box", size: [11.6, 0.15, 0.5], pos: [0, 5.45, 0], color: "#ffd23f", mat: "glow" },
    { shape: "sphere", size: [0.35], pos: [5.5, 6.4, 0], color: "#ff3b6b", mat: "glow", mirror: "x", anim: "blink" }] },
  portal: { parts: [
    { shape: "torus", size: [1.6, 0.25], pos: [0, 1.9, 0], color: "$main", mat: "glow", intensity: 3 },
    { shape: "cylinder", size: [1.45, 1.45, 0.05], pos: [0, 1.9, 0], rot: [90, 0, 0], color: "$main", mat: "glass", opacity: 0.5, anim: "pulse" }], colors: { main: "#b46bff" } },
  cone: { parts: [
    { shape: "box", size: [0.7, 0.08, 0.7], round: 0.03, color: "#ff6a00", mat: "plastic" },
    { shape: "cone", size: [0.3, 0.9], pos: [0, 0.5, 0], color: "#ff6a00", mat: "plastic" },
    { shape: "cylinder", size: [0.17, 0.21, 0.16], pos: [0, 0.55, 0], color: "#ffffff", mat: "glow", intensity: 0.6 }] },
  barrier: { parts: [
    { shape: "box", size: [3, 0.55, 0.25], pos: [0, 0.95, 0], color: "#e8202a", mat: "stripes", color2: "#ffffff", round: 0.05 },
    { shape: "box", size: [0.15, 1, 0.15], pos: [1.2, 0.5, 0], color: "#666666", mat: "metal", mirror: "x" },
    { shape: "sphere", size: [0.12], pos: [1.2, 1.32, 0], color: "#ff8a00", mat: "glow", mirror: "x", anim: "blink" }] },
  crate: { parts: [{ shape: "box", size: [1.2, 1.2, 1.2], round: 0.06, color: "#b07a3c", mat: "wood" }, { shape: "box", size: [1.24, 0.18, 1.24], pos: [0, 0.3, 0], color: "#7a4f22", mat: "wood" }, { shape: "box", size: [1.24, 0.18, 1.24], pos: [0, -0.3, 0], color: "#7a4f22", mat: "wood" }] },
  car: { colors: { main: "#e8202a" }, parts: [
    { shape: "box", size: [1.9, 0.62, 4.2], pos: [0, 0.62, 0], round: 0.22, color: "$main", mat: "paint" },
    { shape: "box", size: [1.6, 0.55, 2.1], pos: [0, 1.15, 0.25], round: 0.2, color: "#0f1720", mat: "glass" },
    { shape: "wheel", size: [0.38, 0.3], pos: [0.88, 0.38, 1.35], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "wheel", size: [0.38, 0.3], pos: [0.88, 0.38, -1.35], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "box", size: [0.42, 0.14, 0.06], pos: [0.62, 0.7, -2.1], color: "#fff6d8", mat: "glow", intensity: 4, mirror: "x" },
    { shape: "box", size: [0.42, 0.12, 0.06], pos: [0.62, 0.72, 2.1], color: "#ff1030", mat: "glow", intensity: 3, mirror: "x" }] },
  truck: { colors: { main: "#2f7fd1" }, parts: [
    { shape: "box", size: [2.3, 1.6, 2.2], pos: [0, 1.3, -2.6], round: 0.2, color: "$main", mat: "paint" },
    { shape: "box", size: [2.0, 0.6, 0.1], pos: [0, 1.6, -3.71], color: "#0f1720", mat: "glass" },
    { shape: "box", size: [2.5, 2.6, 5.2], pos: [0, 1.85, 1.2], round: 0.08, color: "#e8e8e8", mat: "plastic" },
    { shape: "wheel", size: [0.5, 0.4], pos: [1.05, 0.5, -2.5], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "wheel", size: [0.5, 0.4], pos: [1.05, 0.5, 2.2], color: "#111111", mat: "rubber", mirror: "x", anim: "wheel" },
    { shape: "box", size: [0.4, 0.2, 0.06], pos: [0.8, 0.9, -3.72], color: "#fff6d8", mat: "glow", intensity: 4, mirror: "x" }] },
  rock: { parts: [{ shape: "dodeca", size: [0.9], scale: [1.2, 0.8, 1], color: "#7d7a74", mat: "stone" }, { shape: "dodeca", size: [0.5], pos: [0.7, -0.1, 0.3], color: "#6b6862", mat: "stone" }] },
  tree: { parts: [{ shape: "cylinder", size: [0.18, 0.28, 2], pos: [0, 1, 0], color: "#6b4423", mat: "wood" }, { shape: "icosa", size: [1.3], pos: [0, 2.6, 0], color: "#3fa34d", mat: "stone" }, { shape: "icosa", size: [0.9], pos: [0.6, 2.1, 0.3], color: "#4bb85a", mat: "stone" }] },
  pine: { parts: [{ shape: "cylinder", size: [0.15, 0.22, 1], pos: [0, 0.5, 0], color: "#5a3a1f", mat: "wood" }, { shape: "cone", size: [1.3, 1.8], pos: [0, 1.6, 0], color: "#2e7d4f", mat: "stone" }, { shape: "cone", size: [1, 1.5], pos: [0, 2.5, 0], color: "#348c58", mat: "stone" }, { shape: "cone", size: [0.65, 1.2], pos: [0, 3.3, 0], color: "#3a9a60", mat: "stone" }] },
  spike: { parts: [{ shape: "cone", size: [0.45, 1.2], pos: [0, 0.6, 0], color: "#c9ccd6", mat: "chrome" }, { shape: "cone", size: [0.3, 0.8], pos: [0.5, 0.4, 0.2], color: "#c9ccd6", mat: "chrome" }, { shape: "cone", size: [0.3, 0.8], pos: [-0.4, 0.4, -0.3], color: "#c9ccd6", mat: "chrome" }] },
  bomb: { parts: [{ shape: "sphere", size: [0.6], pos: [0, 0.6, 0], color: "#1b1b22", mat: "paint" }, { shape: "cylinder", size: [0.2, 0.2, 0.2], pos: [0, 1.25, 0], color: "#444444", mat: "metal" }, { shape: "sphere", size: [0.14], pos: [0.1, 1.5, 0], color: "#ff8a00", mat: "glow", intensity: 5, anim: "blink" }] },
  ghost: { colors: { main: "#e9f0ff" }, parts: [{ shape: "capsule", size: [0.55, 0.7], pos: [0, 0.9, 0], color: "$main", mat: "glass", opacity: 0.85 }, { shape: "sphere", size: [0.12], pos: [0.2, 1.25, -0.48], color: "#1a1a2e", mat: "glow", intensity: 0.2, mirror: "x" }] },
  hero: { colors: { main: "#ff6b4a" }, parts: [
    { shape: "capsule", size: [0.42, 0.6], pos: [0, 0.95, 0], color: "$main", mat: "plastic" },
    { shape: "sphere", size: [0.38], pos: [0, 1.75, 0], color: "#ffd2b0", mat: "skin" },
    { shape: "sphere", size: [0.07], pos: [0.14, 1.8, -0.33], color: "#111111", mat: "glass", mirror: "x" },
    { shape: "capsule", size: [0.13, 0.45], pos: [0.18, 0.35, 0], color: "#33334a", mat: "cloth", mirror: "x", anim: "swing" },
    { shape: "capsule", size: [0.11, 0.45], pos: [0.52, 1.05, 0], color: "$main", mat: "plastic", mirror: "x", anim: "swing" }] },
};
