// Game feel: GPU particles (bursts, sparkles, trails) and a tiny synth for sound effects.
import * as THREE from "three";

export class Particles {
  constructor(scene, max = 3000) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ttl = new Float32Array(max); this.grav = new Float32Array(max); this.base = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: "attribute float size; varying vec3 vC; uniform float scale; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }",
      fragmentShader: "varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * (1.0 + a * 1.5), a); }",
    });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false;
    scene.add(this.points);
    this._c = new THREE.Color();
  }
  emit(p, color, { count = 20, speed = 6, life = 0.8, size = 0.5, gravity = -6, spread = 1, up = 0.4 } = {}) {
    this._c.set(color);
    for (let k = 0; k < count; k++) {
      const i = this.n < this.max ? this.n++ : (Math.random() * this.max) | 0;
      this.pos.set([p.x, p.y, p.z], i * 3);
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), v = speed * (0.4 + Math.random() * 0.6);
      this.vel.set([Math.cos(a) * s * v * spread, (Math.abs(u) * (1 - up) + up) * v, Math.sin(a) * s * v * spread], i * 3);
      this.col.set([this._c.r, this._c.g, this._c.b], i * 3);
      this.ttl[i] = this.life[i] = life * (0.6 + Math.random() * 0.6); this.grav[i] = gravity; this.base[i] = size * (0.6 + Math.random() * 0.8);
    }
  }
  update(dt) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      if (w !== i) {
        for (let k = 0; k < 3; k++) { this.pos[w * 3 + k] = this.pos[i * 3 + k]; this.vel[w * 3 + k] = this.vel[i * 3 + k]; this.col[w * 3 + k] = this.col[i * 3 + k]; }
        this.life[w] = this.life[i]; this.ttl[w] = this.ttl[i]; this.grav[w] = this.grav[i]; this.base[w] = this.base[i];
      }
      this.vel[w * 3 + 1] += this.grav[w] * dt;
      for (let k = 0; k < 3; k++) { this.vel[w * 3 + k] *= 0.985; this.pos[w * 3 + k] += this.vel[w * 3 + k] * dt; }
      this.size[w] = this.base[w] * Math.min(1, (this.life[w] / this.ttl[w]) * 1.6);
      w++;
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = g.attributes.size.needsUpdate = true;
  }
}

// Procedural sound effects (no audio files).
export class Sfx {
  constructor() { this.ctx = null; this.muted = false; this.last = {}; }
  unlock() {
    if (!this.ctx) try { this.ctx = new AudioContext(); this.master = this.ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(this.ctx.destination); } catch { return; }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  tone(type, f0, f1, dur, vol = 0.5, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  noise(dur, vol = 0.5, freq = 1200, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay, len = Math.ceil(c.sampleRate * dur), b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = b; f.type = "lowpass"; f.frequency.value = freq; g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t);
  }
  play(name) {
    if (!this.ctx || this.muted) return;
    const now = performance.now(); if (now - (this.last[name] || 0) < 45) return; this.last[name] = now;
    switch (name) {
      case "coin": this.tone("sine", 990, 990, 0.08, 0.4); this.tone("sine", 1480, 1480, 0.18, 0.4, 0.07); break;
      case "jump": this.tone("square", 220, 660, 0.16, 0.18); break;
      case "land": this.noise(0.08, 0.25, 500); break;
      case "crash": this.noise(0.5, 0.9, 900); this.tone("sawtooth", 160, 40, 0.4, 0.3); break;
      case "hurt": this.tone("square", 400, 120, 0.25, 0.25); break;
      case "power": for (let i = 0; i < 5; i++) this.tone("triangle", 440 * 2 ** (i / 4), 440 * 2 ** ((i + 1) / 4), 0.09, 0.3, i * 0.06); break;
      case "whoosh": this.noise(0.3, 0.35, 2500); break;
      case "shoot": this.tone("square", 880, 220, 0.12, 0.15); break;
      case "boom": this.noise(0.8, 1, 400); this.tone("sine", 90, 30, 0.6, 0.6); break;
      case "win": [523, 659, 784, 1046].forEach((f, i) => this.tone("triangle", f, f, 0.25, 0.35, i * 0.12)); break;
      case "lose": [392, 330, 262, 196].forEach((f, i) => this.tone("triangle", f, f * 0.98, 0.3, 0.3, i * 0.15)); break;
      case "click": this.tone("sine", 660, 660, 0.05, 0.2); break;
      default: this.tone("sine", 660, 880, 0.1, 0.25);
    }
  }
}
