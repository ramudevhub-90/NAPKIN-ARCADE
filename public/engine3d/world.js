// 3D worlds: skies, lighting, fog, ground, tracks, weather and endless scenery.
// "strip" worlds stream scenery along -Z (runners, racers, flyers); "arena" worlds
// surround an open play area (top-down chases, collectors, battles).
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const PRESETS = {
  "city-night": { sky: "night", top: "#03040d", mid: "#141033", horizon: "#3a1d4f", fog: ["#1b1233", 30, 230], hemi: ["#7f8cff", "#120b1c", 0.55], sun: ["#9fb0ff", 0.7, [-0.5, 1, 0.4]], env: 0.3, ground: "concrete", track: "road", scenery: "city", night: true, bloom: [0.6, 0.45, 0.88], exposure: 0.95, wallDim: 0.3 },
  "city-day": { sky: "day", elevation: 38, fog: ["#bcd3ea", 60, 320], hemi: ["#cfe6ff", "#5b5348", 0.8], sun: ["#fff3dc", 2.6, [-0.6, 1, 0.35]], env: 0.9, ground: "concrete", track: "road", scenery: "city", bloom: [0.25, 0.4, 0.92], exposure: 0.9 },
  "city-sunset": { sky: "day", elevation: 3, turbidity: 8, fog: ["#e79a6c", 50, 280], hemi: ["#ffc9a0", "#3b2a3a", 0.7], sun: ["#ffb37a", 2.4, [-0.9, 0.25, -0.6]], env: 0.7, ground: "concrete", track: "road", scenery: "city", night: true, bloom: [0.6, 0.5, 0.8], exposure: 0.85 },
  forest: { sky: "day", elevation: 30, fog: ["#b9d8c4", 50, 260], hemi: ["#d9f2ff", "#3c5a2a", 0.85], sun: ["#fff1d0", 2.6, [-0.5, 1, 0.3]], env: 0.8, ground: "grass", track: "path", scenery: "forest", bloom: [0.25, 0.4, 0.92], exposure: 0.9 },
  desert: { sky: "day", elevation: 12, turbidity: 6, fog: ["#e9c79a", 60, 320], hemi: ["#ffe4bf", "#7a5532", 0.8], sun: ["#ffd9a3", 2.8, [-0.7, 0.55, -0.3]], env: 0.7, ground: "sand", track: "road", scenery: "desert", bloom: [0.3, 0.4, 0.9], exposure: 0.85 },
  snow: { sky: "day", elevation: 14, turbidity: 2, fog: ["#c9d9ec", 70, 300], hemi: ["#dcecff", "#6f86a3", 0.75], sun: ["#fff4e2", 2.4, [-0.5, 0.7, 0.4]], env: 0.7, ground: "snow", track: "ice", scenery: "snow", weather: "snow", bloom: [0.2, 0.4, 0.96], exposure: 0.62 },
  beach: { sky: "day", elevation: 42, fog: ["#bfe6f5", 80, 360], hemi: ["#d9f4ff", "#c2a77a", 0.85], sun: ["#fff6e0", 2.8, [-0.4, 1, 0.2]], env: 0.9, ground: "sand", track: "boardwalk", scenery: "beach", ocean: true, bloom: [0.25, 0.4, 0.92], exposure: 0.88 },
  space: { sky: "space", top: "#020108", mid: "#0a0620", horizon: "#1b0f3c", fog: ["#05030f", 80, 420], hemi: ["#8f7dff", "#05030a", 0.5], sun: ["#cfd8ff", 2.0, [-0.6, 0.6, 0.5]], env: 0.6, ground: null, track: "metal", scenery: "space", night: true, weather: "dust", bloom: [1.1, 0.6, 0.65], exposure: 1.0 },
  candy: { sky: "gradient", top: "#7ec8ff", mid: "#c9b8ff", horizon: "#ffd1ec", fog: ["#ffd8ee", 50, 260], hemi: ["#fff0fa", "#b77ad0", 0.95], sun: ["#fff4f0", 2.2, [-0.5, 1, 0.4]], env: 0.55, ground: "candy", track: "candy", scenery: "candy", bloom: [0.25, 0.45, 0.97], exposure: 0.62 },
  volcano: { sky: "gradient", top: "#0b0405", mid: "#3a0e08", horizon: "#b8361a", fog: ["#4a140b", 25, 200], hemi: ["#ff9a6a", "#1a0503", 0.55], sun: ["#ffb27a", 1.6, [-0.4, 0.7, -0.6]], env: 0.35, ground: "basalt", track: "rock", scenery: "volcano", night: true, stars: false, weather: "embers", bloom: [0.65, 0.45, 0.8], exposure: 0.9 },
  underwater: { sky: "gradient", top: "#0a4e78", mid: "#0b3756", horizon: "#06233a", fog: ["#0a3a5a", 10, 120], hemi: ["#7fe3ff", "#06223a", 0.9], sun: ["#bff4ff", 1.6, [0, 1, 0.2]], env: 0.5, ground: "seabed", track: "sand", scenery: "coral", weather: "bubbles", night: true, stars: false, bloom: [0.5, 0.5, 0.82], exposure: 0.8 },
  synthwave: { sky: "synth", top: "#07021a", mid: "#2a0b4a", horizon: "#ff2fa0", fog: ["#2a0838", 40, 260], hemi: ["#ff6ad5", "#140326", 0.6], sun: ["#ff9de0", 1.2, [0, 0.4, -1]], env: 0.4, ground: "grid", track: "neon", scenery: "synth", night: true, bloom: [1.3, 0.6, 0.55], exposure: 1.05 },
};

// ---------- procedural textures ----------
const texCache = new Map();
function tex(key, size, draw, { srgb = true, repeat = [1, 1] } = {}) {
  if (!texCache.has(key)) {
    const c = document.createElement("canvas"); c.width = c.height = size;
    draw(c.getContext("2d"), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, t);
  }
  const t = texCache.get(key).clone(); t.needsUpdate = true; t.repeat.set(...repeat);
  return t;
}
function speckle(x, n, colors, count, rmin, rmax, alpha = 0.5) {
  for (let i = 0; i < count; i++) {
    x.globalAlpha = Math.random() * alpha; x.fillStyle = colors[(Math.random() * colors.length) | 0];
    const r = rmin + Math.random() * (rmax - rmin);
    x.beginPath(); x.arc(Math.random() * n, Math.random() * n, r, 0, 7); x.fill();
  }
  x.globalAlpha = 1;
}
const GROUNDS = {
  grass: (x, n) => { x.fillStyle = "#4f9a3a"; x.fillRect(0, 0, n, n); speckle(x, n, ["#3d8a2f", "#69b44a", "#7cc65a", "#2f6e26"], 2600, 2, 9, 0.55); },
  sand: (x, n) => { x.fillStyle = "#e3c48f"; x.fillRect(0, 0, n, n); speckle(x, n, ["#d6b27a", "#efd6a6", "#c9a36c"], 3000, 1, 6, 0.5); },
  snow: (x, n) => { x.fillStyle = "#dfe8f3"; x.fillRect(0, 0, n, n); speckle(x, n, ["#dbe7f5", "#ffffff", "#cfdcec"], 2400, 2, 10, 0.6); },
  concrete: (x, n) => { x.fillStyle = "#3a3d44"; x.fillRect(0, 0, n, n); speckle(x, n, ["#2e3036", "#474a52", "#55585f"], 3000, 1, 5, 0.5); x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 3; for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(i * n / 4, 0); x.lineTo(i * n / 4, n); x.moveTo(0, i * n / 4); x.lineTo(n, i * n / 4); x.stroke(); } },
  candy: (x, n) => { x.fillStyle = "#f29ac8"; x.fillRect(0, 0, n, n); speckle(x, n, ["#ff8fc8", "#9fe3ff", "#fff59a", "#b9ffb0", "#ffffff"], 500, 3, 6, 0.9); },
  basalt: (x, n) => { x.fillStyle = "#231c1b"; x.fillRect(0, 0, n, n); speckle(x, n, ["#2f2625", "#171111", "#3b2f2c"], 3000, 2, 10, 0.6); },
  seabed: (x, n) => { x.fillStyle = "#8fa89a"; x.fillRect(0, 0, n, n); speckle(x, n, ["#b39e74", "#ddc9a0", "#9c8a66"], 2800, 1, 7, 0.5); },
};
const TRACKS = {
  road: (lanes) => (x, n) => {
    x.fillStyle = "#26282e"; x.fillRect(0, 0, n, n); speckle(x, n, ["#1d1f24", "#33363d", "#2b2d33"], 4000, 1, 4, 0.6);
    x.fillStyle = "#f1f1f1"; x.fillRect(n * 0.02, 0, n * 0.015, n); x.fillRect(n * 0.965, 0, n * 0.015, n);
    x.fillStyle = "#f6f2e6";
    for (let l = 1; l < lanes; l++) for (let y = 0; y < n; y += n / 4) x.fillRect((l / lanes) * n - n * 0.008, y, n * 0.016, n / 8);
  },
  path: () => (x, n) => { x.fillStyle = "#9b7a52"; x.fillRect(0, 0, n, n); speckle(x, n, ["#87683f", "#b08d63", "#6f5434", "#a8a29a"], 3500, 1, 6, 0.6); },
  ice: () => (x, n) => { const g = x.createLinearGradient(0, 0, n, n); g.addColorStop(0, "#bfe6ff"); g.addColorStop(1, "#e8f7ff"); x.fillStyle = g; x.fillRect(0, 0, n, n); x.strokeStyle = "rgba(255,255,255,.7)"; x.lineWidth = 2; for (let i = 0; i < 18; i++) { x.beginPath(); let px = Math.random() * n, py = Math.random() * n; x.moveTo(px, py); for (let k = 0; k < 4; k++) { px += (Math.random() - 0.5) * 120; py += (Math.random() - 0.5) * 120; x.lineTo(px, py); } x.stroke(); } },
  candy: () => (x, n) => { for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#ffe6f2" : "#ff4f9a"; x.fillRect(0, (i * n) / 8, n, n / 8); } },
  rock: () => (x, n) => { x.fillStyle = "#2b2220"; x.fillRect(0, 0, n, n); speckle(x, n, ["#3a2e2b", "#1c1514"], 3000, 2, 8, 0.6); },
  sand: () => GROUNDS.seabed,
  boardwalk: () => (x, n) => { for (let i = 0; i < 16; i++) { x.fillStyle = ["#b98a56", "#a87a48", "#c4965f"][i % 3]; x.fillRect(0, (i * n) / 16, n, n / 16 - 3); } x.fillStyle = "#3a2a1a"; for (let i = 0; i < 16; i++) x.fillRect(0, (i * n) / 16 + n / 16 - 3, n, 3); },
  metal: () => (x, n) => { x.fillStyle = "#20232e"; x.fillRect(0, 0, n, n); x.strokeStyle = "#3b4153"; x.lineWidth = 4; for (let i = 0; i <= 4; i++) { x.strokeRect(0, (i * n) / 4, n, n / 4); } x.fillStyle = "#3ef0ff"; x.fillRect(0, 0, 6, n); x.fillRect(n - 6, 0, 6, n); },
  neon: () => (x, n) => { x.fillStyle = "#0b0418"; x.fillRect(0, 0, n, n); x.fillStyle = "#ff3fb4"; for (let i = 0; i <= 8; i++) { x.fillRect((i * n) / 8 - 2, 0, 4, n); x.fillRect(0, (i * n) / 8 - 2, n, 4); } },
};
const EMISSIVE_TRACKS = { metal: true, neon: true };

// Facade textures: color map + matching emissive map drawn from the same random layout.
const facadeCache = new Map();
function facade(kind, night) {
  const key = kind + "" + night;
  if (!facadeCache.has(key)) {
    const n = 512, cols = kind === 2 ? 6 : 8, rows = kind === 2 ? 12 : 10, cw = n / cols, rh = n / rows;
    const mk = () => { const c = document.createElement("canvas"); c.width = c.height = n; return c; };
    const cc = mk(), ec = mk(), x = cc.getContext("2d"), e = ec.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, n, n); e.fillStyle = "#000"; e.fillRect(0, 0, n, n);
    // Floor bands give facades structure.
    x.fillStyle = "#d9d9d9"; for (let j = 0; j < rows; j++) x.fillRect(0, j * rh + rh * 0.84, n, rh * 0.16);
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const pad = kind === 1 ? 0.06 : 0.22, wx = i * cw + cw * pad, wy = j * rh + rh * 0.18, ww = cw * (1 - pad * 2), wh = rh * 0.56;
      const lit = night && Math.random() < (kind === 1 ? 0.18 : 0.26);
      x.fillStyle = kind === 1 ? "#3d5672" : "#1c2430"; x.fillRect(wx, wy, ww, wh);
      if (lit) {
        const warm = ["#ffcf85", "#ffe2a8", "#a9d4ff", "#ffb85c", "#fff0d0"][(Math.random() * 5) | 0], k = 0.45 + Math.random() * 0.55;
        e.globalAlpha = k; e.fillStyle = warm; e.fillRect(wx, wy, ww, wh); e.globalAlpha = 1;
        x.fillStyle = warm; x.fillRect(wx, wy, ww, wh);
      }
    }
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, 6, 6);
    const t = (c) => { const tx = new THREE.CanvasTexture(c); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.anisotropy = 8; tx.colorSpace = THREE.SRGBColorSpace; return tx; };
    facadeCache.set(key, { map: t(cc), emissive: t(ec) });
  }
  return facadeCache.get(key);
}
const radialTex = () => tex("radial", 128, (x, n) => { const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,.45)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, n, n); });

// ---------- geometry kit: many small pieces merged into a few draw calls ----------
const G = {
  box: new THREE.BoxGeometry(1, 1, 1), cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12), cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  cone: new THREE.ConeGeometry(0.5, 1, 8), cone4: new THREE.ConeGeometry(0.5, 1, 4), sphere: new THREE.SphereGeometry(0.5, 14, 10),
  ico: new THREE.IcosahedronGeometry(0.5, 0), ico1: new THREE.IcosahedronGeometry(0.5, 1), dode: new THREE.DodecahedronGeometry(0.5, 0),
  torus: new THREE.TorusGeometry(0.5, 0.12, 8, 24), plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
};
for (const k of Object.keys(G)) { G[k] = G[k].index ? G[k].toNonIndexed() : G[k]; G[k].deleteAttribute("uv"); G[k].setAttribute("uv", new THREE.BufferAttribute(new Float32Array(G[k].attributes.position.count * 2), 2)); }
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _c = new THREE.Color();
class Kit {
  constructor() { this.parts = { solid: [], glow: [], flat: [] }; }
  add(geo, pos, scale, color, { rot = [0, 0, 0], layer = "solid" } = {}) {
    const g = geo.clone();
    _e.set(rot[0], rot[1], rot[2]); _q.setFromEuler(_e);
    _m.compose(new THREE.Vector3(...pos), _q, new THREE.Vector3(...(Array.isArray(scale) ? scale : [scale, scale, scale])));
    g.applyMatrix4(_m);
    _c.set(color);
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.parts[layer].push(g);
  }
  build(mats) {
    const group = new THREE.Group();
    for (const layer of ["solid", "flat", "glow"]) {
      if (!this.parts[layer].length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(this.parts[layer]), mats[layer]);
      mesh.castShadow = layer !== "glow"; mesh.receiveShadow = layer !== "glow";
      group.add(mesh);
    }
    return group;
  }
}

// ---------- scenery generators (one side of the track, or a ring around an arena) ----------
const pick = (r, a) => a[(r() * a.length) | 0];
const SCENERY = {
  city(k, r, s, extra) {
    for (let row = 0; row < 3; row++) {
      let z = s.z0;
      while (z > s.z1) {
        const w = 6 + r() * 9, d = 6 + r() * 9, h = (8 + r() * 26) * (1 + row * 0.7) * (r() < 0.12 ? 2 : 1);
        const x = s.side * (s.inner + 6 + row * 18 + w / 2 + r() * 3), zc = z - d / 2;
        extra.buildings.push({ x, z: zc, w, d, h, kind: (r() * 3) | 0, tint: pick(r, ["#c9ccd6", "#b8a99a", "#9fb3c8", "#d8d2c4", "#8f98a8", "#c7b8d6"]) });
        k.add(G.box, [x, h + 0.25, zc], [w + 0.4, 0.5, d + 0.4], "#2a2d35");
        if (r() < 0.5) k.add(G.cyl, [x + (r() - 0.5) * w * 0.5, h + 1.5, zc + (r() - 0.5) * d * 0.5], [1.6, 2.2, 1.6], "#5a5f6b");
        if (r() < 0.45) { k.add(G.cyl, [x, h + 4, zc], [0.15, 8, 0.15], "#888888"); k.add(G.sphere, [x, h + 8.1, zc], 0.45, "#ff2030", { layer: "glow" }); }
        if (s.night && row === 0 && r() < 0.65) {
          const col = pick(r, ["#ff2fa0", "#3ef0ff", "#b46bff", "#ffd23f", "#39ff88", "#ff5a2a"]);
          const sh = 2 + r() * 5, sy = 4 + r() * Math.min(18, h - 6);
          const fx = x - s.side * (w / 2 + 0.2), sw = Math.min(d * 0.7, sh), shh = sh * 0.38, t = 0.12;
          k.add(G.box, [fx + s.side * 0.05, sy, zc], [0.12, shh, sw], "#0a0812");
          for (const [dy, dz, hh, ww] of [[shh / 2, 0, t, sw], [-shh / 2, 0, t, sw], [0, sw / 2, shh, t], [0, -sw / 2, shh, t]]) k.add(G.box, [fx, sy + dy, zc + dz], [t, hh, ww], col, { layer: "glow" });
          for (let b = 0; b < 3; b++) k.add(G.box, [fx, sy + (b - 1) * shh * 0.25, zc + (r() - 0.5) * sw * 0.2], [t, t * 0.8, sw * (0.4 + r() * 0.4)], col, { layer: "glow" });
        }
        z -= d + 1 + r() * 4;
      }
    }
    // Sidewalk, street lamps and light pools.
    k.add(G.box, [s.side * (s.inner + 2.5), 0.12, (s.z0 + s.z1) / 2], [5, 0.24, s.z0 - s.z1], s.night ? "#34363e" : "#8a8d94");
    for (let z = s.z0 - 4; z > s.z1; z -= 16) {
      const x = s.side * (s.inner + 1);
      k.add(G.cyl, [x, 3.2, z], [0.18, 6.4, 0.18], "#2b2e35");
      k.add(G.box, [x - s.side * 1, 6.3, z], [2.2, 0.16, 0.2], "#2b2e35");
      k.add(G.box, [x - s.side * 1.9, 6.15, z], [0.9, 0.18, 0.5], s.night ? "#ffd59a" : "#e8e8e8", { layer: s.night ? "glow" : "solid" });
      if (s.night) extra.pools.push([x - s.side * 1.9, z, 9, "#ffbf70"]);
      if (r() < 0.3) { k.add(G.cyl, [x + s.side * 2, 0.6, z - 7], [1.3, 1.2, 1.3], "#6b6f78"); k.add(G.ico1, [x + s.side * 2, 2.4, z - 7], [2.6, 2.6, 2.6], "#3f8f4a", { layer: "flat" }); }
    }
  },
  forest(k, r, s) {
    for (let i = 0; i < 70; i++) {
      const x = s.side * (s.inner + 2 + Math.pow(r(), 1.3) * 70), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.8 + r() * 1.6;
      if (r() < 0.55) {
        k.add(G.cyl6, [x, sc * 0.7, z], [0.4 * sc, 1.4 * sc, 0.4 * sc], "#5a3a1f");
        const g = pick(r, ["#2e7d4f", "#348c58", "#2a6f45", "#3f9a5c"]);
        for (let t = 0; t < 3; t++) k.add(G.cone, [x, sc * (1.8 + t * 1.1), z], [sc * (2.6 - t * 0.6), sc * 1.8, sc * (2.6 - t * 0.6)], g, { layer: "flat" });
      } else if (r() < 0.75) {
        k.add(G.cyl6, [x, sc * 1.1, z], [0.35 * sc, 2.2 * sc, 0.35 * sc], "#6b4423");
        k.add(G.ico1, [x, sc * 3, z], sc * 2.8, pick(r, ["#4caf50", "#66bb4a", "#8bc34a", "#3e9b46", "#e0a33a"]), { layer: "flat" });
      } else if (r() < 0.6) k.add(G.dode, [x, 0.3 * sc, z], [sc * 1.4, sc * 0.9, sc * 1.2], "#8a8780", { layer: "flat", rot: [r(), r() * 3, 0] });
      else k.add(G.ico, [x, 0.3, z], [1.4, 0.8, 1.4], pick(r, ["#4f9a3a", "#5aa844"]), { layer: "flat" });
      if (r() < 0.25) k.add(G.sphere, [s.side * (s.inner + 1 + r() * 4), 0.2, z], 0.3, pick(r, ["#ff5a7a", "#ffd23f", "#ffffff", "#b46bff"]));
    }
  },
  desert(k, r, s) {
    for (let i = 0; i < 26; i++) {
      const x = s.side * (s.inner + 3 + r() * 60), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.8 + r() * 1.2;
      if (r() < 0.5) {
        const g = pick(r, ["#3f8f4a", "#4f9a50", "#2f7a42"]);
        k.add(G.cyl, [x, 2 * sc, z], [0.9 * sc, 4 * sc, 0.9 * sc], g); k.add(G.sphere, [x, 4 * sc, z], 0.9 * sc, g);
        k.add(G.cyl, [x + 0.9 * sc, 2.6 * sc, z], [0.6 * sc, 1.8 * sc, 0.6 * sc], g); k.add(G.sphere, [x + 0.9 * sc, 3.5 * sc, z], 0.6 * sc, g);
      } else if (r() < 0.4) k.add(G.dode, [x, 0.5, z], [2.5 * sc, 1.6 * sc, 2 * sc], "#b0703f", { layer: "flat", rot: [0, r() * 3, 0] });
      else k.add(G.sphere, [x, -1, z], [14 * sc, 4 * sc, 8 * sc], "#e0bd85");
    }
    for (let i = 0; i < 2; i++) {
      const x = s.side * (s.inner + 70 + r() * 60), z = s.z0 - r() * (s.z0 - s.z1), w = 20 + r() * 25, h = 14 + r() * 20;
      k.add(G.cyl6, [x, h / 2, z], [w, h, w * 0.8], "#b5643a", { layer: "flat" }); k.add(G.cyl6, [x, h + 0.6, z], [w * 1.04, 1.2, w * 0.84], "#cf7b48", { layer: "flat" });
    }
  },
  snow(k, r, s) {
    for (let i = 0; i < 55; i++) {
      const x = s.side * (s.inner + 2 + Math.pow(r(), 1.3) * 70), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.8 + r() * 1.5;
      if (r() < 0.75) {
        k.add(G.cyl6, [x, sc * 0.6, z], [0.4 * sc, 1.2 * sc, 0.4 * sc], "#4a321c");
        for (let t = 0; t < 3; t++) { k.add(G.cone, [x, sc * (1.7 + t * 1.1), z], [sc * (2.6 - t * 0.6), sc * 1.8, sc * (2.6 - t * 0.6)], "#2c5e45", { layer: "flat" }); k.add(G.cone, [x, sc * (2.05 + t * 1.1), z], [sc * (1.5 - t * 0.35), sc * 1.0, sc * (1.5 - t * 0.35)], "#f4f8ff", { layer: "flat" }); }
      } else if (r() < 0.25) {
        k.add(G.sphere, [x, 0.7, z], 1.4, "#ffffff"); k.add(G.sphere, [x, 1.75, z], 1.0, "#ffffff"); k.add(G.sphere, [x, 2.55, z], 0.7, "#ffffff");
        k.add(G.cone, [x, 2.55, z - s.side * 0.5], [0.16, 0.6, 0.16], "#ff7a1a", { rot: [0, 0, s.side * Math.PI / 2] });
      } else k.add(G.sphere, [x, 0, z], [4 * sc, 1.5 * sc, 3 * sc], "#f2f7ff");
    }
  },
  beach(k, r, s) {
    if (s.side > 0) return; // ocean on the right
    for (let i = 0; i < 22; i++) {
      const x = s.side * (s.inner + 3 + r() * 40), z = s.z0 - r() * (s.z0 - s.z1), h = 6 + r() * 5, lean = (r() - 0.5) * 0.5;
      for (let t = 0; t < 6; t++) k.add(G.cyl6, [x + Math.sin(lean) * t * h / 6, t * h / 6 + 0.5, z], [0.5 - t * 0.04, h / 6 + 0.1, 0.5 - t * 0.04], t % 2 ? "#8a6236" : "#9c7140");
      const tx = x + Math.sin(lean) * h, ty = h + 0.4;
      for (let l = 0; l < 7; l++) { const a = (l / 7) * Math.PI * 2; k.add(G.cone4, [tx + Math.cos(a) * 1.6, ty - 0.4, z + Math.sin(a) * 1.6], [0.9, 4, 0.2], "#3fa34d", { layer: "flat", rot: [Math.sin(a) * 1.2, -a, Math.cos(a) * -1.2] }); }
      if (r() < 0.35) { const ux = s.side * (s.inner + 2 + r() * 6); k.add(G.cyl, [ux, 1.3, z - 3], [0.08, 2.6, 0.08], "#ffffff"); k.add(G.cone, [ux, 2.7, z - 3], [3.2, 0.9, 3.2], pick(r, ["#ff5a5a", "#ffd23f", "#3ec8ff"])); }
    }
  },
  space(k, r, s) {
    for (let i = 0; i < 24; i++) {
      const x = s.side * (s.inner + 4 + r() * 70), y = -10 + r() * 40, z = s.z0 - r() * (s.z0 - s.z1), sc = 1 + r() * 5;
      if (r() < 0.75) k.add(G.dode, [x, y, z], [sc, sc * (0.6 + r() * 0.6), sc], pick(r, ["#5b5266", "#6b5f78", "#4a4356"]), { layer: "flat", rot: [r() * 3, r() * 3, r() * 3] });
      else k.add(G.ico, [x, y, z], [0.8, 2.4, 0.8], pick(r, ["#3ef0ff", "#b46bff", "#ff2fa0"]), { layer: "glow", rot: [r(), r() * 3, r()] });
    }
    for (let z = s.z0 - 6; z > s.z1; z -= 12) k.add(G.box, [s.side * (s.inner + 0.5), -1.5, z], [0.12, 0.12, 5], "#3ef0ff", { layer: "glow" });
  },
  candy(k, r, s) {
    for (let i = 0; i < 34; i++) {
      const x = s.side * (s.inner + 2 + Math.pow(r(), 1.2) * 60), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.8 + r() * 1.6, c = pick(r, ["#ff5fa8", "#5fd3ff", "#ffd23f", "#8cff7a", "#b98cff", "#ff8a5f"]);
      const t = r();
      if (t < 0.4) { k.add(G.cyl, [x, 2.5 * sc, z], [0.25, 5 * sc, 0.25], "#ffffff"); k.add(G.cyl, [x, 5 * sc, z], [3 * sc, 0.6, 3 * sc], c, { rot: [Math.PI / 2, 0, 0] }); k.add(G.torus, [x, 5 * sc, z], [3.4 * sc, 3.4 * sc, 2], "#ffffff"); }
      else if (t < 0.75) k.add(G.sphere, [x, 0, z], [2.4 * sc, 3 * sc, 2.4 * sc], c);
      else { k.add(G.cyl, [x, 1.2 * sc, z], [3 * sc, 2.4 * sc, 3 * sc], "#c98a5a"); k.add(G.sphere, [x, 2.6 * sc, z], [3.4 * sc, 2 * sc, 3.4 * sc], c); k.add(G.sphere, [x, 4 * sc, z], 0.6 * sc, "#ff2040"); }
    }
  },
  volcano(k, r, s) {
    for (let i = 0; i < 34; i++) {
      const x = s.side * (s.inner + 2 + r() * 60), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.6 + r() * 2;
      if (r() < 0.6) k.add(G.cone4, [x, sc * 2, z], [sc * 2.5, sc * 4 * (0.6 + r()), sc * 2.5], pick(r, ["#2b2220", "#3a2c28", "#1f1716"]), { layer: "flat", rot: [0, r() * 3, (r() - 0.5) * 0.4] });
      else k.add(G.cyl, [x, 0.05, z], [sc * 2, 0.1, sc * 1.5], "#b33a0c", { layer: "glow" });
    }
    const x = s.side * (s.inner + 90 + r() * 40), z = (s.z0 + s.z1) / 2;
    k.add(G.cone, [x, 22, z], [70, 44, 70], "#241a18", { layer: "flat" }); k.add(G.cyl, [x, 44, z], [12, 1, 12], "#ff6a1a", { layer: "glow" });
  },
  coral(k, r, s) {
    for (let i = 0; i < 45; i++) {
      const x = s.side * (s.inner + 2 + r() * 50), z = s.z0 - r() * (s.z0 - s.z1), sc = 0.6 + r() * 1.4, c = pick(r, ["#ff6f91", "#ffb347", "#b46bff", "#3ef0c8", "#ff4f6d"]);
      const t = r();
      if (t < 0.35) for (let b = 0; b < 4; b++) k.add(G.cyl6, [x + (r() - 0.5) * 1.5 * sc, sc * (1 + r() * 2), z + (r() - 0.5) * 1.5 * sc], [0.35 * sc, sc * (2 + r() * 3), 0.35 * sc], c, { layer: "flat", rot: [(r() - 0.5) * 0.8, 0, (r() - 0.5) * 0.8] });
      else if (t < 0.65) for (let b = 0; b < 5; b++) k.add(G.cyl6, [x + b * 0.3, sc * 3, z], [0.15, sc * 6 * (0.6 + r() * 0.6), 0.15], "#2f9e5a", { rot: [0, 0, (r() - 0.5) * 0.3] });
      else if (t < 0.85) k.add(G.ico1, [x, 0.6 * sc, z], [sc * 2, sc * 1.2, sc * 2], c, { layer: "flat" });
      else k.add(G.sphere, [x, 0.4, z], [0.5, 0.3, 0.5], "#fff1c9", { layer: "glow" });
    }
  },
  synth(k, r, s) {
    for (let i = 0; i < 10; i++) {
      const x = s.side * (s.inner + 6 + r() * 40), z = s.z0 - r() * (s.z0 - s.z1), h = 7 + r() * 5;
      k.add(G.cyl6, [x, h / 2, z], [0.4, h, 0.4], "#1a0830");
      for (let l = 0; l < 7; l++) { const a = (l / 7) * Math.PI * 2; k.add(G.cone4, [x + Math.cos(a) * 1.6, h - 0.4, z + Math.sin(a) * 1.6], [0.9, 4, 0.2], "#120420", { rot: [Math.sin(a) * 1.2, -a, Math.cos(a) * -1.2] }); }
    }
    for (let i = 0; i < 3; i++) {
      const x = s.side * (s.inner + 60 + r() * 50), z = s.z0 - r() * (s.z0 - s.z1), h = 15 + r() * 25;
      k.add(G.cone4, [x, h / 2, z], [h * 1.6, h, h * 1.6], "#16052b", { layer: "flat", rot: [0, Math.PI / 4, 0] });
      k.add(G.cone4, [x, h / 2 + 0.05, z], [h * 1.62, h * 1.01, h * 1.62], "#ff2fa0", { layer: "glow", rot: [0, Math.PI / 4, 0] });
    }
    k.add(G.box, [s.side * (s.inner + 0.3), 0.15, (s.z0 + s.z1) / 2], [0.25, 0.3, s.z0 - s.z1], "#3ef0ff", { layer: "glow" });
  },
};

// ---------- skies ----------
function gradientSky(p) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(p.top) }, mid: { value: new THREE.Color(p.mid) }, hor: { value: new THREE.Color(p.horizon) }, sunDir: { value: new THREE.Vector3(...p.sun[2]).normalize() }, sunCol: { value: new THREE.Color(p.sun[0]) }, synth: { value: p.sky === "synth" ? 1 : 0 }, space: { value: p.sky === "space" ? 1 : 0 } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }",
    fragmentShader: `uniform vec3 top, mid, hor, sunCol, sunDir; uniform float synth, space; varying vec3 vDir;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
      float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(mix(hor, mid, smoothstep(0.0, 0.25, y)), top, smoothstep(0.2, 0.9, y)) : hor * 0.6;
        float s = max(dot(vDir, normalize(sunDir)), 0.0); c += sunCol * (pow(s, 600.0) * 2.5 + pow(s, 12.0) * 0.25);
        if (synth > 0.5) { vec3 d = normalize(vec3(0.0, 0.12, -1.0)); float a = acos(clamp(dot(vDir, d), -1.0, 1.0));
          if (a < 0.28) { float band = vDir.y < 0.1 ? step(0.5, fract((vDir.y - 0.12) * 60.0)) : 1.0; vec3 sc = mix(vec3(1.0,0.25,0.6), vec3(1.0,0.85,0.2), smoothstep(-0.1, 0.35, vDir.y)); c = mix(c, sc * 2.2, band * smoothstep(0.28, 0.27, a)); }
          c += vec3(1.0, 0.2, 0.6) * smoothstep(0.6, 0.25, a) * 0.25; }
        if (space > 0.5) { float n = n3(vDir * 3.0) * 0.6 + n3(vDir * 7.0) * 0.3 + n3(vDir * 15.0) * 0.1; c += mix(vec3(0.35,0.1,0.6), vec3(0.05,0.35,0.6), n3(vDir*2.0)) * pow(n, 3.0) * 1.4; }
        gl_FragColor = vec4(c, 1.0); }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), mat);
}
function stars(count = 2500, r = 1100) {
  const pos = new Float32Array(count * 3), size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * s * r, Math.abs(u) * r * 0.95 + 20, Math.sin(a) * s * r], i * 3); size[i] = Math.random() < 0.05 ? 4 : 1 + Math.random() * 1.6;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, uniforms: { t: { value: 0 } },
    vertexShader: "attribute float size; uniform float t; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vA = 0.6 + 0.4 * sin(t * 2.0 + position.x * 0.13 + position.z * 0.07); gl_PointSize = size * 1.6; gl_Position = projectionMatrix * mv; gl_Position.z = gl_Position.w * 0.9999; }",
    fragmentShader: "varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * 1.6, smoothstep(0.5, 0.0, d) * vA); }" });
  return new THREE.Points(g, m);
}

// ---------- weather ----------
function weather(kind) {
  const n = kind === "snow" ? 1800 : 600, R = 60, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * R * 2, Math.random() * 30, (Math.random() - 0.5) * R * 2], i * 3);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const color = { snow: "#ffffff", embers: "#ff7a2a", bubbles: "#bff4ff", dust: "#b9a8ff" }[kind];
  const m = new THREE.PointsMaterial({ color: new THREE.Color(color).multiplyScalar(kind === "embers" ? 3 : 1.4), size: kind === "snow" ? 0.18 : 0.14, map: radialTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(g, m);
  const vy = { snow: -2.2, embers: 2.5, bubbles: 2, dust: 0.2 }[kind];
  pts.userData.update = (dt, t, focus) => {
    const a = g.attributes.position.array;
    for (let i = 0; i < n; i++) {
      a[i * 3 + 1] += vy * dt * (0.6 + (i % 7) * 0.08); a[i * 3] += Math.sin(t + i) * dt * 0.6;
      if (a[i * 3 + 1] < 0) a[i * 3 + 1] += 30; if (a[i * 3 + 1] > 30) a[i * 3 + 1] -= 30;
      for (const [k, c] of [[0, focus.x], [2, focus.z]]) { const d = a[i * 3 + k] - c; if (d > R) a[i * 3 + k] -= R * 2; else if (d < -R) a[i * 3 + k] += R * 2; }
    }
    g.attributes.position.needsUpdate = true;
  };
  return pts;
}

// ---------- ocean ----------
function ocean(color = "#1a7fb0") {
  const g = new THREE.PlaneGeometry(600, 600, 120, 120).rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.15, envMapIntensity: 1.4 });
  const uniforms = { t: { value: 0 } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.t = uniforms.t;
    sh.vertexShader = "uniform float t;\n" + sh.vertexShader
      .replace("#include <beginnormal_vertex>", `vec4 wp0 = modelMatrix * vec4(position, 1.0);
        float dx = cos(wp0.x*0.15 + t*1.2)*0.15*0.9 + cos(wp0.x*0.31 + wp0.z*0.2 + t*1.9)*0.31*0.35;
        float dz = cos(wp0.z*0.22 + t*1.5)*0.22*0.7 + cos(wp0.x*0.31 + wp0.z*0.2 + t*1.9)*0.2*0.35;
        vec3 objectNormal = normalize(vec3(-dx, 1.0, -dz));`)
      .replace("#include <begin_vertex>", `vec3 transformed = position; transformed.y += sin(wp0.x*0.15 + t*1.2)*0.9 + sin(wp0.z*0.22 + t*1.5)*0.7 + sin(wp0.x*0.31 + wp0.z*0.2 + t*1.9)*0.35;`);
  };
  const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.userData.uniforms = uniforms;
  return mesh;
}

function synthGrid() {
  const m = new THREE.ShaderMaterial({ fog: true, uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { col: { value: new THREE.Color("#ff2fa0") } }]),
    vertexShader: "#include <fog_pars_vertex>\nvarying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}",
    fragmentShader: "#include <fog_pars_fragment>\nuniform vec3 col; varying vec3 vW; void main(){ vec2 g = abs(fract(vW.xz / 4.0) - 0.5) / fwidth(vW.xz / 4.0); float l = 1.0 - min(min(g.x, g.y), 1.0); gl_FragColor = vec4(mix(vec3(0.03,0.0,0.07), col * 2.5, l), 1.0);\n#include <fog_fragment>\n}" });
  return new THREE.Mesh(new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2), m);
}

// ---------- main entry ----------
let envCache = null;
export function buildWorld(scene, renderer, opts = {}, rand = Math.random) {
  const p = { ...(PRESETS[opts.preset] || PRESETS["city-night"]), ...(opts.overrides || {}) };
  const layout = opts.layout === "arena" ? "arena" : "strip";
  const width = Math.max(4, Math.min(60, +opts.width || 12)), size = Math.max(20, Math.min(300, +opts.size || 80));
  const trackKind = opts.track === "none" || opts.track === false ? null : TRACKS[opts.track] ? opts.track : p.track;
  const lanes = Math.max(1, Math.min(6, +opts.lanes || 3));
  const root = new THREE.Group(); scene.add(root);
  const updaters = [];
  const t0 = { t: 0 };

  // Sky, fog, lights, reflections.
  let sky;
  if (p.sky === "day") {
    sky = new Sky(); sky.scale.setScalar(1000);
    const u = sky.material.uniforms; u.turbidity.value = p.turbidity ?? 3; u.rayleigh.value = p.elevation < 8 ? 2.5 : 1.2; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - (p.elevation ?? 35)), THREE.MathUtils.degToRad(200));
    u.sunPosition.value.copy(sun);
    p.sun = [p.sun[0], p.sun[1], [sun.x, Math.max(0.25, sun.y), sun.z]];
  } else sky = gradientSky(p);
  sky.material.fog = false;
  root.add(sky);
  if ((p.night && p.stars !== false) || p.sky === "space") { const st = stars(p.sky === "space" ? 4000 : 2200); root.add(st); updaters.push((dt, t) => (st.material.uniforms.t.value = t)); sky.userData.stars = st; }
  scene.fog = new THREE.Fog(p.fog[0], p.fog[1], p.fog[2]);
  scene.background = new THREE.Color(p.fog[0]);
  const hemi = new THREE.HemisphereLight(p.hemi[0], p.hemi[1], p.hemi[2]); root.add(hemi);
  const sun = new THREE.DirectionalLight(p.sun[0], p.sun[1]);
  const sunDir = new THREE.Vector3(...p.sun[2]).normalize();
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 220 });
  root.add(sun, sun.target);
  if (renderer) {
    if (!envCache) { const pm = new THREE.PMREMGenerator(renderer); envCache = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    scene.environment = envCache; scene.environmentIntensity = p.env;
  }

  // Ground that follows the focus with world-stable texture coordinates.
  let ground = null;
  if (p.ground === "grid") { ground = synthGrid(); ground.position.y = -0.02; root.add(ground); }
  else if (p.ground) {
    const map = tex("g-" + p.ground, 512, GROUNDS[p.ground], { repeat: [600 / 24, 600 / 24] });
    ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map, roughness: p.ground === "snow" ? 0.6 : 0.95 }));
    ground.receiveShadow = true; ground.position.y = -0.02; root.add(ground);
  }
  const groundShift = p.ocean ? -(300 - width / 2 - 25) : 0;
  let sea = null;
  if (p.ocean || p.sky === "space") { if (p.ocean) { sea = ocean(); sea.position.set(width / 2 + 330, -0.6, 0); root.add(sea); updaters.push((dt, t) => (sea.material && (sea.userData.uniforms.t.value = t))); } }

  // Shared materials for merged scenery.
  const mats = {
    solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: p.scenery === "candy" ? 0.35 : 0.8, metalness: 0.05 }),
    flat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(3, 3, 3), toneMapped: true }),
  };
  const buildingMats = [0, 1, 2].map((kind) => new THREE.MeshStandardMaterial({
    vertexColors: true, map: facade(kind, !!p.night).map, emissiveMap: facade(kind, !!p.night).emissive,
    emissive: new THREE.Color("#ffffff"), emissiveIntensity: p.night ? 1.6 : 0, roughness: kind === 1 ? 0.25 : 0.7, metalness: kind === 1 ? 0.6 : 0.1,
  }));
  const poolMat = new THREE.MeshBasicMaterial({ map: radialTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color("#ffbf70").multiplyScalar(0.5), fog: true });

  function buildingsMesh(list) {
    const byKind = [[], [], []];
    for (const b of list) {
      const g = G.box.clone();
      g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.h / 2, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d)));
      const uv = g.attributes.uv.array, nrm = g.attributes.normal.array, n = g.attributes.position.count;
      // Box faces are non-indexed triangles; rebuild UVs so windows keep a constant size.
      const pos = g.attributes.position.array;
      for (let i = 0; i < n; i++) {
        const nx = Math.abs(nrm[i * 3]), ny = Math.abs(nrm[i * 3 + 1]);
        const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
        if (ny > 0.5) { uv[i * 2] = 0.005; uv[i * 2 + 1] = 0.995; }
        else { uv[i * 2] = (nx > 0.5 ? pz : px) / 10; uv[i * 2 + 1] = py / 22; }
      }
      const col = new Float32Array(n * 3); _c.set(b.tint).multiplyScalar(p.wallDim ?? (p.night ? 0.45 : 1));
      for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b], i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      byKind[b.kind].push(g);
    }
    const grp = new THREE.Group();
    byKind.forEach((gs, k) => { if (gs.length) { const m = new THREE.Mesh(mergeGeometries(gs), buildingMats[k]); m.castShadow = m.receiveShadow = true; grp.add(m); } });
    return grp;
  }
  function poolsMesh(list) {
    if (!list.length) return null;
    const gs = list.map(([x, z, s]) => { const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); pg.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.05, z), new THREE.Quaternion(), new THREE.Vector3(s, 1, s))); return pg; });
    return new THREE.Mesh(mergeGeometries(gs), poolMat);
  }

  function makeSection(z0, z1, inner, sides) {
    const k = new Kit(), extra = { buildings: [], pools: [] };
    for (const side of sides) SCENERY[p.scenery]?.(k, rand, { z0, z1, side, inner, night: !!p.night }, extra);
    const grp = k.build(mats);
    if (extra.buildings.length) grp.add(buildingsMesh(extra.buildings));
    const pools = poolsMesh(extra.pools); if (pools) grp.add(pools);
    return grp;
  }

  // Track surface.
  function trackMesh(len) {
    if (!trackKind || trackKind === "none" || !TRACKS[trackKind]) return null;
    const map = tex(`t-${trackKind}-${lanes}`, 512, TRACKS[trackKind](lanes), { repeat: [1, len / width] });
    const mat = new THREE.MeshStandardMaterial({ map, roughness: trackKind === "road" ? (p.night ? 0.32 : 0.6) : trackKind === "ice" ? 0.1 : 0.7, metalness: trackKind === "road" ? 0.25 : 0.1 });
    if (EMISSIVE_TRACKS[trackKind]) { mat.emissiveMap = map; mat.emissive = new THREE.Color("#ffffff"); mat.emissiveIntensity = 1.4; }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, len).rotateX(-Math.PI / 2), mat);
    m.receiveShadow = true; m.position.y = 0.01;
    return m;
  }

  // Strip: a ring of chunks recycled along -Z.  Arena: one static ring.
  const CH = 90, N = 5, chunks = [];
  if (layout === "strip") {
    const sides = p.ocean ? [-1] : [-1, 1];
    for (let i = 0; i < N; i++) {
      const g = makeSection(0, -CH, width / 2 + 0.5, sides);
      const tr = trackMesh(CH); if (tr) { tr.position.z = -CH / 2; g.add(tr); }
      g.position.z = CH - i * CH; // first chunk starts behind the player
      root.add(g); chunks.push(g);
    }
  } else {
    const k = new Kit();
    const half = size / 2;
    const wallCol = { city: "#4a4f5a", forest: "#6b4423", desert: "#b5643a", snow: "#cfe3f5", beach: "#c4965f", space: "#3ef0ff", candy: "#ff8fc8", volcano: "#2b2220", coral: "#ff6f91", synth: "#ff2fa0" }[p.scenery] || "#666";
    const glowWall = ["space", "synth"].includes(p.scenery);
    for (const [x, z, w, d] of [[0, -half, size + 1, 1], [0, half, size + 1, 1], [-half, 0, 1, size + 1], [half, 0, 1, size + 1]])
      k.add(G.box, [x, glowWall ? 0.3 : 0.6, z], [w, glowWall ? 0.6 : 1.2, d], wallCol, { layer: glowWall ? "glow" : "solid" });
    root.add(k.build(mats));
    if (trackKind && TRACKS[trackKind] && !["road"].includes(trackKind)) {
      const map = tex(`a-${trackKind}`, 512, TRACKS[trackKind](lanes), { repeat: [size / 16, size / 16] });
      const mat = new THREE.MeshStandardMaterial({ map, roughness: trackKind === "ice" ? 0.1 : 0.7 });
      if (EMISSIVE_TRACKS[trackKind]) { mat.emissiveMap = map; mat.emissive = new THREE.Color("#fff"); mat.emissiveIntensity = 1.2; }
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat); fl.position.y = 0.01; fl.receiveShadow = true; root.add(fl);
    }
    // Scenery around all four sides, beyond the walls.
    for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const sec = makeSection(half + 20, -half - 20, half + 2, [1]);
      sec.rotation.y = rot; root.add(sec);
    }
  }

  let wx = null;
  if (p.weather) { wx = weather(p.weather); root.add(wx); }

  const bloom = p.bloom, exposure = p.exposure;
  return {
    preset: p, layout, width, size, lanes, bloom, exposure,
    laneX: (i) => (i - (lanes - 1) / 2) * (width / lanes),
    update(dt, focus) {
      t0.t += dt;
      for (const u of updaters) u(dt, t0.t);
      sky.position.set(focus.x, 0, focus.z); if (sky.userData.stars) sky.userData.stars.position.set(focus.x, 0, focus.z);
      sun.position.copy(focus).addScaledVector(sunDir, 90); sun.target.position.copy(focus);
      if (ground) {
        ground.position.x = focus.x + groundShift; ground.position.z = focus.z;
        if (ground.material.map) ground.material.map.offset.set((focus.x + groundShift) / 24, -focus.z / 24);
      }
      if (sea) sea.position.z = Math.round(focus.z / 50) * 50;
      if (layout === "strip") for (const c of chunks) {
        if (c.position.z - CH > focus.z + 40) c.position.z -= N * CH;
        else if (c.position.z < focus.z - (N - 1) * CH) c.position.z += N * CH;
      }
      wx?.userData.update(dt, t0.t, focus);
    },
  };
}
