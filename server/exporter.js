// Publish everywhere: turns a game into ready-to-ship packages. Every target wraps the same offline
// player (three.js + engine + the game in one HTML file, no network needed):
//   html5     zip for game portals (itch.io, Poki, CrazyGames) and any app's WebView
//   playable  playable ads for AppLovin, Unity, ironSource, Mintegral (MRAID), Meta and Google Ads
//   mobile    Capacitor project → Android phone/tablet, Android TV, Fire TV and iOS, with CI builds
//   desktop   Electron project → Windows / macOS / Linux (Steam, Steam Deck, itch.io)
//   tizen     Samsung smart-TV web app        webos   LG smart-TV web app
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PLAYER = path.join(ROOT, "server/build/player.html");
const ASSETS = path.join(ROOT, "server/assets");
const asset = (f) => new Uint8Array(fs.readFileSync(path.join(ASSETS, f)));
export const TARGETS = ["html5", "playable", "mobile", "desktop", "tizen", "webos"];
const SHOWCASE = { runner: "Neon Cab Rush", flyer: "Ring Rider", arena: "Star Pup Panic", skier: "Frost Fall", meteors: "Meteor Mayhem", reef: "Reef Rush" };

let player = null;
function playerHtml() {
  if (!player) {
    if (!fs.existsSync(PLAYER)) throw Object.assign(new Error("The offline player isn't built on this server (npm run build:player)."), { status: 503 });
    player = fs.readFileSync(PLAYER, "utf8");
  }
  return player;
}

// The game to export: a showcase game's source, or the live (published) version of a studio game.
export async function exportSource(id, store) {
  const ex = /^example-([a-z]+)$/.exec(id);
  if (ex && SHOWCASE[ex[1]]) return { id, title: SHOWCASE[ex[1]], payload: { code: fs.readFileSync(path.join(ROOT, "public/engine3d/examples", `${ex[1]}.js`), "utf8") } };
  const meta = await store.getGame(id);
  const { code, models, tuning } = await store.getPayload(id);
  return { id, title: meta.title || "Untitled game", tagline: meta.tagline || "", payload: { code, models, tuning } };
}

const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// The player page with the game (and an optional wrapper script) placed before the engine boots.
export function gameHtml(src, { target = "html5", head = "", wrapper = "", config = {} } = {}) {
  const boot = `<script>window.NAPKIN_GAME=${json({ ...src.payload, title: src.title })};window.NAPKIN_EXPORT=${json({ target, id: src.id, ...config })};</script>${wrapper ? `<script>${wrapper}</script>` : ""}`;
  // Function replacers: game code may contain "$&"-style sequences that string replacements would expand.
  return playerHtml().replace("<title>Napkin Arcade game</title>", () => `<title>${escHtml(src.title)}</title>${head}`).replace("<!--NAPKIN_BOOT-->", () => boot);
}
const slug = (s) => String(s || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "game";
const appId = (src) => `com.napkinarcade.${slug(src.title).replace(/-/g, "").replace(/^(\d)/, "g$1").slice(0, 30) || "game"}`;

// ---------- playable ads ----------
// One wrapper for every network: muted until the first tap, a fixed play window, then an end card
// whose button calls the network's own exit (MRAID open, FbPlayableAd, Google ExitApi, Mintegral install).
const AD_WRAPPER = (network) => `(() => {
  const C = window.NAPKIN_EXPORT.ad, net = ${JSON.stringify(network)};
  const store = () => (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? C.ios : C.android) || C.ios || C.android || C.web || "";
  function exit() {
    try { window.install && window.install(); } catch (e) {}
    if (net === "meta" && window.FbPlayableAd) return FbPlayableAd.onCTAClick();
    if (net === "google" && window.ExitApi) return ExitApi.exit();
    if (window.mraid && mraid.open) return mraid.open(store());
    window.open(store(), "_blank");
  }
  function endCard(won) {
    if (document.getElementById("adEnd")) return;
    try { window.gameEnd && window.gameEnd(); } catch (e) {}
    const d = document.createElement("div"); d.id = "adEnd";
    d.innerHTML = '<div class="card"><h1>' + (won ? "You made it!" : "Nice run!") + '</h1><p>' + (C.line || "Keep playing the full game") + '</p><button class="go" id="adCta">' + (C.cta || "Play now") + '</button></div>';
    d.className = "overlay"; d.style.zIndex = 99; document.body.appendChild(d);
    window.postMessage({ cmd: "freeze" }, "*");
    document.getElementById("adCta").onclick = exit; d.onclick = exit;
  }
  let timer = null;
  addEventListener("napkin:game-start", () => { clearTimeout(timer); timer = setTimeout(() => endCard(true), (C.seconds || 30) * 1000); });
  addEventListener("napkin:game-end", (e) => { clearTimeout(timer); setTimeout(() => endCard(e.detail && e.detail.won), 600); });
  addEventListener("napkin:ready", () => { try { window.gameReady && window.gameReady(); } catch (e) {} });
  // MRAID: wait until the ad container is ready before the game takes the stage.
  if (window.mraid && mraid.getState && mraid.getState() === "loading") { document.documentElement.style.visibility = "hidden"; mraid.addEventListener("ready", () => (document.documentElement.style.visibility = "")); }
})();`;
const NETWORKS = {
  applovin: { name: "AppLovin", mraid: true, limit: 5 }, unity: { name: "Unity Ads", mraid: true, limit: 5 },
  ironsource: { name: "ironSource", mraid: true, limit: 5 }, mintegral: { name: "Mintegral", mraid: true, limit: 5 },
  meta: { name: "Meta (Facebook / Instagram)", limit: 2 }, google: { name: "Google Ads (HTML5)", limit: 5, google: true },
};
function playable(src, ad) {
  const files = {}, sizes = [];
  for (const [key, n] of Object.entries(NETWORKS)) {
    const head = n.mraid ? `<script src="mraid.js"></script>` : n.google ? `<meta name="ad.size" content="width=320,height=480"><script src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>` : "";
    const html = gameHtml(src, { target: `playable-${key}`, head, wrapper: AD_WRAPPER(key), config: { ad } });
    files[`${key}/index.html`] = strToU8(html);
    sizes.push(`- **${n.name}** → \`${key}/index.html\` · ${(html.length / 1048576).toFixed(2)} MB (limit ${n.limit} MB)${html.length > n.limit * 1048576 ? " ⚠️ over the limit" : " ✓"}`);
  }
  files["README.md"] = strToU8(`# ${src.title} — playable ads

One folder per network, each a single self-contained HTML file (no network calls except the network's own SDK).
The ad is muted until the first tap, plays for ${ad.seconds || 30} seconds (or until the run ends), then shows an end card
whose **${ad.cta || "Play now"}** button sends players to your store page.

${sizes.join("\n")}

## Upload
- **AppLovin / Unity / ironSource / Mintegral (MRAID 2.0):** upload \`index.html\` from the network's folder as a playable creative. \`mraid.js\` is provided by the ad SDK at runtime.
- **Meta:** upload \`meta/index.html\` as a playable ad (single HTML, under 2 MB). The CTA calls \`FbPlayableAd.onCTAClick()\`.
- **Google Ads:** zip the contents of \`google/\` and upload it as an HTML5 ad; the button calls \`ExitApi.exit()\`, so set the final URL in the ad.

Store links baked in: iOS ${ad.ios || "—"} · Android ${ad.android || "—"} · Web ${ad.web || "—"}.
Test each file in the network's preview tool before launching a campaign.
`);
  return files;
}

// ---------- in-app ads for the mobile apps (AdMob through Capacitor) ----------
const APP_ADS = `(() => {
  const C = (window.NAPKIN_EXPORT || {}).ads || {};
  const AdMob = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob;
  if (!AdMob || !C.every) return;
  const ios = window.Capacitor.getPlatform() === "ios", adId = ios ? C.interstitialIos : C.interstitialAndroid;
  if (!adId) return;
  let games = 0;
  AdMob.initialize({ initializeForTesting: !!C.test }).then(() => AdMob.prepareInterstitial({ adId, isTesting: !!C.test }));
  addEventListener("napkin:game-end", () => {
    if (++games % C.every) return;
    AdMob.showInterstitial().catch(() => {}).finally(() => AdMob.prepareInterstitial({ adId, isTesting: !!C.test }).catch(() => {}));
  });
})();`;

// ---------- mobile + TV apps (Capacitor) ----------
function mobile(src, opts) {
  const id = opts.appId || appId(src), name = src.title, ads = opts.ads || {};
  const admob = !!(ads.appAndroid || ads.appIos);
  const files = {
    "www/index.html": strToU8(gameHtml(src, { target: "app", wrapper: APP_ADS, config: { ads: admob ? ads : {} } })),
    "package.json": strToU8(JSON.stringify({
      name: slug(name), version: "1.0.0", private: true,
      scripts: { "add:android": "cap add android && node scripts/native.mjs android", "add:ios": "cap add ios && node scripts/native.mjs ios", sync: "cap sync", icons: "capacitor-assets generate --assetPath assets" },
      dependencies: { "@capacitor/android": "^6.1.2", "@capacitor/core": "^6.1.2", "@capacitor/ios": "^6.1.2", ...(admob ? { "@capacitor-community/admob": "^6.0.0" } : {}) },
      devDependencies: { "@capacitor/cli": "^6.1.2", "@capacitor/assets": "^3.0.5" },
    }, null, 2)),
    "capacitor.config.json": strToU8(JSON.stringify({ appId: id, appName: name, webDir: "www", backgroundColor: "#07060d", android: { allowMixedContent: false }, ios: { contentInset: "never" } }, null, 2)),
    "assets/icon-only.png": asset("icon-1024.png"), "assets/splash.png": asset("icon-1024.png"), "assets/tv-banner.png": asset("tv-banner.png"),
    "scripts/native.mjs": strToU8(`// Runs after "cap add": landscape fullscreen, controller + TV remote support, Android TV / Fire TV launcher entry, AdMob ids.
import fs from "node:fs";
const platform = process.argv[2], ads = ${JSON.stringify({ appAndroid: ads.appAndroid || "", appIos: ads.appIos || "" })};
// Store releases need a higher build number each time: VERSION_CODE / VERSION_NAME come from the release.
const code = process.env.VERSION_CODE, name = process.env.VERSION_NAME;
if (platform === "android") {
  const mf = "android/app/src/main/AndroidManifest.xml";
  let x = fs.readFileSync(mf, "utf8");
  if (!x.includes("android.software.leanback")) x = x.replace("<application", '<uses-feature android:name="android.hardware.touchscreen" android:required="false" />\\n    <uses-feature android:name="android.software.leanback" android:required="false" />\\n    <uses-feature android:name="android.hardware.gamepad" android:required="false" />\\n    <application android:banner="@drawable/tv_banner"');
  x = x.replace(/<category android:name="android.intent.category.LAUNCHER" \\/>(?![\\s\\S]*LEANBACK_LAUNCHER)/, '<category android:name="android.intent.category.LAUNCHER" />\\n                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />');
  x = x.replace(/android:name=".MainActivity"/, 'android:name=".MainActivity"\\n            android:screenOrientation="sensorLandscape"');
  if (ads.appAndroid && !x.includes("APPLICATION_ID")) x = x.replace("</application>", '    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="' + ads.appAndroid + '"/>\\n    </application>');
  fs.writeFileSync(mf, x);
  fs.mkdirSync("android/app/src/main/res/drawable", { recursive: true });
  fs.copyFileSync("assets/tv-banner.png", "android/app/src/main/res/drawable/tv_banner.png");
  if (code) {
    const gradle = "android/app/build.gradle";
    fs.writeFileSync(gradle, fs.readFileSync(gradle, "utf8").replace(/versionCode \d+/, "versionCode " + code).replace(/versionName "[^"]*"/, 'versionName "' + name + '"'));
  }
  console.log("Android: TV launcher, landscape, controller support" + (ads.appAndroid ? ", AdMob app id" : "") + (code ? ", version " + name + " (" + code + ")" : ""));
}
if (platform === "ios") {
  const pl = "ios/App/App/Info.plist";
  let x = fs.readFileSync(pl, "utf8");
  x = x.replace(/<key>UISupportedInterfaceOrientations<\\/key>\\s*<array>[\\s\\S]*?<\\/array>/, "<key>UISupportedInterfaceOrientations</key>\\n\\t<array>\\n\\t\\t<string>UIInterfaceOrientationLandscapeLeft</string>\\n\\t\\t<string>UIInterfaceOrientationLandscapeRight</string>\\n\\t</array>");
  if (!x.includes("UIRequiresFullScreen")) x = x.replace("<dict>", "<dict>\\n\\t<key>UIRequiresFullScreen</key>\\n\\t<true/>\\n\\t<key>UIStatusBarHidden</key>\\n\\t<true/>");
  if (ads.appIos && !x.includes("GADApplicationIdentifier")) x = x.replace("<dict>", "<dict>\\n\\t<key>GADApplicationIdentifier</key>\\n\\t<string>" + ads.appIos + "</string>");
  fs.writeFileSync(pl, x);
  if (code) {
    const pbx = "ios/App/App.xcodeproj/project.pbxproj";
    fs.writeFileSync(pbx, fs.readFileSync(pbx, "utf8").replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, "CURRENT_PROJECT_VERSION = " + code + ";").replace(/MARKETING_VERSION = [^;]+;/g, "MARKETING_VERSION = " + name + ";"));
  }
  console.log("iOS: landscape, full screen" + (ads.appIos ? ", AdMob app id" : "") + (code ? ", version " + name + " (" + code + ")" : ""));
}
`),
    ".github/workflows/android.yml": strToU8(`name: Android (phone, tablet, Android TV, Fire TV)
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - run: npm install
      - run: npm run add:android && npx capacitor-assets generate --android --assetPath assets && npx cap sync android
      - name: Signing key (optional — add ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD secrets)
        if: \${{ env.KS != '' }}
        env: { KS: "\${{ secrets.ANDROID_KEYSTORE_BASE64 }}" }
        run: echo "$KS" | base64 -d > android/app/release.keystore
      - name: Build
        working-directory: android
        env:
          KS_PASS: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: \${{ secrets.ANDROID_KEY_ALIAS }}
          KEY_PASS: \${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          chmod +x gradlew
          if [ -f app/release.keystore ]; then
            ./gradlew bundleRelease assembleRelease -Pandroid.injected.signing.store.file=$PWD/app/release.keystore -Pandroid.injected.signing.store.password=$KS_PASS -Pandroid.injected.signing.key.alias=$KEY_ALIAS -Pandroid.injected.signing.key.password=$KEY_PASS
          else
            ./gradlew assembleDebug
          fi
      - uses: actions/upload-artifact@v4
        with: { name: android, path: "android/app/build/outputs/**/*.a?b\\nandroid/app/build/outputs/**/*.apk" }
`),
    ".github/workflows/ios.yml": strToU8(`name: iOS
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npm run add:ios && npx capacitor-assets generate --ios --assetPath assets && npx cap sync ios
      - name: Build for the simulator (no signing needed — proves the app builds)
        if: \${{ env.CERT == '' }}
        env: { CERT: "\${{ secrets.IOS_CERT_P12_BASE64 }}" }
        run: xcodebuild -workspace ios/App/App.xcworkspace -scheme App -sdk iphonesimulator -configuration Release CODE_SIGNING_ALLOWED=NO build
      - name: Signed .ipa for the App Store (add IOS_CERT_P12_BASE64, IOS_CERT_PASSWORD, IOS_PROFILE_BASE64, IOS_TEAM_ID secrets)
        if: \${{ env.CERT != '' }}
        env:
          CERT: \${{ secrets.IOS_CERT_P12_BASE64 }}
          CERT_PASS: \${{ secrets.IOS_CERT_PASSWORD }}
          PROFILE: \${{ secrets.IOS_PROFILE_BASE64 }}
          TEAM: \${{ secrets.IOS_TEAM_ID }}
        run: |
          echo "$CERT" | base64 -d > cert.p12 && echo "$PROFILE" | base64 -d > app.mobileprovision
          security create-keychain -p ci build.keychain && security default-keychain -s build.keychain && security unlock-keychain -p ci build.keychain
          security import cert.p12 -k build.keychain -P "$CERT_PASS" -T /usr/bin/codesign && security set-key-partition-list -S apple-tool:,apple: -s -k ci build.keychain
          mkdir -p ~/Library/MobileDevice/Provisioning\\ Profiles && cp app.mobileprovision ~/Library/MobileDevice/Provisioning\\ Profiles/
          xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release -archivePath App.xcarchive DEVELOPMENT_TEAM=$TEAM archive
          printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>method</key><string>app-store</string><key>teamID</key><string>%s</string></dict></plist>' "$TEAM" > export.plist
          xcodebuild -exportArchive -archivePath App.xcarchive -exportOptionsPlist export.plist -exportPath build
      - uses: actions/upload-artifact@v4
        if: \${{ always() }}
        with: { name: ios, path: build/*.ipa, if-no-files-found: ignore }
`),
    "README.md": strToU8(`# ${name} — iOS, Android, Android TV and Fire TV

A [Capacitor](https://capacitorjs.com) app wrapping the offline game (\`www/index.html\`): it plays without internet,
in landscape, with touch, game controllers and TV remotes. App id: \`${id}\` (change it in \`capacitor.config.json\` before your first release).

## Build in the cloud (no Mac or Android Studio needed)
1. Create a GitHub repository and push this folder.
2. **Actions** builds it on every push:
   - **Android** → a debug \`.apk\` you can install right away. Add the signing secrets listed in \`.github/workflows/android.yml\` to get a signed \`.aab\` for Google Play (and the Amazon Appstore for Fire TV).
   - **iOS** → a simulator build to prove it compiles. Add your Apple certificate and provisioning-profile secrets (see \`.github/workflows/ios.yml\`) to get a signed \`.ipa\` for App Store Connect.

## Or build locally
\`\`\`
npm install
npm run add:android   # then: npx cap open android  (Android Studio)
npm run add:ios       # then: npx cap open ios      (Xcode, on a Mac)
\`\`\`
Replace \`assets/icon-only.png\`, \`assets/splash.png\` and \`assets/tv-banner.png\` (320×180) with your own art, then \`npm run icons\`.

## Publishing (your own developer accounts)
- **Google Play** ($25 once): upload the signed \`.aab\`. Tick *Android TV* in the form factors to reach TVs — the app already declares the TV launcher, banner and "no touchscreen required".
- **Amazon Appstore / Fire TV** (free): upload the signed \`.apk\`; it supports the Fire TV remote and controllers.
- **Apple App Store** ($99/year): upload the \`.ipa\` with Transporter or Xcode. Games that play offline with controller support pass review far more easily than web wrappers.
${admob ? `
## Ads (AdMob)
An interstitial shows after every ${ads.every || 3} finished games${ads.test ? " — **test ads are on**; set \"test\" to false in \`www/index.html\` (NAPKIN_EXPORT.ads) before release" : ""}.
AdMob app ids are added to the Android manifest and iOS Info.plist by \`scripts/native.mjs\`.
` : ""}`),
  };
  return files;
}

// ---------- desktop (Electron) ----------
function desktop(src) {
  const name = src.title;
  return {
    "www/index.html": strToU8(gameHtml(src, { target: "desktop" })),
    "main.js": strToU8(`// A borderless full-screen window around the offline game. F11 toggles full screen, Esc opens the game menu.
const { app, BrowserWindow } = require("electron");
const path = require("path");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 720, fullscreen: true, backgroundColor: "#07060d", autoHideMenuBar: true, title: ${JSON.stringify(name)}, webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, "www/index.html"));
  win.webContents.on("before-input-event", (e, input) => { if (input.type === "keyDown" && input.key === "F11") win.setFullScreen(!win.isFullScreen()); });
});
app.on("window-all-closed", () => app.quit());
`),
    "package.json": strToU8(JSON.stringify({
      name: slug(name), productName: name, version: "1.0.0", main: "main.js", private: true,
      scripts: { start: "electron .", dist: "electron-builder" },
      devDependencies: { electron: "^32.2.0", "electron-builder": "^25.1.8" },
      build: { appId: appId(src), files: ["main.js", "www/**/*"], win: { target: "nsis" }, mac: { target: "dmg", category: "public.app-category.games" }, linux: { target: ["AppImage"], category: "Game" } },
    }, null, 2)),
    ".github/workflows/desktop.yml": strToU8(`name: Desktop (Windows, macOS, Linux / Steam Deck)
on: [push, workflow_dispatch]
jobs:
  build:
    strategy: { matrix: { os: [windows-latest, macos-14, ubuntu-latest] } }
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install && npx electron-builder --publish never
      - uses: actions/upload-artifact@v4
        with: { name: "desktop-\${{ matrix.os }}", path: "dist/*.*" }
`),
    "README.md": strToU8(`# ${name} — Windows, macOS, Linux, Steam

\`npm install && npm start\` runs it; \`npm run dist\` builds an installer for your OS. Pushing to GitHub builds all three in **Actions**.
Keyboard, mouse and game controllers (Xbox, PlayStation, Switch Pro) work out of the box.

- **Steam** ($100 per game, Steamworks): upload the Windows build (and the Linux AppImage for **Steam Deck**) with SteamPipe. Mark *Full controller support*.
- **itch.io:** upload the installers, or simply the HTML5 export.
- **Microsoft Store / Xbox:** use the web version through [PWABuilder](https://www.pwabuilder.com) to make an MSIX package.
`),
  };
}

// ---------- smart TVs ----------
function tizen(src) {
  const id = (slug(src.title).replace(/-/g, "") + "0000000000").slice(0, 10);
  return {
    "index.html": strToU8(gameHtml(src, { target: "tizen" })),
    "icon.png": asset("icon-512.png"),
    "config.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://napkinarcade.revenuerush.in/${src.id}" version="1.0.0" viewmodes="maximized">
  <tizen:application id="${id}.${slug(src.title).replace(/-/g, "").slice(0, 20) || "game"}" package="${id}" required_version="3.0"/>
  <content src="index.html"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <icon src="icon.png"/>
  <name>${escHtml(src.title)}</name>
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
  <tizen:profile name="tv-samsung"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`),
    "README.md": strToU8(`# ${src.title} — Samsung Smart TV (Tizen)

1. Install **Tizen Studio** with the TV extension and create a Samsung certificate (Certificate Manager).
2. Package: \`tizen package -t wgt -s <your-certificate-profile> -- .\`  →  \`${slug(src.title)}.wgt\`
3. Test on a TV in Developer Mode (\`sdb connect <tv-ip>\`, then \`tizen install -n *.wgt\`).
4. Publish through **Samsung Apps TV Seller Office**.

The remote works out of the box: arrows move, OK confirms, Back and Play/Pause open the game menu. TVs get the light renderer automatically.
`),
  };
}
function webos(src) {
  const id = appId(src);
  return {
    "index.html": strToU8(gameHtml(src, { target: "webos" })),
    "icon.png": asset("icon-80.png"), "largeIcon.png": asset("icon-130.png"),
    "appinfo.json": strToU8(JSON.stringify({ id, version: "1.0.0", vendor: "Napkin Arcade creator", type: "web", main: "index.html", title: src.title, icon: "icon.png", largeIcon: "largeIcon.png", bgColor: "#07060d", resolution: "1920x1080", disableBackHistoryAPI: true }, null, 2)),
    "README.md": strToU8(`# ${src.title} — LG Smart TV (webOS)

1. Install the **webOS TV CLI** (\`npm i -g @webos-tools/cli\`).
2. Package: \`ares-package .\`  →  \`${id}_1.0.0_all.ipk\`
3. Test on a TV with the Developer Mode app: \`ares-setup-device\`, then \`ares-install --device tv *.ipk\` and \`ares-launch --device tv ${id}\`.
4. Publish through the **LG Seller Lounge**.

Arrows move, OK confirms and the Back button opens the game menu (\`disableBackHistoryAPI\` hands Back to the game).
`),
  };
}

function html5(src) {
  return {
    "index.html": strToU8(gameHtml(src, { target: "html5" })),
    "README.md": strToU8(`# ${src.title} — HTML5

A single offline file: open \`index.html\` in any modern browser. Touch, keyboard and game controllers all work.

- **itch.io:** new project → *Kind: HTML* → upload this zip → *This file will be played in the browser* (viewport 1280×720, fullscreen button on).
- **Poki, CrazyGames, GameDistribution:** submit this zip through their developer portals.
- **Inside your own app:** load \`index.html\` in a WebView (Android \`WebView\`, iOS \`WKWebView\`, Unity WebView, React Native WebView). Listen for \`napkin:game-end\` events to react to a finished run.
`),
  };
}

// Build a target's zip. Returns { name, bytes }.
export function buildExport(target, src, opts = {}) {
  const files = target === "html5" ? html5(src) : target === "playable" ? playable(src, opts.ad || {}) : target === "mobile" ? mobile(src, opts) : target === "desktop" ? desktop(src) : target === "tizen" ? tizen(src) : target === "webos" ? webos(src) : null;
  if (!files) throw Object.assign(new Error("Unknown export target."), { status: 400 });
  return { name: `${slug(src.title)}-${target}.zip`, bytes: zipSync(files, { level: 9 }) };
}
