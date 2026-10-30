// Prompts for the 3D studio: art director (vision), game designer, 3D artist,
// developer (writes the game code), studio lead (tunes/patches) and vision playtesters.
import fs from "node:fs";
import path from "node:path";

const EX = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "engine3d", "examples");
export const TEMPLATES = {
  runner: { file: "runner.js", about: "lane runner / racer / endless runner: auto-forward along -Z, change lanes, jump, traffic & obstacles, finish line" },
  flyer: { file: "flyer.js", about: "flying / swimming / space: auto-forward, steer in X and Y, fly through rings, dodge obstacles" },
  arena: { file: "arena.js", about: "arena: free movement in an open area seen from above, collect items, enemies chase, waves, a power-up that turns the tables" },
  slalom: { file: "skier.js", about: "downhill / slalom / skating / surfing: auto-forward with smooth analog steering, gates to pass for combos, hop over obstacles" },
  survival: { file: "meteors.js", about: "survival arena: dodge telegraphed attacks (warning markers, then impact) until a timer runs out, collect items between attacks" },
};
export const templateCode = (k) => fs.readFileSync(path.join(EX, (TEMPLATES[k] || TEMPLATES.runner).file), "utf8");
export const PRESETS = ["city-night", "city-day", "city-sunset", "forest", "desert", "snow", "beach", "space", "candy", "volcano", "underwater", "synthwave"];
export const BUILTIN_MODELS = ["coin", "gem", "star", "heart", "ring", "finish", "portal", "cone", "barrier", "crate", "car", "truck", "rock", "tree", "pine", "spike", "bomb", "ghost", "hero"];

export const MODEL_DOC = `3D MODEL FORMAT (JSON):
{"name": "taxi", "colors": {"main": "#ffc61a"}, "parts": [
  {"shape": "box", "size": [1.9, 0.6, 4.2], "pos": [0, 0.6, 0], "round": 0.22, "color": "$main", "mat": "paint"},
  {"shape": "wheel", "size": [0.4, 0.3], "pos": [0.9, 0.4, 1.4], "color": "#111111", "mat": "rubber", "mirror": "x", "anim": "wheel"},
  {"shape": "box", "size": [0.45, 0.15, 0.06], "pos": [0.6, 0.7, -2.1], "color": "#fff6d8", "mat": "glow", "intensity": 4, "mirror": "x"}]}
shape + size: box [w,h,d] (+ "round" corner radius) | sphere [r] or [rx,ry,rz] | cylinder [rTop,rBottom,h] | cone [r,h] | pyramid [r,h] | torus [R,tube] (ring in the XY plane) | capsule [r,length] | wheel [r,width] (axle along X) | icosa/dodeca/octa [r] (faceted) | star [r,depth] | heart [r,depth] | plane [w,h].
pos [x,y,z] = part center; rot [x,y,z] in degrees. "mirror": "x" adds a copy at -x (wheels, eyes, ears, wings, arms, legs).
mat: paint (glossy car paint) | metal | chrome | gold | glass (windows, eyes; "opacity" optional) | rubber | plastic | matte | fur | skin | wood | stone | ice | glow (emits light: eyes, lamps, neon, magic; "intensity" 1-5) | checker / stripes (with "color2").
"color": "#hex" or "$main" (recolorable main color, default from "colors").
anim: spin (pickups) | wheel | bob | flap (wings, ears) | swing (legs, arms) | pulse | blink.
Axes: +Y up, +X right, the model FACES -Z (car front, character face toward -Z). 1 unit ≈ 1 meter: a character is 1.5-2 tall, a car about 4 long. The model is placed automatically so its lowest point stands on the ground.
Make bold, readable, charming silhouettes with 8-26 parts: big expressive eyes, clear colors, glowing accents, glass windows, wheels that turn.`;

export const API_DOC = `GAME MODULE CONTRACT — a plain JavaScript ES module. NO imports, NO DOM, NO fetch, NO Math.random, NO module-level mutable state.
export const META = { title, tagline, controls: "lanes"|"steer"|"move", action: "jump"|"dash"|"boost"|"shoot"|"none", forward: "auto"|"input", controlsText };
export const TUNING = { lives: 3, ...every gameplay number: speeds, gaps, spawn rates, level length, enemy speeds };  // the studio lead tunes these — always read them via api.tuning
export const MODELS = [ ...optional extra models in the 3D model format ];
export function setup(api) { ... }        // build the world, spawn the player, put ALL state in api.data
export function update(api, dt) { ... }   // called 60 times per second
Optional: export function bot(api, skill, mem) → {x, y, action}  // only for mechanics a generic dodge-and-collect bot cannot play

AXES: +X right, +Y up, forward is -Z. Ground is y = 0. Entity positions are the model's bottom-center.

WORLD: api.env({ preset, layout, width, lanes, size, track }) → world
  presets: ${PRESETS.join(", ")}
  layout "strip": endless scenery streams along -Z (runners, racers, flyers); width = playable width (lanes * 4 is good); lanes = lane count.
  layout "arena": open square of side "size" with walls (top-down chases, collectors, battles).
  track: road | path | ice | candy | rock | sand | boardwalk | metal | neon | none.
  api.laneX(i) → x of lane i (0 = leftmost). api.world.width, api.world.lanes.

ENTITIES: api.spawn(model, { tag, pos:[x,y,z], vel:[x,y,z], scale, color, rotY, radius, height, spin, data }) → e
  tags: "player" (exactly one) | "hazard" | "pickup" | "goal" | "prop". vel is integrated automatically.
  e.pos (THREE.Vector3, writable) · e.vel · e.obj (THREE.Group of many meshes: use rotation, scale, visible — to recolor use api.tint(e, color, glow)) · e.data · e.radius · e.height · e.tag · e.alive · e.speed (set to spin wheels)
  api.remove(e) · api.entities(tag?) · api.player · api.hit(a, b, pad) · api.hits(e, tag, pad) → touching entity or null · api.nearest(e, tag, maxDist)
  Built-in models: ${BUILTIN_MODELS.join(", ")} (car, truck, gem, ring, portal, ghost, hero accept a color).

INPUT: api.input.x (-1..1, right +) · api.input.y (-1..1, up/forward +) · api.input.action (held) · api.input.left / right / up / down / actionPressed (true only on the frame pressed: use for lane changes and jumps).
CAMERA: api.follow(player, { offset, look, smooth, fov }). Runner: offset [0,4.2,9.5] look [0,1.2,-12]. Arena: offset [0,15,12] look [0,0,-3]. Flyer: offset [0,2.6,9] look [0,0.6,-14].
GAME FLOW: api.progress(0..1) REQUIRED every frame · api.addScore(n, pos?, color?) · api.collect(pickup, points, color) · api.hurt(cause) → true if a life was lost (built-in invulnerability; loses the game at 0 lives) · api.win(text) · api.lose(cause) · api.message(title, subtitle, seconds) banner · api.popup(text, pos, color)
JUICE: api.burst(pos, color, {count, speed, life, size}) · api.explode(pos, color) · api.trail(e, color, {size}) · api.shake(amount) · api.flash(color, alpha) · api.speedFx(0..1) · api.sfx("coin"|"jump"|"land"|"crash"|"hurt"|"power"|"whoosh"|"shoot"|"boom"|"win"|"lose")
RANDOM (seeded): api.rand() · api.range(a, b) · api.int(a, b) · api.pick(arr) · api.chance(p). HELPERS: api.clamp · api.lerp · api.damp(current, target, rate, dt) · api.time · api.THREE

DESIGN RULES: the game must END (win at a finish line, after the last wave, or by surviving a timer) and be winnable by a careful player; always leave a way through (never block every lane); spawn things ahead of the player and remove them once far behind; ramp difficulty over 3 stages announced with api.message; a full run lasts 60-150 seconds; reward skill with juice (popups, bursts, sounds, close calls).`;

export function visionMessages3d(idea, image) {
  return [{
    role: "user",
    content: [
      { type: "text", text: `This photo is a hand-drawn idea for a video game${idea ? ` (the creator also wrote: "${idea}")` : ""}. Read it like a game artist.
Respond ONLY with JSON: {"title": "", "story": "", "setting": "where it takes place", "objects": [{"name": "", "role": "player|enemy|hazard|pickup|goal|scenery", "look": "shape, colors, distinctive details as drawn"}], "rules": ["each handwritten or implied rule"], "mood": "one word"}` },
      { type: "image_url", image_url: { url: image } },
    ],
  }];
}

export function designerMessages3d(concept) {
  const t = Object.entries(TEMPLATES).map(([k, v]) => `"${k}": ${v.about}`).join("\n");
  return [
    { role: "system", content: `You are the creative director of a top mobile game studio. Turn a creator's idea (often a kid's drawing) into a 3D game people would actually want to play today: instantly readable, juicy, a satisfying core loop, a difficulty ramp across 3 stages, and a real ending. Respect the creator's characters, rules and notes.
Pick the gameplay template that fits best (the developer adapts it):
${t}
World presets: ${PRESETS.join(", ")}. Built-in props: ${BUILTIN_MODELS.join(", ")}.
Respond ONLY with JSON:
{"title": "", "tagline": "one exciting line", "template": "runner|flyer|arena|slalom|survival", "preset": "", "track": "", "lanes": 3,
 "controls": "lanes|steer|move", "action": "jump|dash|boost|shoot|none", "controlsText": "",
 "player": {"name": "", "look": "detailed 3D look: shape, colors, details"},
 "entities": [{"name": "", "role": "hazard|pickup|goal|prop", "look": "detailed 3D look", "behavior": "how it moves/acts", "builtin": "optional built-in model to use instead of a custom one"}],
 "stages": ["stage 1 name: what changes", "stage 2 ...", "stage 3 ..."],
 "win": "how the player wins", "lose": "how the player loses",
 "juice": ["moments of delight: close calls, combos, power-ups..."],
 "twist": "one signature mechanic that makes this game special — simple to build on the template (a power-up, a combo, a special pickup, a changing hazard), not a new system"}` },
    { role: "user", content: `Game idea:\n${JSON.stringify(concept)}` },
  ];
}

// Hand-made example models from the templates, shown to the artist as a quality bar.
let exampleModels = null;
export async function loadExampleModels() {
  if (!exampleModels) {
    exampleModels = [];
    for (const v of Object.values(TEMPLATES)) {
      const mod = await import(path.join(EX, v.file));
      exampleModels.push(...(mod.MODELS || []));
    }
  }
  return exampleModels;
}

export function artistMessages(design, examples = []) {
  const custom = [{ name: design.player?.name, look: design.player?.look, role: "player" }, ...(design.entities || []).filter((e) => !e.builtin)].filter((e) => e.name);
  return [
    { role: "system", content: `You are a senior 3D character and prop artist for a stylized, premium mobile game (think Crossy Road meets Pixar toys). Build each requested model from primitives in this format.\n\n${MODEL_DOC}\n\nQUALITY BAR — these hand-made models show the level of detail expected:\n${examples.map((m) => JSON.stringify(m)).join("\n")}\n\nCHECKLIST:\n- Vehicles: rounded body, a separate cabin with glass, FOUR wheels (front and rear pairs, each with "mirror": "x") with chrome hubs, glowing headlights at the front (-Z) and red taillights at the back (+Z), plus one signature detail (roof sign, spoiler, stripes).\n- Characters and animals: body, a big head, expressive eyes (white sphere + dark pupil, mirrored), ears/hair, arms and legs with "swing", one signature accessory.\n- Creatures and enemies: a clear readable silhouette and glowing eyes so they read as dangerous.\n- Pickups: small, bright, glowing, with "spin".\n- 12-28 parts each. Parts must touch or overlap (no floating pieces). Check that every pos lies inside the model's overall size.\nRespond ONLY with JSON: {"models": [ ...one model per request, "name" exactly as requested ]}` },
    { role: "user", content: `Game: "${design.title}" — ${design.tagline}\nWorld: ${design.preset}\nModels to build:\n${custom.map((m) => `- "${m.name}" (${m.role}): ${m.look}`).join("\n")}` },
  ];
}

export function modelReviewMessages(name, look, image) {
  return [{
    role: "user",
    content: [
      { type: "text", text: `You are the art director of a premium mobile game studio reviewing a 3D model render. It should be "${name}": ${look || "(no description)"}.
Judge: does it instantly read as that thing? Is the silhouette appealing? Any floating, missing, misplaced or oversized parts (e.g. wheels missing, eyes off the head, parts hovering in the air)?
Respond ONLY with JSON: {"score": 1-10, "problems": ["specific visible problems"], "fix": "concrete instructions for the 3D artist"}` },
      { type: "image_url", image_url: { url: image } },
    ],
  }];
}

export function reviseModelsMessages(design, models, reviews, examples = []) {
  return [
    ...artistMessages(design, examples).slice(0, 1),
    { role: "user", content: `The art director reviewed renders of your models. Rebuild ONLY these models, fixing every problem:\n${reviews.map((r) => `- "${r.name}" scored ${r.score}/10. Problems: ${(r.problems || []).join("; ")}. Fix: ${r.fix}\n  Current model: ${JSON.stringify(models.find((m) => m.name === r.name))}`).join("\n")}\nRespond ONLY with JSON: {"models": [ ... ]}` },
  ];
}

export function developerMessages3d(design, models, template) {
  return [
    { role: "system", content: `You are a senior gameplay engineer. Write the complete game as one JavaScript module for the Napkin Arcade 3D runtime. The runtime already provides world-class rendering, lighting, effects and sound — you write gameplay.\n\n${API_DOC}\n\nHere is a polished example game in the closest template. Follow its structure and quality, but build THIS game's mechanics, entities, names, stages and twist:\n\`\`\`js\n${template}\n\`\`\`\nKeep the screen busy: spawn at least as densely as the template (something to react to every 1-2 seconds) and keep its spawn-ahead distance. Keep the code focused (under ~300 lines): adapt the template's proven structure, keep its forward movement, spawning, collisions, finish and cleanup, and implement the twist simply. Declare every variable you use.\nRespond with ONLY the complete module in one \`\`\`js code block.` },
    { role: "user", content: `Game design:\n${JSON.stringify(design)}\n\nCustom 3D models available by name: ${models.map((m) => `"${m.name}"`).join(", ") || "none"} (plus the built-ins).` },
  ];
}

export function fixMessages(code, problem, history = []) {
  return [
    { role: "system", content: `You are a senior gameplay engineer fixing a game module for the Napkin Arcade 3D runtime.\n\n${API_DOC}\n\nFix the root cause with the smallest change that keeps the design. If an API is used wrongly, use the documented API instead. Respond with ONLY the complete corrected module in one \`\`\`js code block.` },
    { role: "user", content: `Problem found by QA:\n${problem}\n${history.length ? `\nPrevious fix attempts did NOT solve it:\n- ${history.join("\n- ")}\nChange the failing code differently this time.\n` : ""}\nCode:\n\`\`\`js\n${code}\n\`\`\`` },
  ];
}

export function leadMessages3d(design, code, tuning, report, testers, failed = []) {
  return [
    { role: "system", content: `You are the studio lead. Bots played the current build headless at three skill levels and AI playtesters played it with vision. Great games: novice players win ~35% of runs, casual ~65%, experts ~95%; runs last 60-150 s; players are not hit in the first seconds; deaths are spread out, not all at one spot; pickups get collected.
Base every claim on the data ("endings" says how runs ended, "hitsBy" what hit players, "spawned" what the game created) and on code you can quote. Only call something a bug if you can quote the exact line; never guess.
Propose 3 alternative improvements. Each is a set of TUNING changes and/or small code patches (exact "find" text from the code, replaced by "replace"). Prefer tuning; patch code only for real problems (unfair spawns, a missing ending, a broken mechanic, no way through).
The bots will test every proposal and only a measurable improvement is kept.
Respond ONLY with JSON: {"diagnosis": ["what is wrong and why, citing the data"], "fixes": [{"label": "short name", "why": "one sentence", "tuning": {"key": value}, "patches": [{"find": "exact code", "replace": "new code"}]}]}` },
    { role: "user", content: `Game: ${design.title} — ${design.tagline}\nCurrent TUNING: ${JSON.stringify(tuning)}\nBot report: ${JSON.stringify(report)}\nAI playtesters: ${JSON.stringify(testers)}\n${failed.length ? `Already tried, did NOT help (try something different): ${JSON.stringify(failed)}\n` : ""}\nCode:\n\`\`\`js\n${code}\n\`\`\`` },
  ];
}

export function actMessages3d(persona, meta, frame, memory) {
  const acts = meta.controls === "lanes" ? "left|right|action|wait" : meta.controls === "steer" ? "left|right|up|down|action|wait" : "up|down|left|right|up_left|up_right|action|wait";
  return [{
    role: "user",
    content: [
      { type: "text", text: `You are ${persona.style}, playtesting the 3D game "${meta.title}". ${meta.tagline || ""}
Controls: ${meta.controlsText || meta.controls}${meta.action !== "none" ? `; "action" = ${meta.action}` : ""}. The game is paused while you decide.
Your recent moves and what happened: ${memory.slice(-4).join(" | ") || "none yet"}.
Look at the screenshot and choose your next move. Respond ONLY with JSON: {"thought": "what you notice or feel, max 12 words, in character", "action": "${acts}", "seconds": 0.3-1.5}` },
      { type: "image_url", image_url: { url: frame } },
    ],
  }];
}

export function extractCode(text) {
  const m = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/);
  const code = (m ? m[1] : text).trim();
  if (!/export\s+function\s+update/.test(code)) throw new Error("developer did not return a game module");
  return code;
}

// AI playtester personas and their session summaries (Nemotron Nano).
export const PERSONAS = [
  { id: "mia", name: "Mia, 7", style: "an excited 7-year-old who runs fast and presses jump a lot" },
  { id: "joe", name: "Grandpa Joe", style: "a careful first-time gamer who moves slowly and waits before jumping" },
  { id: "sam", name: "Sam, speedrunner", style: "an experienced gamer who tries to finish as fast as possible" },
];

export function testerSummaryMessages(persona, spec, log) {
  return [
    { role: "system", content: `Summarize a playtest session as the playtester, in character. Respond ONLY with JSON: {"fun": 1-10, "liked": "one sentence", "frustrated": "one sentence or empty", "suggestion": "one concrete change"}` },
    { role: "user", content: `Playtester: ${persona.style}\nGame: ${spec.title}\nSession log (thoughts, actions and what happened):\n${log.join("\n")}` },
  ];
}
