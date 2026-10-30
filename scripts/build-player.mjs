// Builds the offline player: three.js + the engine bundled into one HTML page with no network needs.
// Exports (HTML5 zip, playable ads, mobile/TV/desktop apps) drop a game into it. Run: npm run build:player
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENGINE = path.join(ROOT, "public/engine3d");
const OUT = path.join(ROOT, "server/build/player.html");

const { outputFiles } = await esbuild.build({
  entryPoints: [path.join(ENGINE, "host.js")], bundle: true, format: "esm", minify: true, write: false,
  target: ["es2020", "safari14", "chrome80"], legalComments: "none", logLevel: "warning",
});
const js = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

// The HUD font, embedded so ads and offline apps never call out to Google Fonts.
async function fontFace(family, weight) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&display=swap`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } })).text();
  const latin = css.split("/* latin */")[1] || css;
  const [, url, ext] = /url\((https:[^)]+\.(woff2?))\)/.exec(latin) || [];
  if (!url) throw new Error(`no web font file for ${family}`);
  const b64 = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/${ext};base64,${b64}) format("${ext}")}`;
}
const fonts = (await Promise.all([fontFace("Russo One", 400), fontFace("Inter", 500), fontFace("Inter", 700)])).join("");

let html = fs.readFileSync(path.join(ENGINE, "runtime.html"), "utf8");
html = html.replace(/\s*<link rel="preconnect"[^>]*>/g, "").replace(/\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g, "");
html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, "");
// Function replacers: minified code contains "$&"-style sequences that string replacements would expand.
html = html.replace("<style>", () => `<style>${fonts}\n`);
html = html.replace('<script type="module" src="./host.js"></script>', () => `<!--NAPKIN_BOOT--><script type="module">${js}</script>`);
if (!html.includes("<!--NAPKIN_BOOT-->")) throw new Error("runtime.html changed: boot marker not placed");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`offline player: ${(html.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, OUT)}`);
