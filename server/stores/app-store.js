// App Store Connect API with the creator's API key (Issuer ID, Key ID, .p8): ES256 JWTs, then
// find the app, follow a build through TestFlight processing, and submit a version for review.
// ASC_API_BASE points at a local mock in tests.
import crypto from "node:crypto";

const API = () => process.env.ASC_API_BASE || "https://api.appstoreconnect.apple.com";
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const BUNDLE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;

export function parseApiKey({ issuerId, keyId, teamId, p8 }) {
  issuerId = String(issuerId || "").trim(); keyId = String(keyId || "").trim().toUpperCase(); teamId = String(teamId || "").trim().toUpperCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuerId)) throw fail("The Issuer ID looks like 69a6de7f-…-…-…-… (App Store Connect → Users and Access → Integrations).");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw fail("The Key ID is 10 letters and digits.");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw fail("The Team ID is 10 letters and digits (Apple Developer → Membership).");
  try { if (crypto.createPrivateKey(p8).asymmetricKeyType !== "ec") throw 0; } catch { throw fail("That isn't an App Store Connect .p8 key (it starts with -----BEGIN PRIVATE KEY-----)."); }
  return { issuerId, keyId, teamId, p8: String(p8).trim() };
}

function jwt(k) {
  const now = Math.floor(Date.now() / 1000), b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b({ alg: "ES256", kid: k.keyId, typ: "JWT" })}.${b({ iss: k.issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}`;
  return `${unsigned}.${crypto.sign("sha256", Buffer.from(unsigned), { key: k.p8, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function call(k, method, path, json) {
  const r = await fetch(`${API()}${path}`, { method, headers: { Authorization: `Bearer ${jwt(k)}`, ...(json ? { "Content-Type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.errors?.[0], msg = e ? `${e.title}: ${e.detail || ""}` : `HTTP ${r.status}`;
    if (r.status === 401) throw fail(`Apple rejected the API key (${msg}). Check the Issuer ID, Key ID and .p8 file, and that the key isn't revoked.`, 401);
    if (r.status === 403) throw fail(`The API key needs the App Manager role. (${msg})`, 403);
    throw fail(`App Store Connect: ${msg}`, 502);
  }
  return j;
}

// The app record must exist (Apple's API can't create apps) — this finds it by bundle id.
export async function findApp(k, bundleId) {
  const { data = [] } = await call(k, "GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  if (!data.length) throw fail(`App Store Connect has no app with bundle id ${bundleId}. Create it there first (My Apps → +), then release from here.`, 404);
  return { id: data[0].id, name: data[0].attributes?.name };
}
export const checkAccess = (k, bundleId) => findApp(k, bundleId).then((a) => ({ ok: true, app: a.name }));

// Builds appear a few minutes after upload and are usable once processing is VALID.
export async function findBuild(k, appId, buildNumber) {
  const { data = [] } = await call(k, "GET", `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`);
  return data[0] ? { id: data[0].id, state: data[0].attributes?.processingState } : null;
}

// Create (or reuse) the App Store version, attach the build and submit it to App Review.
export async function submitForReview(k, appId, buildId, versionString, whatsNew = "") {
  const existing = await call(k, "GET", `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`);
  let versionId = existing.data?.[0]?.id;
  if (!versionId) versionId = (await call(k, "POST", "/v1/appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString }, relationships: { app: { data: { type: "apps", id: appId } } } } })).data.id;
  await call(k, "PATCH", `/v1/appStoreVersions/${versionId}/relationships/build`, { data: { type: "builds", id: buildId } });
  if (whatsNew) {
    const locs = await call(k, "GET", `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
    for (const l of locs.data || []) await call(k, "PATCH", `/v1/appStoreVersionLocalizations/${l.id}`, { data: { type: "appStoreVersionLocalizations", id: l.id, attributes: { whatsNew: whatsNew.slice(0, 4000) } } }).catch(() => {});
  }
  const sub = (await call(k, "POST", "/v1/reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: appId } } } } })).data.id;
  await call(k, "POST", "/v1/reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub } }, appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } } });
  await call(k, "PATCH", `/v1/reviewSubmissions/${sub}`, { data: { type: "reviewSubmissions", id: sub, attributes: { submitted: true } } });
  return { versionId, submissionId: sub };
}
