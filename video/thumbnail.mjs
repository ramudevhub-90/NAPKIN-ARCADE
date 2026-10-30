// Renders out/napkin-arcade-thumbnail.png (1280x720, YouTube) from a real game frame plus title art.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = process.env.SITE ?? "https://napkinarcade.revenuerush.in";
const b = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });

// 1. A real frame from the engine: the AI-built taxi game, mid-run.
const g = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await g.goto(`${SITE}/engine3d/runtime.html?example=runner&mode=view&quiet=1`);
await g.waitForTimeout(9000);
const bg = (await g.screenshot({ type: "jpeg", quality: 92 })).toString("base64");
await g.close();

// 2. Title art on top, with the Napkin Arcade mark.
const logo = Buffer.from(fs.readFileSync(path.join(HERE, "../public/logo.svg"))).toString("base64");
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await p.setContent(`<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Russo+One&family=Inter:wght@700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 720px; overflow: hidden; font-family: Inter, sans-serif; color: #fff; position: relative; background: #07060d; }
  .bg { position: absolute; inset: 0; background: url(data:image/jpeg;base64,${bg}) center / cover; filter: saturate(1.25) contrast(1.08); }
  .shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(7,6,13,.96) 0%, rgba(7,6,13,.82) 42%, rgba(7,6,13,.05) 75%), linear-gradient(0deg, rgba(7,6,13,.7), transparent 40%); }
  .text { position: absolute; left: 56px; top: 64px; width: 720px; }
  .tag { display: inline-flex; gap: 10px; align-items: center; font: 800 22px Inter; letter-spacing: .06em; text-transform: uppercase; color: #b6f05a; border: 3px solid #76b900; border-radius: 999px; padding: 8px 18px; background: rgba(0,0,0,.45); }
  h1 { font: 96px/0.98 "Russo One", sans-serif; margin-top: 26px; text-shadow: 0 6px 0 rgba(0,0,0,.35); }
  h1 .g { background: linear-gradient(90deg, #3ef0ff, #ff2fa0 55%, #ff8a3d); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 22px rgba(255,47,160,.55)); }
  .sub { font: 800 34px Inter; margin-top: 22px; color: #f1ecff; }
  .napkin { position: absolute; right: 70px; top: 60px; width: 300px; background: #fffdf6; color: #2a2a35; border-radius: 14px; padding: 18px 20px; font: 700 26px/1.25 "Comic Sans MS", "Marker Felt", cursive; transform: rotate(5deg); box-shadow: 0 24px 50px rgba(0,0,0,.55); }
  .napkin small { display: block; font: 800 15px Inter; color: #ff2fa0; letter-spacing: .08em; margin-bottom: 6px; }
  .arrow { position: absolute; right: 250px; top: 250px; font: 90px "Russo One"; color: #ffd23f; transform: rotate(24deg); text-shadow: 0 0 24px rgba(255,210,63,.8); }
  .brand { position: absolute; left: 56px; bottom: 50px; display: flex; align-items: center; gap: 14px; font: 34px "Russo One"; }
  .brand img { width: 62px; height: 62px; filter: drop-shadow(0 8px 20px rgba(255,47,160,.5)); } .brand b { color: #ff6b4a; font-weight: 400; }
  .chips { display: flex; gap: 10px; margin-top: 20px; } .chips span { font: 800 19px Inter; padding: 7px 14px; border-radius: 99px; background: rgba(255,255,255,.1); border: 2px solid rgba(255,255,255,.22); }
  .score { position: absolute; right: 60px; bottom: 56px; background: rgba(7,6,13,.78); border: 3px solid #39ff88; border-radius: 18px; padding: 12px 22px; font: 800 30px Inter; }
  .score b { color: #39ff88; font: 44px "Russo One"; }
</style></head><body>
  <div class="bg"></div><div class="shade"></div>
  <div class="napkin"><small>YOUR IDEA</small>Taxi racing through a neon city at night!</div>
  <div class="text">
    <span class="tag">● NVIDIA Nemotron agents · Nebius</span>
    <h1>AI builds<br>your game<br><span class="g">in 3D</span></h1>
    <p class="sub">Tested by agents. Shipped everywhere.</p>
    <div class="chips"><span>Multiplayer</span><span>Tournaments</span><span>iOS · Android · TV</span></div>
  </div>
  <div class="brand"><img src="data:image/svg+xml;base64,${logo}" alt="">Napkin <b>Arcade</b></div>
  <div class="score">Built in <b>3</b> min</div>
</body></html>`);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(500);
await p.screenshot({ path: path.join(HERE, "out", "napkin-arcade-thumbnail.png") });
await b.close();
console.log("saved out/napkin-arcade-thumbnail.png");
