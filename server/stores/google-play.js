// Google Play Developer API (androidpublisher v3) as the creator's service account:
// an OAuth2 JWT-bearer token, then an "edit" per change (upload a bundle, set a track, commit).
// PLAY_TOKEN_URL / PLAY_API_BASE point at a local mock in tests.
import crypto from "node:crypto";

const TOKEN_URL = () => process.env.PLAY_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = () => process.env.PLAY_API_BASE || "https://androidpublisher.googleapis.com";
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function parseServiceAccount(text) {
  let sa;
  try { sa = typeof text === "string" ? JSON.parse(text) : text; } catch { throw fail("That isn't a service-account JSON key file."); }
  if (sa?.type !== "service_account" || !/@.+\.iam\.gserviceaccount\.com$/.test(sa.client_email || "") || !/BEGIN PRIVATE KEY/.test(sa.private_key || ""))
    throw fail("That JSON isn't a Google service-account key (it needs type, client_email and private_key).");
  return { client_email: sa.client_email, private_key: sa.private_key, project_id: sa.project_id || "" };
}

const b64url = (b) => Buffer.from(b).toString("base64url");
const tokens = new Map(); // client_email -> { token, exp }
async function accessToken(sa) {
  const cached = tokens.get(sa.client_email);
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: TOKEN_URL(), iat: now, exp: now + 3600 }))}`;
  const assertion = `${unsigned}.${b64url(crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key))}`;
  const r = await fetch(TOKEN_URL(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw fail(`Google rejected the service account (${j.error_description || j.error || r.status}). Check the key and that it isn't disabled.`, 401);
  tokens.set(sa.client_email, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function call(sa, method, path, { json, body, contentType, upload } = {}) {
  const r = await fetch(`${API()}${upload ? "/upload" : ""}/androidpublisher/v3/applications/${path}`, {
    method, headers: { Authorization: `Bearer ${await accessToken(sa)}`, ...(json ? { "Content-Type": "application/json" } : contentType ? { "Content-Type": contentType } : {}) },
    body: json ? JSON.stringify(json) : body,
  });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`;
    if (r.status === 404) throw fail(`Google Play doesn't know this app yet. Create it in the Play Console and upload the first build there by hand; after that, releases can go out from here. (${msg})`, 404);
    if (r.status === 403) throw fail(`The service account can't release this app. In Play Console → Users and permissions, give it "Release apps to testing tracks" and "Release to production". (${msg})`, 403);
    throw fail(`Google Play: ${msg}`, 502);
  }
  return j;
}
const edit = async (sa, pkg) => (await call(sa, "POST", `${pkg}/edits`, { json: {} })).id;

// Free and read-only in effect: open an edit for the app, then throw it away.
export async function checkAccess(sa, pkg) {
  const id = await edit(sa, pkg);
  await call(sa, "DELETE", `${pkg}/edits/${id}`).catch(() => {});
  return { ok: true };
}

// Upload an .aab and put it on a track. New (draft) apps only accept draft releases, so retry that way.
export async function uploadBundle(sa, pkg, aab, { track = "internal", versionName, notes = "" }) {
  const id = await edit(sa, pkg);
  const { versionCode } = await call(sa, "POST", `${pkg}/edits/${id}/bundles?uploadType=media`, { upload: true, body: aab, contentType: "application/octet-stream" });
  const release = (status) => ({ track, releases: [{ name: versionName, versionCodes: [String(versionCode)], status, ...(notes ? { releaseNotes: [{ language: "en-US", text: notes.slice(0, 500) }] } : {}) }] });
  await call(sa, "PUT", `${pkg}/edits/${id}/tracks/${track}`, { json: release("completed") });
  try { await call(sa, "POST", `${pkg}/edits/${id}:commit`); return { versionCode, status: "completed" }; }
  catch (e) {
    if (!/draft/i.test(e.message)) throw e;
    const again = await edit(sa, pkg);
    await call(sa, "PUT", `${pkg}/edits/${again}/tracks/${track}`, { json: release("draft") });
    await call(sa, "POST", `${pkg}/edits/${again}:commit`);
    return { versionCode, status: "draft" };
  }
}

// Move a version that's already on a testing track to production (optionally a staged rollout).
export async function promote(sa, pkg, versionCode, { versionName, rollout = 1 } = {}) {
  const id = await edit(sa, pkg);
  const staged = rollout > 0 && rollout < 1;
  await call(sa, "PUT", `${pkg}/edits/${id}/tracks/production`, { json: { track: "production", releases: [{ name: versionName, versionCodes: [String(versionCode)], status: staged ? "inProgress" : "completed", ...(staged ? { userFraction: rollout } : {}) }] } });
  await call(sa, "POST", `${pkg}/edits/${id}:commit`);
  return { ok: true };
}
