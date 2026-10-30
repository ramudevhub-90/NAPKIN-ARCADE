// The cloud build: pull the job from Napkin Arcade, build and sign the app, then
//   Android → send the signed .aab back (the server uploads it to Google Play with the creator's key)
//   iOS     → archive with automatic signing and upload to TestFlight with the creator's API key.
// Every step reports back, so the creator sees a live timeline in the workshop.
import fs from "node:fs";
import { execSync } from "node:child_process";

const { API, RELEASE_ID, BUILD_TOKEN, PLATFORM } = process.env;
const base = `${API}/api/builds/${RELEASE_ID}`, auth = { Authorization: `Bearer ${BUILD_TOKEN}` };
const get = async (p, type = "json") => { const r = await fetch(base + p, { headers: auth }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return type === "json" ? r.json() : Buffer.from(await r.arrayBuffer()); };
const post = (p, body, type = "application/json") => fetch(base + p, { method: "POST", headers: { ...auth, "Content-Type": type }, body: type === "application/json" ? JSON.stringify(body) : body });
const status = (state, text) => post("/status", { state, text }).catch(() => {});
const sh = (cmd, opts = {}) => { console.log(`$ ${cmd.replace(/(-P[^ ]*password=|--password |-storepass |-keypass )\S+/g, "$1***")}`); return execSync(cmd, { stdio: "inherit", ...opts }); };

try {
  const job = await get("/job");
  await status("building", `Building ${job.platform === "ios" ? "iOS" : "Android"} ${job.versionName} (${job.versionCode}) on ${job.platform === "ios" ? "macOS" : "Linux"}…`);
  fs.writeFileSync("app.zip", await get("/source", "bin"));
  sh("rm -rf app && mkdir app && cd app && unzip -q ../app.zip");
  const env = { ...process.env, VERSION_CODE: String(job.versionCode), VERSION_NAME: job.versionName };
  sh("npm install --no-audit --no-fund", { cwd: "app" });
  const secrets = await get("/secrets");

  if (PLATFORM === "android") {
    sh("npm run add:android && npx capacitor-assets generate --android --assetPath assets && npx cap sync android", { cwd: "app", env });
    let ks = secrets.keystore;
    if (!ks) {
      // First release: create the app's upload key and hand it to the server (sealed there, downloadable by the creator).
      const pass = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
      sh(`keytool -genkeypair -v -keystore upload.jks -storetype JKS -alias upload -keyalg RSA -keysize 2048 -validity 10000 -storepass ${pass} -keypass ${pass} -dname "CN=${job.appName.replace(/[^\w ]/g, "")}, O=Napkin Arcade creator"`, { cwd: "app" });
      ks = { keystore: fs.readFileSync("app/upload.jks").toString("base64"), storePassword: pass, alias: "upload", keyPassword: pass };
      const r = await post("/keystore", ks);
      if (!r.ok) throw new Error("couldn't save the new upload key");
    } else fs.writeFileSync("app/upload.jks", Buffer.from(ks.keystore, "base64"));
    sh(`chmod +x gradlew && ./gradlew bundleRelease -Pandroid.injected.signing.store.file=$PWD/../upload.jks -Pandroid.injected.signing.store.password=${ks.storePassword} -Pandroid.injected.signing.key.alias=${ks.alias} -Pandroid.injected.signing.key.password=${ks.keyPassword}`, { cwd: "app/android", env });
    await status("uploading", "Signed .aab built — uploading to Google Play…");
    const aab = fs.readFileSync("app/android/app/build/outputs/bundle/release/app-release.aab");
    const r = await post("/artifact", aab, "application/octet-stream");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload failed (${r.status})`);
  } else {
    sh("npm run add:ios && npx capacitor-assets generate --ios --assetPath assets && npx cap sync ios", { cwd: "app", env });
    fs.mkdirSync("private_keys", { recursive: true });
    const keyFile = `${process.cwd()}/private_keys/AuthKey_${secrets.keyId}.p8`;
    fs.writeFileSync(keyFile, secrets.p8);
    const authArgs = `-allowProvisioningUpdates -authenticationKeyPath ${keyFile} -authenticationKeyID ${secrets.keyId} -authenticationKeyIssuerID ${secrets.issuerId}`;
    sh(`xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release -destination "generic/platform=iOS" -archivePath App.xcarchive DEVELOPMENT_TEAM=${secrets.teamId} CODE_SIGN_STYLE=Automatic ${authArgs} archive`, { cwd: "app" });
    fs.writeFileSync("app/export.plist", `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>method</key><string>app-store-connect</string><key>destination</key><string>export</string><key>teamID</key><string>${secrets.teamId}</string><key>signingStyle</key><string>automatic</string></dict></plist>`);
    sh(`xcodebuild -exportArchive -archivePath App.xcarchive -exportOptionsPlist export.plist -exportPath build ${authArgs}`, { cwd: "app" });
    await status("uploading", "Signed .ipa built — uploading to App Store Connect…");
    const ipa = fs.readdirSync("app/build").find((f) => f.endsWith(".ipa"));
    sh(`xcrun altool --upload-app --type ios --file "build/${ipa}" --apiKey ${secrets.keyId} --apiIssuer ${secrets.issuerId}`, { cwd: "app", env: { ...process.env, API_PRIVATE_KEYS_DIR: `${process.cwd()}/private_keys` } });
    fs.rmSync("private_keys", { recursive: true, force: true });
    await status("uploaded", "Uploaded to App Store Connect — Apple is processing it for TestFlight (usually 5–30 minutes).");
  }
} catch (e) {
  await status("failed", `Build failed: ${String(e.message || e).slice(0, 400)}`);
  process.exit(1);
}
