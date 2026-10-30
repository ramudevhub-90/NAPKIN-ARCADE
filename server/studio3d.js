// The 3D AI studio: art director → creative director → 3D artist → developer (writes code)
// → QA bots (run the real code, errors go back to the developer) → AI vision playtesters
// → studio lead proposes tuning/patches → bots test each → keep only improvements.
import { chat, parseJson, BudgetError } from "./llm.js";
import * as P from "./prompts3d.js";
import { lintGame } from "./lint.js";

const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };
export const MAX_BUILDS = 3;
const GOOD_ENOUGH = 86;

async function chatJson(opts) {
  try { return parseJson((await chat(opts)).text); }
  catch (e) {
    if (e instanceof BudgetError) throw e;
    return parseJson((await chat({ ...opts, extra: { ...opts.extra, ...NO_THINK }, temperature: (opts.temperature ?? 0.3) + 0.15 })).text);
  }
}
async function chatCode(opts) {
  try { return P.extractCode((await chat(opts)).text); }
  catch (e) {
    if (e instanceof BudgetError) throw e;
    return P.extractCode((await chat({ ...opts, temperature: (opts.temperature ?? 0.3) + 0.1 })).text);
  }
}

// Summarize bot sessions per skill level.
export function botReport(sessions) {
  const out = {};
  for (const skill of ["novice", "casual", "expert"]) {
    const s = sessions.filter((x) => x.skill === skill);
    if (!s.length) continue;
    const avg = (f) => +(s.reduce((n, x) => n + f(x), 0) / s.length).toFixed(2);
    const causes = {}, endings = {};
    for (const x of s) for (const h of x.hurts) causes[h.cause] = (causes[h.cause] || 0) + 1;
    for (const x of s) { const k = x.outcome === "lost" ? `lost: ${String(x.cause).slice(0, 60)}` : x.outcome; endings[k] = (endings[k] || 0) + 1; }
    out[skill] = {
      runs: s.length, winRate: avg((x) => (x.outcome === "won" ? 1 : 0)), timeoutRate: avg((x) => (x.outcome === "timeout" ? 1 : 0)),
      avgSeconds: avg((x) => x.time), avgProgress: avg((x) => x.progress), avgScore: avg((x) => x.score), avgPickups: avg((x) => x.pickups),
      firstHitUnder4s: avg((x) => (x.hurts[0] && x.hurts[0].t < 4 ? 1 : 0)),
      hitsAtProgress: s.flatMap((x) => x.hurts.map((h) => +h.progress.toFixed(2))).slice(0, 24), hitsBy: causes, endings,
      spawned: s[0]?.spawned || {},
    };
  }
  return out;
}

export function funScore(rep) {
  const notes = [];
  let score = 100;
  // Each skill earns credit for wins and, partly, for how far it gets, so improvements always show.
  const T = { novice: [0.35, 40], casual: [0.65, 55], expert: [0.95, 60] };
  for (const [k, [target, w]] of Object.entries(T)) {
    const r = rep[k]; if (!r) continue;
    const reach = r.winRate + (1 - r.winRate) * r.avgProgress * 0.6; // partial credit for progress
    const d = k === "expert" ? Math.max(0, target - reach) : Math.abs(reach - target) * (r.winRate > target ? 0.6 : 1);
    score -= d * w;
    if (Math.abs(r.winRate - target) > 0.2) notes.push(`${k} players win ${Math.round(r.winRate * 100)}% (target ~${Math.round(target * 100)}%), reaching ${Math.round(r.avgProgress * 100)}% on average.`);
  }
  const c = rep.casual || rep.expert;
  if (c) {
    if (c.timeoutRate > 0.3) { score -= 30 * c.timeoutRate; notes.push("Runs often never end (timeout)."); }
    if (c.avgSeconds < 40) { score -= (40 - c.avgSeconds) * 0.4; notes.push(`Runs are short (${c.avgSeconds}s).`); }
    if (c.firstHitUnder4s > 0.3) { score -= 15 * c.firstHitUnder4s; notes.push("Players get hit in the first 4 seconds."); }
    if (c.avgPickups === 0) { score -= 5; notes.push("Nobody collects anything."); }
  }
  if (!notes.length) notes.push("Difficulty curve looks healthy.");
  return { score: Math.max(0, Math.min(100, Math.round(score))), raw: +score.toFixed(2), notes };
}

// Auto-tuner: eases every difficulty knob in TUNING by name (gaps up, hazard speed and density down, more lives/time).
export function autoEase(tuning, k) {
  const out = {};
  for (const [key, v] of Object.entries(tuning)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const n = key.toLowerCase();
    if (/lives|life|hull|health|hp|shield|invuln|grace|meter|fuel|timer|time|duration|refill|bonus|cooldown/.test(n) && !/drain|decay|burn|cost|spawn|every|interval/.test(n)) {
      out[key] = /cooldown/.test(n) ? +(v / k).toFixed(3) : n.includes("lives") || n.includes("hull") ? Math.round(v + (k > 1.4 ? 2 : 1)) : +(v * k).toFixed(3);
    } else if (/gap|every|interval|spacing|delay|warn|distance|width|lane/.test(n) && !/length|finish|goal/.test(n)) out[key] = +(v * k).toFixed(3);
    else if (/coin|power|pickup|bonus|gem|star|fare|passenger|refill|heal|reward|crystal|pearl|ring/.test(n)) out[key] = /chance|rate|count|per|every/.test(n) && !/every|interval/.test(n) ? +Math.min(1, v * k).toFixed(3) : v;
    else if (/speed|chance|density|rate|count|per|max.*(enem|haz|car|traffic)|drain|decay|burn|accel|aggress|spawn/.test(n) && !/player|move|steer|jump|boost|dash|start/.test(n)) out[key] = +(v / k).toFixed(3);
  }
  return out;
}

// QA beyond crashes: does the game actually play? Uses telemetry from the smoke-test bots.
function gameplayProblems(sessions, meta) {
  const out = [], n = sessions.length || 1;
  const travel = Math.max(...sessions.map((s) => s.travel || 0));
  const spawned = (tag) => Math.max(...sessions.map((s) => s.spawned?.[tag] || 0));
  if (!spawned("player")) out.push('No entity was spawned with tag "player".');
  else if (travel < 6) out.push(`The player never moves (max ${travel} units from the start in ${Math.round(Math.max(...sessions.map((s) => s.time)))} s of play)${meta.forward === "auto" ? ' — META.forward is "auto", so update() must move the player forward along -Z every frame, regardless of input' : ""}.`);
  if (!spawned("hazard") && !spawned("goal") && !spawned("pickup")) out.push("Nothing to play with: no hazards, pickups or goals were ever spawned.");
  if (meta.forward === "auto") {
    const rate = Math.max(...sessions.map((s) => (s.spawned?.hazard || 0) / Math.max(1, s.time)));
    if (rate < 0.35 && sessions.some((s) => s.time > 20)) out.push(`The game is too empty: only ${rate.toFixed(2)} hazards spawn per second. Spawn obstacles at least as densely as the template (about one row every 1-2 seconds).`);
  }
  if (sessions.every((s) => s.outcome === "timeout")) out.push("The game never ends (no win or loss within the test time). Add a finish (distance, waves or a timer) that calls api.win.");
  const lostAtEnd = sessions.filter((s) => s.outcome === "lost" && s.progress >= 0.98 && !(s.hurts || []).length).length;
  if (lostAtEnd / n > 0.5) out.push("Players who reach 100% progress without being hit still LOSE. Reaching the end must call api.win(...).");
  if (sessions.every((s) => !s.progress) && travel >= 6) out.push(`api.progress is never set (always 0) even though the player traveled ${travel} units — call api.progress(0..1) every frame.`);
  if (out.length) out.push(`(Test runs: ${sessions.map((s) => `${s.skill} ${s.outcome} after ${Math.round(s.time)}s, progress ${Math.round(s.progress * 100)}%, traveled ${s.travel}, ${s.cause ? "ended by: " + s.cause : ""}`).join("; ")})`);
  return out.length ? out.join(" ") : null;
}

// TUNING defaults declared in the game module (numbers only).
function defaultTuning(code) {
  const m = code.match(/export\s+const\s+TUNING\s*=\s*\{([\s\S]*?)\};/);
  const out = {};
  if (m) for (const [, k, v] of m[1].matchAll(/([A-Za-z_]\w*)\s*:\s*(-?\d+(?:\.\d+)?)/g)) out[k] = +v;
  return out;
}

// Apply a patch even if whitespace differs from the original.
function patchCode(code, find, replace) {
  if (code.split(find).length === 2) return code.replace(find, () => replace);
  const esc = find.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(esc), m = code.match(re);
  if (!m || code.match(new RegExp(esc, "g")).length !== 1) return null;
  return code.replace(re, () => replace);
}

function applyFix(code, tuning, fix) {
  let c = code;
  for (const p of (fix.patches || []).slice(0, 8)) {
    if (typeof p.find !== "string" || typeof p.replace !== "string" || !p.find.trim()) continue;
    const next = patchCode(c, p.find, p.replace);
    if (next == null) return { error: `patch text not found: ${p.find.trim().slice(0, 60)}` };
    c = next;
  }
  const t = { ...tuning };
  for (const [k, v] of Object.entries(fix.tuning || {})) if (typeof v === "number" && Number.isFinite(v)) t[k] = v;
  return { code: c, tuning: t };
}

// QA loop shared by new games and revisions: lint, smoke-test the real code in the browser lab,
// send exact problems back to the developer until it runs (gameplay warnings go to the lead).
async function qaLoop({ code, models, tuning, browser, budget, emit, agent }) {
  const fixHistory = [];
  for (let attempt = 1; ; attempt++) {
    // Static check first: syntax errors and undeclared variables, found instantly for free.
    const lint = lintGame(code);
    let r = null;
    if (!lint.length) {
      agent("bots", "working", `QA: linter clean — running build smoke tests (attempt ${attempt})…`);
      r = await browser("test", { payload: { code, models, tuning }, runs: 2, maxTime: 90 });
      if (!r) throw new Error("The browser test lab did not answer (keep the studio page open).");
    }
    const crashed = lint.length ? `The linter found ${lint.length} problem(s) — fix ALL of them:\n- ${lint.join("\n- ")}` : r.compileError ? `Module failed to load: ${r.compileError}` : r.sessions.find((s) => s.error) ? `Runtime error: ${JSON.stringify(r.sessions.find((s) => s.error).error)}` : null;
    const stuck = crashed ? null : [gameplayProblems(r.sessions, r.meta || {}), r.multiplayer?.length ? `Multiplayer races: ${r.multiplayer.join(" ")}` : null].filter(Boolean).join(" ") || null;
    const warn = r?.sessions?.[0]?.warnings?.length ? ` (${r.sessions[0].warnings.join("; ")})` : "";
    let problem = crashed || stuck;
    // Point the developer at the exact failing lines.
    const at = problem && problem.match(/blob:[^:]*:[^:]*:(\d+):(\d+)/);
    if (at) {
      const n = +at[1], lines = code.split("\n");
      problem += `\nFailing line ${n}: ${lines[n - 1]?.trim()}\nContext:\n${lines.slice(Math.max(0, n - 4), n + 2).map((l, i) => `${Math.max(1, n - 3) + i}: ${l}`).join("\n")}`;
    }
    emit({ type: "qa", attempt, ok: !problem, problem, lint: lint.length, warnings: r?.sessions?.[0]?.warnings || [] });
    if (!problem) { agent("bots", "done", `QA passed: the game loads, runs and progresses.${warn}`); break; }
    if (attempt > 3 && !crashed) { agent("bots", "done", `QA: game runs; remaining issue goes to the studio lead: ${problem.slice(0, 140)}`); break; }
    if (attempt > 4) throw new Error(`The developer could not fix the build: ${problem}`);
    agent("developer", "working", `QA found a bug — fixing: ${problem.slice(0, 160)}`);
    const before = code;
    code = await chatCode({ role: "designer", messages: P.fixMessages(code, problem, fixHistory), maxTokens: 14000, temperature: 0.2 + attempt * 0.15, budget, purpose: `developer fix ${attempt}`, extra: NO_THINK });
    fixHistory.push(`attempt ${attempt}: ${code === before ? "returned the code unchanged" : "changed the code but the same error happened again"}`);
    emit({ type: "code", code, note: `fix ${attempt}: ${problem.slice(0, 120)}` });
    agent("developer", "done", `Patched the code (${code.split("\n").length} lines).`);
  }
  return code;
}

export async function runStudio({ project, emit, budget, browser }) {
  const { idea, hasDrawing } = project;
  const agent = (a, state, text) => emit({ type: "agent", agent: a, state, text });

  // 1. Art director reads the drawing.
  let concept = { idea };
  if (hasDrawing) {
    agent("art", "working", "Looking at your drawing…");
    const v = await chatJson({ role: "vision", messages: P.visionMessages3d(idea, project.image), maxTokens: 1500, temperature: 0.1, budget, purpose: "art director vision", extra: NO_THINK });
    concept = { ...v, idea };
    agent("art", "done", `Found ${(v.objects || []).map((o) => `${o.name} (${o.role})`).join(", ")}.${v.rules?.length ? ` Rules: ${v.rules.join("; ")}.` : ""}`);
  } else agent("art", "done", "No drawing — working from your words.");

  // 2. Creative director designs the game.
  agent("designer", "working", "Designing the game…");
  const design = await chatJson({ role: "designer", messages: P.designerMessages3d(concept), maxTokens: 3000, temperature: 0.8, budget, purpose: "designer", extra: NO_THINK });
  if (!P.TEMPLATES[design.template]) design.template = design.controls === "move" ? "arena" : design.controls === "steer" ? "flyer" : "runner";
  emit({ type: "design", design });
  agent("designer", "done", `“${design.title}” — ${design.tagline} (${design.template}, ${design.preset}). Twist: ${design.twist || "—"}`);

  // 3. 3D artist builds the characters and props.
  agent("artist", "working", `Modeling ${[design.player?.name, ...(design.entities || []).filter((e) => !e.builtin).map((e) => e.name)].filter(Boolean).join(", ")}…`);
  let models = [];
  try {
    const art = await chatJson({ role: "designer", messages: P.artistMessages(design, await P.loadExampleModels()), maxTokens: 9000, temperature: 0.5, budget, purpose: "3d artist", extra: NO_THINK });
    models = (art.models || []).filter((m) => m && m.name && Array.isArray(m.parts) && m.parts.length).slice(0, 8);
  } catch (e) { if (e instanceof BudgetError) throw e; }
  // Art director reviews renders of the models with vision; weak ones go back to the artist once.
  if (models.length) {
    const looks = Object.fromEntries([[design.player?.name, design.player?.look], ...(design.entities || []).map((e) => [e.name, e.look])]);
    const shots = (await browser("render", { models }, 60e3))?.images || [];
    emit({ type: "modelshots", images: shots, round: 1 });
    if (shots.length) {
      agent("art", "working", "Reviewing the 3D models with vision…");
      const reviews = [];
      for (const sh of shots) {
        try {
          const r = await chatJson({ role: "vision", messages: P.modelReviewMessages(sh.name, looks[sh.name], sh.image), maxTokens: 600, temperature: 0.2, budget, purpose: `model review ${sh.name}`, extra: NO_THINK });
          reviews.push({ name: sh.name, score: +r.score || 0, problems: r.problems || [], fix: r.fix || "" });
        } catch (e) { if (e instanceof BudgetError) throw e; }
      }
      emit({ type: "modelreviews", reviews });
      const weak = reviews.filter((r) => r.score < 8);
      agent("art", "done", reviews.map((r) => `${r.name}: ${r.score}/10${r.problems[0] ? ` (${r.problems[0]})` : ""}`).join(" · "));
      if (weak.length) {
        agent("artist", "working", `Revising ${weak.map((w) => w.name).join(", ")} after the art review…`);
        try {
          const rev = await chatJson({ role: "designer", messages: P.reviseModelsMessages(design, models, weak, await P.loadExampleModels()), maxTokens: 9000, temperature: 0.4, budget, purpose: "3d artist revise", extra: NO_THINK });
          for (const m of rev.models || []) if (m?.name && Array.isArray(m.parts) && m.parts.length) { const i = models.findIndex((x) => x.name === m.name); if (i >= 0) models[i] = m; }
          const shots2 = (await browser("render", { models }, 60e3))?.images || [];
          emit({ type: "modelshots", images: shots2, round: 2 });
        } catch (e) { if (e instanceof BudgetError) throw e; }
        agent("artist", "done", `Revised ${weak.length} model(s) after review.`);
      }
    }
  }
  emit({ type: "models", models });
  agent("artist", "done", models.length ? `Built ${models.length} 3D models: ${models.map((m) => `${m.name} (${m.parts.length} parts)`).join(", ")}.` : "Using the built-in model library.");

  // 4. Developer writes the game code.
  agent("developer", "working", `Writing the game code from the ${design.template} template…`);
  let code = await chatCode({ role: "designer", messages: P.developerMessages3d(design, models, P.templateCode(design.template)), maxTokens: 14000, temperature: 0.4, budget, purpose: "developer", extra: NO_THINK });
  let tuning = {};
  emit({ type: "code", code, note: "first draft" });
  agent("developer", "done", `Wrote ${code.split("\n").length} lines of game code.`);

  // 5. QA: run the real code headless; send crashes back to the developer.
  code = await qaLoop({ code, models, tuning, browser, budget, emit, agent });

  // 6. Playtest → lead → keep only improvements.
  let best = null;
  for (let build = 1; build <= MAX_BUILDS; build++) {
    const payload = { code, models, tuning, title: design.title, pitch: design.tagline };
    emit({ type: "build", build, payload });
    agent("bots", "working", `Build ${build}: 15 bot players (novice, casual, expert) are playing…`);
    const r = await browser("test", { payload, runs: 5, maxTime: 180 });
    const rep = botReport(r?.sessions || []);
    const fun = funScore(rep);
    emit({ type: "swarm", build, report: rep, fun });
    agent("bots", "done", `Fun score ${fun.score}/100. ${fun.notes.slice(0, 2).join(" ")}`);

    agent("testers", "working", "AI playtesters are playing your game with vision…");
    const testers = (await browser("playtest", { payload, personas: ["mia", "joe"] }, 300e3))?.testers || [];
    emit({ type: "testers", build, testers });
    const avgFun = testers.length ? testers.reduce((n, t) => n + (+t.fun || 0), 0) / testers.length : null;
    agent("testers", "done", testers.length ? `Rated ${avgFun.toFixed(1)}/10. ${testers.map((t) => `${t.name}: “${t.frustrated || t.liked}”`).join(" ")}` : "No live playtest this round.");

    const total = Math.round(fun.score * 0.75 + (avgFun ?? fun.score / 10) * 2.5);
    emit({ type: "score", build, fun: fun.score, testers: avgFun, total });
    if (!best || total > best.total) best = { build, payload, total };
    if (total >= GOOD_ENOUGH || build === MAX_BUILDS) break;

    let kept = null;
    const failed = [];
    for (let attempt = 1; attempt <= 2 && !kept; attempt++) {
      agent("lead", "working", attempt === 1 ? "Studying the playtest data…" : "Those ideas didn't help — trying a different approach…");
      const review = await chatJson({ role: "designer", messages: P.leadMessages3d(design, code, { ...tuning }, rep, testers, failed), maxTokens: 5000, temperature: 0.5 + attempt * 0.1, budget, purpose: `lead ${build}.${attempt}`, extra: NO_THINK });
      emit({ type: "review", build, attempt, diagnosis: review.diagnosis || [] });
      const trials = [];
      const fixes = (review.fixes || []).slice(0, 3);
      // The studio's own auto-tuner competes with the lead's ideas when the game is too hard.
      const tooHard = (rep.casual?.winRate ?? 0) < 0.4 || (rep.expert?.winRate ?? 0) < 0.6;
      if (tooHard) {
        const k = attempt === 1 ? 1.35 : 1.8;
        const eased = autoEase(tuning && Object.keys(tuning).length ? { ...defaultTuning(code), ...tuning } : defaultTuning(code), k);
        if (Object.keys(eased).length) fixes.push({ label: `Auto-tuner: ease difficulty x${k}`, why: `Eased ${Object.keys(eased).length} difficulty settings across the board.`, tuning: eased, patches: [] });
      }
      for (const fix of fixes) {
        const cand = applyFix(code, tuning, fix);
        if (!cand.error) { const l = lintGame(cand.code); if (l.length) cand.error = `patch breaks the code: ${l[0]}`; }
        if (cand.error) { trials.push({ label: fix.label, why: fix.why, score: null, rejected: cand.error }); continue; }
        const tr = await browser("test", { payload: { code: cand.code, models, tuning: cand.tuning }, runs: 5, maxTime: 180 });
        const crashed = !tr || tr.compileError || tr.sessions.some((s) => s.error);
        if (crashed) { trials.push({ label: fix.label, why: fix.why, score: null, rejected: tr?.compileError || "crashed" }); continue; }
        const f = funScore(botReport(tr.sessions));
        trials.push({ label: fix.label, why: fix.why, score: f.score, raw: f.raw, notes: f.notes, cand, changes: { tuning: fix.tuning || {}, patches: (fix.patches || []).length } });
      }
      const winner = trials.filter((t) => t.score != null).sort((a, b) => b.raw - a.raw)[0];
      if (winner && winner.raw > fun.raw + 0.5) kept = winner;
      emit({ type: "trials", build, attempt, baseline: fun.score, trials: trials.map((t) => { const { cand, ...rest } = t; return { ...rest, kept: t === kept }; }) });
      for (const t of trials) if (t !== kept) failed.push(`${t.label}: ${t.score == null ? "invalid (" + t.rejected + ")" : "fun " + t.score + " — " + (t.notes || []).slice(0, 2).join("; ")}`);
    }
    agent("lead", "done", kept ? `Kept “${kept.label}”: fun ${fun.score} → ${kept.score}${kept.score === fun.score ? ` (players get further: ${fun.raw.toFixed(0)} → ${kept.raw.toFixed(0)} raw)` : ""}. ${kept.why}` : `No idea beat ${fun.score}; shipping the best build.`);
    if (!kept) break;
    code = kept.cand.code; tuning = kept.cand.tuning;
    if (kept.changes.patches) emit({ type: "code", code, note: `lead: ${kept.label}` });
  }

  emit({ type: "final", build: best.build, total: best.total, payload: best.payload, design });
  return { design, ...best };
}

// A conversational revision of an existing game: plan (with memory) → change tuning/code/art
// → QA loop → bots measure fun before and after. Returns the new payload, or just a reply.
export async function runRevision({ current, design, changelog, history, request, source = "owner", emit, budget, browser }) {
  const agent = (a, state, text) => emit({ type: "agent", agent: a, state, text });
  agent("lead", "working", "Reading your request and the game's history…");
  const plan = await chatJson({ role: "designer", messages: P.changePlanMessages({ design, tuning: current.tuning, models: current.models, changelog, history, request, source }), maxTokens: 3000, temperature: 0.4, budget, purpose: "revision plan", extra: NO_THINK });
  emit({ type: "plan", plan });
  agent("lead", "done", plan.reply || "Planned the change.");
  if (plan.kind === "question") return { reply: plan.reply, changed: false };

  // Baseline fun score of the current version, measured the same way as the new one.
  agent("bots", "working", "Measuring the current version with 15 bot players…");
  const baseRun = await browser("test", { payload: current, runs: 5, maxTime: 180 });
  const before = funScore(botReport(baseRun?.sessions || []));

  let { code, models = [], tuning = {} } = current;
  models = JSON.parse(JSON.stringify(models));
  tuning = { ...tuning };
  for (const [k, v] of Object.entries(plan.tuning || {})) if (typeof v === "number" && Number.isFinite(v)) tuning[k] = v;

  if (Array.isArray(plan.art) && plan.art.length) {
    agent("artist", "working", `Updating ${plan.art.map((a) => a.name).join(", ")}…`);
    try {
      const art = await chatJson({ role: "designer", messages: P.modifyModelsMessages(design, models, plan.art.slice(0, 4), await P.loadExampleModels()), maxTokens: 9000, temperature: 0.4, budget, purpose: "revision art", extra: NO_THINK });
      for (const m of art.models || []) if (m?.name && Array.isArray(m.parts) && m.parts.length) { const i = models.findIndex((x) => x.name === m.name); if (i >= 0) models[i] = m; else models.push(m); }
      const shots = (await browser("render", { models: models.filter((m) => plan.art.some((a) => a.name === m.name)) }, 60e3))?.images || [];
      emit({ type: "modelshots", images: shots, round: 1 });
    } catch (e) { if (e instanceof BudgetError) throw e; }
    agent("artist", "done", "3D models updated.");
  }

  if (plan.codePlan && plan.codePlan.trim()) {
    agent("developer", "working", "Changing the game code…");
    code = await chatCode({ role: "designer", messages: P.modifyCodeMessages(code, plan.codePlan, design), maxTokens: 14000, temperature: 0.3, budget, purpose: "revision code", extra: NO_THINK });
    emit({ type: "code", code, note: `revision: ${plan.summary || request}`.slice(0, 160) });
    agent("developer", "done", `Updated the code (${code.split("\n").length} lines).`);
  }

  code = await qaLoop({ code, models, tuning, browser, budget, emit, agent });
  const payload = { ...current, code, models, tuning };
  agent("bots", "working", "Measuring the new version with 15 bot players…");
  const run = await browser("test", { payload, runs: 5, maxTime: 180 });
  const rep = botReport(run?.sessions || []), after = funScore(rep);
  emit({ type: "swarm", build: "new", report: rep, fun: after });
  agent("bots", "done", `Fun score ${before.score} → ${after.score}. ${after.notes[0] || ""}`);
  emit({ type: "build", build: "new", payload });
  return { reply: plan.reply, summary: plan.summary || request, changed: true, payload, before: before.score, after: after.score, kind: plan.kind };
}
