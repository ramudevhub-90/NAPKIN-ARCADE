// Builds out/napkin-arcade-demo.mp4 (1920x1080) and its .srt captions from the narration in
// script.mjs, the explainer scenes, a real studio run (sped up) and the live site.
//   node build.mjs            everything
//   node build.mjs <part>     one part: voice | intro | studio | live | outro | assemble
import { chromium } from "playwright";
import ffmpeg from "ffmpeg-static";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTRO, OUTRO, STUDIO, LIVE, VOICE } from "./script.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(HERE, "out"), TMP = path.join(OUT, "tmp");
const SITE = process.env.SITE ?? "https://napkinarcade.revenuerush.in";
const LOCAL_PORT = 8791, LOCAL = `http://localhost:${LOCAL_PORT}`;
const SIZE = { width: 1920, height: 1080 };
const PAD = 0.7; // seconds of quiet after each line
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- Voice (Amazon Polly) ---------------------------------------------

function duration(file) {
  let out;
  try { out = execFileSync(ffmpeg, ["-i", file], { stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch (e) { out = String(e.stderr); }
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}
function polly(v, text, file) {
  execFileSync("aws", ["polly", "synthesize-speech", "--region", "us-east-1", "--profile", process.env.AWS_PROFILE ?? "default",
    "--engine", v.polly, "--voice-id", v.name, "--output-format", "mp3", "--sample-rate", "24000", "--text", text, file], { stdio: "ignore" });
}
function voice(key, text, caption) {
  const wav = path.join(TMP, `${key}.wav`), stamp = path.join(TMP, `${key}.txt`), id = `${JSON.stringify(VOICE)}|${text}`;
  if (!existsSync(wav) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== id) {
    const mp3 = path.join(TMP, `${key}.mp3`);
    try { polly(VOICE, text, mp3); } catch { polly(VOICE.fallback, text, mp3); }
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", mp3, "-ar", "48000", "-ac", "2", wav]);
    writeFileSync(stamp, id);
  }
  return { key, wav, dur: duration(wav), caption: caption ?? text };
}
const lines = () => ({
  intro: INTRO.map((l, i) => ({ ...l, ...voice(`intro-${i}`, l.text, l.caption) })),
  studio: STUDIO.map((l) => ({ ...l, ...voice(`studio-${l.id}`, l.text, l.caption) })),
  live: LIVE.map((l) => ({ ...l, ...voice(`live-${l.id}`, l.text, l.caption) })),
  outro: OUTRO.map((l, i) => ({ ...l, ...voice(`outro-${i}`, l.text, l.caption) })),
});

// ---- Recording helpers -------------------------------------------------

async function recorder(browser, name, opts = {}) {
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: TMP, size: SIZE }, colorScheme: "dark", ...opts });
  const page = await context.newPage();
  const born = Date.now();
  return {
    page, context,
    now: () => (Date.now() - born) / 1000,
    async finish() {
      const video = page.video();
      await context.close();
      const file = path.join(TMP, `${name}.webm`);
      renameSync(await video.path(), file);
      return file;
    },
  };
}

const CAPTION_CSS = `#vcap { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; padding: 34px 220px 44px;
  background: linear-gradient(180deg, transparent, rgba(4,3,10,.92) 35%); color: #f6f3ff; font: 500 34px/1.45 Inter, system-ui, sans-serif;
  text-align: center; text-wrap: balance; pointer-events: none; }
#vtag { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647; padding: 6px 14px; border-radius: 99px;
  background: rgba(10,8,22,.8); color: #3ef0ff; font: 700 15px Inter, sans-serif; letter-spacing: .08em; text-transform: uppercase; pointer-events: none; }`;
async function overlay(page, tag, caption = "") {
  await page.evaluate(([css, tag, caption]) => {
    if (!document.getElementById("vcap")) {
      const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
      const c = document.createElement("div"); c.id = "vcap"; document.body.appendChild(c);
      const t = document.createElement("div"); t.id = "vtag"; document.body.appendChild(t);
    }
    document.getElementById("vtag").textContent = tag;
    document.getElementById("vcap").textContent = caption;
    document.getElementById("vcap").style.display = caption ? "" : "none";
  }, [CAPTION_CSS, tag, caption]);
}

// ---- Intro / outro scenes ---------------------------------------------

async function recordScenes(browser, name, items) {
  const rec = await recorder(browser, name);
  await rec.page.addInitScript((r) => (window.__REC = r), { scenes: items.map((l) => l.scene), durs: items.map((l) => l.dur + PAD), caps: items.map((l) => l.caption) });
  await rec.page.goto(`file://${path.join(HERE, "explainer.html")}`);
  await rec.page.evaluate(() => document.fonts.ready);
  await sleep(2500); // let the 3D background boot
  const start = rec.now();
  await rec.page.evaluate(() => window.__START());
  await rec.page.waitForFunction(() => window.__DONE === true, null, { timeout: 600_000 });
  const video = await rec.finish();
  let t = 0;
  const cues = items.map((l) => { const c = { at: t, ...l }; t += l.dur + PAD; return c; });
  return { video, start, length: t, cues };
}

// ---- A real studio run (local copy of the app, test account) -----------

// The local server shares the live database; sign-in is the real Cognito flow with the judge test
// account (JUDGE_EMAIL / JUDGE_CODE come from the environment, read from SSM when recording).
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server/index.js"], { cwd: ROOT, env: { ...process.env, PORT: String(LOCAL_PORT), LLM_CACHE: "off", PUBLIC_URL: SITE, DAILY_BUILDS_PER_USER: "50" } });
    proc.stdout.on("data", (d) => { if (d.toString().includes("Napkin Arcade on")) resolve({ proc }); });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (c) => reject(new Error(`local server exited ${c}`)));
  });
}

async function signIn(page, next, tries = 2) {
  try { return await signInOnce(page, next); }
  catch (e) { if (tries <= 1) throw e; log("sign-in slow, retrying"); await sleep(3000); return signIn(page, next, tries - 1); }
}
async function signInOnce(page, next) {
  if (!process.env.JUDGE_EMAIL || !/^\d{6}$/.test(process.env.JUDGE_CODE || "")) throw new Error("set JUDGE_EMAIL and JUDGE_CODE to record signed-in pages");
  await page.goto(`${LOCAL}/login?next=${encodeURIComponent(next)}`);
  await page.fill("#email", process.env.JUDGE_EMAIL);
  await page.click("#send");
  await page.waitForSelector("#step2:not(.hidden)", { timeout: 30_000 });
  await page.fill("#code", process.env.JUDGE_CODE);
  await page.click("#verify");
  await page.waitForURL((u) => u.pathname === next.split("?")[0], { timeout: 60_000 });
}

async function recordStudio(browser) {
  const { proc } = await startLocalServer();
  try {
    const rec = await recorder(browser, "studio");
    const { page } = rec;
    await signIn(page, "/studio");
    await page.waitForSelector("#build");
    await page.evaluate(() => { document.documentElement.style.zoom = "1.4"; });
    await overlay(page, "Napkin Arcade · AI studio run, sped up");
    await sleep(1500);

    const T = { start: rec.now() };
    await page.locator("#idea").pressSequentially("A taxi racing through a crowded neon city at night. Dodge traffic and pick up passengers.", { delay: 28 });
    await sleep(600);
    await page.click("#build");
    T.built = rec.now();
    await sleep(2500);
    const hint = await page.locator("#hint").innerText();
    if (hint && !/capped/.test(hint)) throw new Error("studio refused the build: " + hint);
    await sleep(1500);
    await page.evaluate(() => document.getElementById("team").scrollIntoView({ behavior: "smooth", block: "start" }));
    // Milestones, polled from the page.
    const deadline = Date.now() + 15 * 60_000;
    while (!T.final && Date.now() < deadline) {
      const s = await page.evaluate(() => ({
        shots: document.querySelectorAll(".shots").length,
        qa: /QA: build runs|QA passed|QA: game runs/.test(document.getElementById("log")?.innerText || ""),
        tested: document.getElementById("agent-testers")?.classList.contains("done"),
        final: !document.getElementById("final").classList.contains("hidden"),
        error: [...document.querySelectorAll("#log .err")].map((e) => e.innerText).join(" "),
      }));
      const now = rec.now();
      if (s.shots >= 1 && !T.art) T.art = now;
      if (s.shots >= 2 && !T.revised) T.revised = now;
      if (s.qa && !T.qa) { T.qa = now; T.revised ||= now - 2; T.art ||= now - 4; }
      if (s.tested && !T.tested) T.tested = now;
      if (s.final && !T.final) T.final = now;
      if (s.error && /could not|Stopped/.test(s.error)) throw new Error("studio run failed: " + s.error);
      await sleep(250);
    }
    if (!T.final) throw new Error("studio run timed out");
    await page.evaluate(() => document.getElementById("final").scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(9000);
    T.end = rec.now();
    // Keep the server up until the finished game is saved (the version and its public payload).
    const gameId = await page.evaluate(() => /\/play\/([a-z0-9]+)/.exec([...document.querySelectorAll("#final a")].map((a) => a.href).join(" "))?.[1]);
    for (let i = 0; gameId && i < 60; i++) { if ((await page.request.get(`${LOCAL}/api/projects/${gameId}/game3d`)).ok()) break; await sleep(1000); }
    log("studio game", gameId);
    log("studio milestones", JSON.stringify(Object.fromEntries(Object.entries(T).map(([k, v]) => [k, +v.toFixed(1)]))));
    return { video: await rec.finish(), T };
  } finally {
    proc.kill();
  }
}

// ---- The platform, live ---------------------------------------------------
// Recorded on the local server (same code and database as the site) so signed-in pages can be shown.
// Sample players, a group and a tournament come from demo-data.mjs and are removed afterwards.

async function recordLive(browser, items) {
  const { proc } = await startLocalServer();
  const demo = JSON.parse(readFileSync(path.join(TMP, "demo-data.json"), "utf8"));
  const friend = await browser.newContext({ viewport: { width: 960, height: 540 } });
  try {
    const rec = await recorder(browser, "live");
    const { page, context } = rec;
    await context.addInitScript(() => { try { localStorage.setItem("na_name", "Ramu"); localStorage.setItem("na_country", "IN"); } catch {} });
    await signIn(page, "/studio");
    const byId = Object.fromEntries(items.map((l) => [l.id, l]));
    const segs = [], tag = "Napkin Arcade · live platform";
    const lineMs = (l) => (l.dur + PAD) * 1000;
    // One beat: the caption is up, `act` runs while recording, the clip lasts at least the narration.
    const beat = async (l, act = null, { min = 0, share = 1, cue = true } = {}) => {
      await overlay(page, tag, l.caption);
      const want = Math.max(lineMs(l) * share, min), a = rec.now(), t0 = Date.now();
      if (act) await act(want);
      const left = want - (Date.now() - t0);
      if (left > 0) await sleep(left);
      segs.push({ a, b: rec.now(), cue: cue ? l.id : null });
    };
    const go = async (url, wait = 4000) => { await page.goto(url.startsWith("http") || url.startsWith("file") ? url : LOCAL + url); await sleep(wait); };
    const scrollTo = (sel, block = "start") => page.evaluate(([q, b]) => document.querySelector(q)?.scrollIntoView({ behavior: "smooth", block: b }), [sel, block]);

    await go("/play/d91b2502?autoplay=1", 5000); // warm-up (cut)
    await go("/play/d91b2502?autoplay=1", 4500);
    await beat(byId.play);

    await go("/studio/game/d91b2502", 5000);
    await beat(byId.workshop, async (ms) => { await sleep(ms * 0.45); await page.click("#tabFb"); });
    await beat(byId.draft, async (ms) => { await page.click("#tabChat"); await sleep(ms * 0.3); await scrollTo(".versions", "center"); });

    // Multiplayer: this page hosts, a second (unrecorded) player joins from the share link.
    await go("/play/example-runner?friends=1&autoplay=1", 0);
    await page.waitForSelector("#lobby:not(.hidden)", { timeout: 30_000 });
    const room = new URL(page.url()).searchParams.get("room");
    await friend.addInitScript(() => { try { localStorage.setItem("na_name", "Priya"); } catch {} });
    const fp = await friend.newPage();
    await fp.goto(`${LOCAL}/play/example-runner?room=${room}&autoplay=1`);
    await page.waitForFunction(() => document.querySelectorAll("#players li").length >= 2, null, { timeout: 30_000 });
    await sleep(1500);
    await beat(byId.race, async () => { await page.click("#startBtn"); }, { min: 13000 });

    await go("/play/d91b2502", 4000);
    await page.click("#lbBtn"); await sleep(1200);
    await beat(byId.boards, async (ms) => { await sleep(ms * 0.3); await page.click('#lbPeriod [data-period="all"]'); await sleep(ms * 0.3); await page.selectOption("#lbCountry", "IN"); });

    await go(`/studio/groups/${demo.group.gid}`, 3500);
    await beat(byId.community, null, { share: 0.6 });
    await go(`/g/${demo.group.code}`, 2500);
    await beat(byId.community, null, { share: 0.4, cue: false });

    await go(`/t/${demo.tour.code}`, 3500);
    await beat(byId.tournament, async (ms) => { await sleep(ms * 0.55); await page.evaluate(() => window.scrollTo({ top: 260, behavior: "smooth" })); });

    await go("/studio/game/d91b2502", 4500);
    await scrollTo("#publish"); await sleep(1500);
    await beat(byId.publish, async (ms) => { await sleep(ms * 0.8); await page.evaluate(() => window.scrollBy({ top: 160, behavior: "smooth" })); });

    // The playable ad export, opened from disk like an ad network would: end card after 12 s of play.
    await go(`file://${path.join(TMP, "ad/applovin/index.html")}`, 3500);
    await page.keyboard.press("Enter"); await sleep(8000);
    await beat(byId.ad, null, { min: 7500 });

    await go("/studio/game/d91b2502", 4500);
    await scrollTo("#storesBox"); await sleep(1500);
    await beat(byId.stores);

    log("live clips", segs.map((x) => `${x.cue || "-"} ${x.a.toFixed(1)}-${x.b.toFixed(1)}`).join(", "));
    return { video: await rec.finish(), segs };
  } finally {
    await friend.close();
    proc.kill();
  }
}

// ---- Assembly ----------------------------------------------------------

function captionPng(text, file) {
  return chromium.launch().then(async (b) => {
    const p = await b.newPage({ viewport: { width: 1920, height: 260 } });
    await p.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500&display=swap" rel="stylesheet"></head>
      <body style="margin:0;background:transparent"><div style="position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:0 220px 44px;
      background:linear-gradient(180deg,transparent,rgba(4,3,10,.92) 40%);color:#f6f3ff;font:500 34px/1.45 Inter,sans-serif;text-align:center;text-wrap:balance">${text}</div></body></html>`);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: file, omitBackground: true });
    await b.close();
  });
}

function mixAudio(cues) {
  const inputs = [], mix = [];
  cues.forEach((c, i) => { inputs.push("-i", c.wav); mix.push(`[${i + 1}:a]adelay=delays=${Math.round(c.at * 1000)}:all=1[a${i}]`); });
  return { inputs, filter: `${mix.join(";")};${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0[a]` };
}
const X264 = ["-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"];

function encodeStraight(part, name) {
  const out = path.join(TMP, `${name}.mp4`);
  const { inputs, filter } = mixAudio(part.cues);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", part.start.toFixed(3), "-i", part.video, ...inputs,
    "-filter_complex", filter, "-map", "0:v", "-map", "[a]", "-t", part.length.toFixed(3), ...X264, out]);
  return out;
}

// Studio: each beat shows its stretch of the recording, sped up to fit the narration.
async function encodeStudio(studio, items) {
  const out = path.join(TMP, "part-studio.mp4");
  const T = studio.T, args = ["-y", "-loglevel", "error", "-i", studio.video];
  const v = [], cues = [];
  let at = 0;
  for (const [i, l] of items.entries()) {
    const png = path.join(TMP, `cap-studio-${l.id}.png`);
    await captionPng(l.caption, png);
    args.push("-i", png);
    const a = T[l.from], b = Math.max(T[l.to], a + 0.5), D = l.dur + PAD;
    const speed = Math.max(1, (b - a) / D);
    v.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=30,tpad=stop_mode=clone:stop_duration=${D.toFixed(3)},trim=duration=${D.toFixed(3)},setpts=PTS-STARTPTS[s${i}];[s${i}][${i + 1}:v]overlay=0:H-h[v${i}]`);
    cues.push({ at, ...l });
    at += D;
  }
  const { inputs, filter } = mixAudio(cues);
  // Audio inputs come after the caption images.
  const offset = items.length + 1;
  const afilter = filter.replace(/\[(\d+):a\]/g, (_, n) => `[${+n - 1 + offset}:a]`);
  const vfilter = `${v.join(";")};${items.map((_, i) => `[v${i}]`).join("")}concat=n=${items.length}:v=1:a=0[v]`;
  execFileSync(ffmpeg, [...args, ...inputs, "-filter_complex", `${vfilter};${afilter}`, "-map", "[v]", "-map", "[a]", ...X264, out]);
  return { file: out, length: at, cues };
}

function encodeClips(part, lines, name) {
  const out = path.join(TMP, `${name}.mp4`);
  const v = [], cues = [];
  let at = 0;
  part.segs.forEach((g, i) => {
    v.push(`[0:v]trim=start=${g.a.toFixed(3)}:end=${g.b.toFixed(3)},setpts=PTS-STARTPTS,fps=30[c${i}]`);
    if (g.cue) cues.push({ at, ...lines.find((l) => l.id === g.cue) });
    at += g.b - g.a;
  });
  const { inputs, filter } = mixAudio(cues);
  const vf = `${v.join(";")};${part.segs.map((_, i) => `[c${i}]`).join("")}concat=n=${part.segs.length}:v=1:a=0[v]`;
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", part.video, ...inputs, "-filter_complex", `${vf};${filter}`, "-map", "[v]", "-map", "[a]", "-t", at.toFixed(3), ...X264, out]);
  return { file: out, length: at, cues };
}

const srtTime = (t) => { const ms = Math.round(t * 1000), p = (n, w = 2) => String(n).padStart(w, "0"); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };

function concat(files, total, out) {
  const ins = files.flatMap((f) => ["-i", f]);
  const cat = files.map((_, i) => `[${i}:v][${i}:a]`).join("") + `concat=n=${files.length}:v=1:a=1[v0][a0]`;
  const fades = `[v0]fade=t=in:st=0:d=0.8,fade=t=out:st=${(total - 1).toFixed(2)}:d=1[v];[a0]loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=out:st=${(total - 1).toFixed(2)}:d=1[a]`;
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...ins, "-filter_complex", `${cat};${fades}`, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k", out]);
}

// ---- Main --------------------------------------------------------------

const step = process.argv[2] ?? "all";
const saved = path.join(TMP, "parts.json");
const parts = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : {};
const save = () => writeFileSync(saved, JSON.stringify(parts, null, 2));

log("preparing narration");
const L = lines();
const speech = [...L.intro, ...L.studio, ...L.live, ...L.outro].reduce((a, l) => a + l.dur + PAD, 0);
log(`narration: ${speech.toFixed(0)}s including pauses`);
if (step === "voice") process.exit(0);

const browser = ["all", "intro", "studio", "live", "outro"].includes(step) ? await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] }) : null;
if (step === "all" || step === "intro") { log("recording intro"); parts.intro = await recordScenes(browser, "intro", L.intro); save(); }
if (step === "all" || step === "studio") { log("recording a real studio run"); parts.studio = await recordStudio(browser); save(); }
if (step === "all" || step === "live") { log("recording the live site"); parts.live = await recordLive(browser, L.live); save(); }
if (step === "all" || step === "outro") { log("recording outro"); parts.outro = await recordScenes(browser, "outro", L.outro); save(); }
await browser?.close();

if (step === "all" || step === "assemble") {
  log("assembling");
  const pIntro = { ...parts.intro, cues: parts.intro.cues.map((c, i) => ({ ...c, wav: L.intro[i].wav })) };
  const pOutro = { ...parts.outro, cues: parts.outro.cues.map((c, i) => ({ ...c, wav: L.outro[i].wav })) };
  const studio = await encodeStudio(parts.studio, L.studio);
  const segs = [
    { file: encodeStraight(pIntro, "part-intro"), length: pIntro.length, cues: pIntro.cues },
    studio,
    encodeClips(parts.live, L.live, "part-live"),
    { file: encodeStraight(pOutro, "part-outro"), length: pOutro.length, cues: pOutro.cues },
  ];
  const total = segs.reduce((a, s) => a + s.length, 0);
  const out = path.join(OUT, "napkin-arcade-demo.mp4");
  concat(segs.map((s) => s.file), total, out);
  let offset = 0;
  const srt = [];
  for (const s of segs) { for (const c of s.cues) srt.push(`${srt.length + 1}\n${srtTime(offset + c.at)} --> ${srtTime(offset + c.at + c.dur)}\n${c.caption}\n`); offset += s.length; }
  writeFileSync(path.join(OUT, "napkin-arcade-demo.srt"), srt.join("\n"));
  log(`done: ${out} (${Math.floor(total / 60)}m ${Math.round(total % 60)}s)`);
}
