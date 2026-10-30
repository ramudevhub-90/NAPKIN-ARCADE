// App store connector: creators connect Google Play / App Store Connect once, then each game can
// build in the cloud and release to Play internal testing or TestFlight, and from there to production
// or App Review. Store keys are sealed at rest and only used by the server (and, for iOS, the Mac runner).
import crypto from "node:crypto";
import * as play from "./google-play.js";
import * as asc from "./app-store.js";
import { seal, unseal, vaultReady } from "./vault.js";
import { buildsEnabled, dispatchBuild, newBuildToken, hashToken } from "./builds.js";
import { buildExport, exportSource } from "../exporter.js";

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
async function raw(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw fail("Upload too large", 413); chunks.push(c); }
  return Buffer.concat(chunks);
}
const connectionView = (c) => (c ? { connected: true, at: c.at, label: c.label } : { connected: false });
const releaseView = ({ rid, platform, track, state, steps, versionCode, versionName, appId, createdAt, playStatus }) => ({ rid, platform, track, state, steps, versionCode, versionName, appId, createdAt, playStatus });
const ACTIVE = new Set(["queued", "building", "uploading"]);

export async function storeRoutes(req, res, { url, parts, json, body, currentUser, ownedGame, store, publicUrl }) {
  // ---- account connections ----
  if (parts[0] === "api" && parts[1] === "stores") {
    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: "Please sign in." }), true;
    const which = parts[2];
    if (!which) {
      const [g, a] = await Promise.all([store.getConnection(user.sub, "google"), store.getConnection(user.sub, "apple")]);
      return json(res, 200, { enabled: vaultReady(), builds: buildsEnabled(), google: connectionView(g), apple: connectionView(a) }), true;
    }
    if (which === "google" || which === "apple") {
      if (req.method === "DELETE") { await store.deleteConnection(user.sub, which); return json(res, 200, { ok: true }), true; }
      if (req.method === "POST") {
        const b = await body(req, 3e4);
        if (which === "google") {
          const sa = play.parseServiceAccount(b.serviceAccount);
          await store.putConnection(user.sub, "google", { sealed: seal(sa), label: sa.client_email });
          return json(res, 200, { google: { connected: true, label: sa.client_email } }), true;
        }
        const k = asc.parseApiKey(b);
        await store.putConnection(user.sub, "apple", { sealed: seal(k), label: `Key ${k.keyId} · Team ${k.teamId}` });
        return json(res, 200, { apple: { connected: true, label: `Key ${k.keyId} · Team ${k.teamId}` } }), true;
      }
    }
    return json(res, 404, { error: "Not found" }), true;
  }

  // ---- the build runner (authenticated by the release's one-time token) ----
  if (parts[0] === "api" && parts[1] === "builds" && /^[a-f0-9]{16}$/.test(parts[2] || "")) {
    const r = await store.getRelease(parts[2]);
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const okToken = r && r.tokenHash && Date.now() < r.tokenExp && crypto.timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(r.tokenHash));
    if (!okToken) return json(res, 403, { error: "Invalid build token." }), true;
    const what = parts[3];
    if (what === "job") return json(res, 200, { platform: r.platform, track: r.track, versionCode: r.versionCode, versionName: r.versionName, appId: r.appId, appName: r.appName }), true;
    if (what === "source") {
      const out = buildExport("mobile", await exportSource(r.gameId, store), { appId: r.appId, ads: r.ads || {} });
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": out.bytes.length });
      return res.end(Buffer.from(out.bytes)), true;
    }
    if (what === "secrets") {
      if (r.platform === "ios") {
        const conn = await store.getConnection(r.createdBy, "apple");
        if (!conn) return json(res, 409, { error: "App Store Connect isn't connected anymore." }), true;
        const { issuerId, keyId, teamId, p8 } = unseal(conn.sealed);
        return json(res, 200, { issuerId, keyId, teamId, p8 }), true;
      }
      const ks = await store.getKeystore(r.gameId);
      return json(res, 200, { keystore: ks ? unseal(ks.sealed) : null }), true;
    }
    if (what === "keystore" && req.method === "POST") {
      if (await store.getKeystore(r.gameId)) return json(res, 409, { error: "This game already has an upload key." }), true;
      const b = await body(req, 2e5);
      if (!b.keystore || !b.storePassword || !b.alias) return json(res, 400, { error: "Incomplete keystore." }), true;
      await store.putKeystore(r.gameId, seal({ keystore: b.keystore, storePassword: b.storePassword, alias: b.alias, keyPassword: b.keyPassword || b.storePassword }));
      await store.releaseStep(r, "building", "Created this game's Android upload key — download a backup from the workshop.");
      return json(res, 200, { ok: true }), true;
    }
    if (what === "status" && req.method === "POST") {
      const b = await body(req, 2e4);
      if (!["building", "uploading", "uploaded", "failed"].includes(b.state)) return json(res, 400, { error: "Unknown state." }), true;
      await store.releaseStep(r, b.state, String(b.text || "").slice(0, 600), b.state === "failed" || b.state === "uploaded" ? { tokenExp: 0 } : {});
      return json(res, 200, { ok: true }), true;
    }
    // Android: the signed bundle comes back here and the server uploads it with the creator's Play key.
    if (what === "artifact" && req.method === "POST" && r.platform === "android") {
      const aab = await raw(req, 200e6);
      const conn = await store.getConnection(r.createdBy, "google");
      if (!conn) { await store.releaseStep(r, "failed", "Google Play isn't connected anymore.", { tokenExp: 0 }); return json(res, 409, { error: "Google Play isn't connected." }), true; }
      try {
        const out = await play.uploadBundle(unseal(conn.sealed), r.appId, aab, { track: "internal", versionName: r.versionName, notes: r.notes });
        await store.releaseStep(r, "uploaded", out.status === "draft" ? `On Google Play internal testing as a draft (version code ${out.versionCode}) — new apps stay draft until the Play Console setup is finished.` : `Live on Google Play internal testing (version code ${out.versionCode}). Promote it to production when you're happy.`, { tokenExp: 0, playStatus: out.status, playVersionCode: out.versionCode });
        return json(res, 200, { ok: true }), true;
      } catch (e) {
        await store.releaseStep(r, "failed", e.message, { tokenExp: 0 });
        return json(res, e.status || 502, { error: e.message }), true;
      }
    }
    return json(res, 404, { error: "Not found" }), true;
  }

  // ---- per game: store ids, releases, upload-key backup ----
  if (parts[0] === "api" && parts[1] === "projects" && (parts[3] === "stores" || parts[3] === "releases")) {
    const id = parts[2];
    const { user, meta } = await ownedGame(req, id);
    if (parts[3] === "stores" && parts[4] === "keystore") {
      const ks = await store.getKeystore(id);
      if (!ks) return json(res, 404, { error: "No upload key yet — it's created with the first Android release." }), true;
      const k = unseal(ks.sealed);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${id}-upload-key.jks"`, "X-Keystore-Alias": k.alias, "X-Keystore-Password": k.storePassword, "Cache-Control": "no-store" });
      return res.end(Buffer.from(k.keystore, "base64")), true;
    }
    if (parts[3] === "stores") {
      if (req.method === "POST") {
        const b = await body(req, 2e3), androidPackage = String(b.androidPackage || "").trim(), iosBundle = String(b.iosBundle || "").trim();
        if (androidPackage && !play.PACKAGE.test(androidPackage)) return json(res, 400, { error: "The Android package looks like com.yourstudio.gamename (lowercase)." }), true;
        if (iosBundle && !asc.BUNDLE.test(iosBundle)) return json(res, 400, { error: "The iOS bundle id looks like com.yourstudio.gamename." }), true;
        await store.putStoreApp(id, { androidPackage, iosBundle });
      }
      const [app, list, ks, g, a] = await Promise.all([store.getStoreApp(id), store.releases(id), store.getKeystore(id), store.getConnection(user.sub, "google"), store.getConnection(user.sub, "apple")]);
      return json(res, 200, { enabled: vaultReady(), builds: buildsEnabled(), app: { androidPackage: app?.androidPackage || "", iosBundle: app?.iosBundle || "" }, keystore: !!ks, google: connectionView(g), apple: connectionView(a), releases: list.map(releaseView) }), true;
    }
    // Start a release: android → Play internal testing, ios → TestFlight.
    if (parts[3] === "releases" && !parts[4] && req.method === "POST") {
      const b = await body(req, 4e3), platform = b.platform === "ios" ? "ios" : "android";
      const app = await store.getStoreApp(id), appId = platform === "ios" ? app?.iosBundle : app?.androidPackage;
      if (!appId) return json(res, 400, { error: `Set the ${platform === "ios" ? "iOS bundle id" : "Android package name"} first.` }), true;
      if (!(await store.getConnection(user.sub, platform === "ios" ? "apple" : "google"))) return json(res, 400, { error: `Connect ${platform === "ios" ? "App Store Connect" : "Google Play"} first.` }), true;
      if (!buildsEnabled()) return json(res, 503, { error: "Cloud builds aren't set up on this server yet. Download the app project instead — it builds itself with GitHub Actions." }), true;
      const list = await store.releases(id);
      if (list.some((x) => x.platform === platform && ACTIVE.has(x.state))) return json(res, 409, { error: "A release for this platform is already building." }), true;
      const versionCode = Math.max(0, ...list.filter((x) => x.platform === platform).map((x) => x.versionCode || 0)) + 1;
      const token = newBuildToken(), rid = crypto.randomBytes(8).toString("hex"), m = meta.monetize || {};
      const r = await store.createRelease(id, {
        rid, platform, track: platform === "ios" ? "testflight" : "internal", appId, appName: meta.title || "Game", versionCode, versionName: `1.0.${versionCode}`,
        notes: String(b.notes || "").slice(0, 500), createdBy: user.sub, tokenHash: hashToken(token), tokenExp: Date.now() + 3 * 3600e3,
        ads: { appAndroid: m.appAndroid, appIos: m.appIos, interstitialAndroid: m.interstitialAndroid, interstitialIos: m.interstitialIos, every: m.every || 3, test: m.test !== false },
        firstStep: `Queued: ${platform === "ios" ? "iOS" : "Android"} 1.0.${versionCode} for ${platform === "ios" ? "TestFlight" : "Google Play internal testing"}.`,
      });
      try { await dispatchBuild({ releaseId: rid, platform, api: publicUrl(), token }); }
      catch (e) { await store.releaseStep(r, "failed", e.message, { tokenExp: 0 }); return json(res, e.status || 502, { error: e.message }), true; }
      return json(res, 200, { release: releaseView({ ...r }) }), true;
    }
    // Next steps on a release: android → promote to production; ios → check TestFlight, submit for review.
    if (parts[3] === "releases" && /^[a-f0-9]{16}$/.test(parts[4] || "") && req.method === "POST") {
      const r = await store.getRelease(parts[4]);
      if (!r || r.gameId !== id) return json(res, 404, { error: "Release not found." }), true;
      const action = (await body(req, 1e3)).action;
      if (r.platform === "android" && action === "promote") {
        if (r.state !== "uploaded") return json(res, 400, { error: "Only an uploaded build can be promoted." }), true;
        const conn = await store.getConnection(user.sub, "google");
        if (!conn) return json(res, 400, { error: "Connect Google Play first." }), true;
        await play.promote(unseal(conn.sealed), r.appId, r.playVersionCode ?? r.versionCode, { versionName: r.versionName }); // the code Play recorded at upload
        await store.releaseStep(r, "live", "Released to production on Google Play. It reaches players once Google's review (usually hours) finishes.");
      } else if (r.platform === "ios" && (action === "refresh" || action === "submit")) {
        const conn = await store.getConnection(user.sub, "apple");
        if (!conn) return json(res, 400, { error: "Connect App Store Connect first." }), true;
        const k = unseal(conn.sealed), app = await asc.findApp(k, r.appId), build = await asc.findBuild(k, app.id, String(r.versionCode));
        if (!build) return json(res, 200, { pending: true, note: "Apple hasn't listed the build yet — try again in a few minutes." }), true;
        if (build.state !== "VALID") return json(res, 200, { pending: true, note: `Apple is still processing the build (${build.state}).` }), true;
        if (action === "refresh") { if (r.state === "uploaded") await store.releaseStep(r, "testflight", "Ready in TestFlight — your internal testers can install it now."); }
        else {
          if (!["uploaded", "testflight"].includes(r.state)) return json(res, 400, { error: "This build can't be submitted from its current state." }), true;
          await asc.submitForReview(k, app.id, build.id, r.versionName, r.notes);
          await store.releaseStep(r, "in_review", "Submitted to App Review. Apple usually answers within a day or two.");
        }
      } else return json(res, 400, { error: "Unknown action for this release." }), true;
      return json(res, 200, { release: releaseView(await store.getRelease(r.rid)) }), true;
    }
  }

  // ---- live connection check against the real store (free API calls) ----
  if (url.pathname === "/api/stores-check" && req.method === "POST") {
    const b = await body(req, 2e3), gameId = String(b.gameId || "");
    const { user } = await ownedGame(req, gameId);
    const app = await store.getStoreApp(gameId);
    const conn = await store.getConnection(user.sub, b.store === "apple" ? "apple" : "google");
    if (!conn) return json(res, 400, { error: "Not connected." }), true;
    const out = b.store === "apple" ? await asc.checkAccess(unseal(conn.sealed), app?.iosBundle || "") : await play.checkAccess(unseal(conn.sealed), app?.androidPackage || "");
    return json(res, 200, out), true;
  }
  return false;
}
