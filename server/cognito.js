// Sign-in with Amazon Cognito: the browser completes Cognito's custom passwordless flow, then sends
// its ID token here; we verify it (aws-jwt-verify) and issue an HTTP-only session cookie (DynamoDB, TTL).
import crypto from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import * as store from "../aws/lib/store.mjs";

const COOKIE = "na_session", MAX_AGE = 30 * 24 * 3600;
export const cognitoConfig = { region: process.env.AWS_REGION || "us-east-1", userPoolId: process.env.COGNITO_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID };
const verifier = cognitoConfig.userPoolId ? CognitoJwtVerifier.create({ userPoolId: cognitoConfig.userPoolId, tokenUse: "id", clientId: cognitoConfig.clientId }) : null;
const JUDGE_EMAIL = String(process.env.JUDGE_EMAIL || "").toLowerCase();
export const DAILY_BUILDS = +(process.env.DAILY_BUILDS_PER_USER || 5), DAILY_REVISIONS = +(process.env.DAILY_REVISIONS_PER_USER || 30);
const isJudge = (u) => JUDGE_EMAIL && u?.email === JUDGE_EMAIL;
export const buildLimit = (u) => (isJudge(u) ? 25 : DAILY_BUILDS);
const revisionLimit = (u) => (isJudge(u) ? 60 : DAILY_REVISIONS);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const tokenOf = (req) => (req.headers.cookie || "").match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];

export async function startSession(res, { idToken, name }) {
  if (!verifier) throw bad("Sign-in is not configured on this server.", 503);
  let claims;
  try { claims = await verifier.verify(String(idToken || "")); } catch { throw bad("Sign-in expired. Please try again.", 401); }
  const email = String(claims.email || "").toLowerCase();
  const user = await store.ensureUser(claims.sub, email, String(name || claims.name || "").trim().slice(0, 40) || email.split("@")[0]);
  await store.claimGames(email, claims.sub).catch(() => 0);
  const token = crypto.randomBytes(32).toString("hex");
  await store.putItem({ pk: `SESSION#${token}`, sk: "SESSION", sub: claims.sub, ttl: Math.floor(Date.now() / 1000) + MAX_AGE });
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
  return publicUser(user);
}

export async function currentUser(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const s = await store.getItem(`SESSION#${token}`, "SESSION");
  if (!s || s.ttl * 1000 < Date.now()) return null;
  return store.getUser(s.sub);
}

export async function logout(req, res) {
  const token = tokenOf(req);
  if (token) await store.deleteItem(`SESSION#${token}`, "SESSION");
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export const publicUser = (u) => u && { id: u.sub, name: u.name, email: u.email, buildsToday: store.countToday(u, "build"), dailyBuilds: buildLimit(u) };
export const me = async (req) => publicUser(await currentUser(req));
export const chargeBuild = (u) => store.charge(u.sub, "build", buildLimit(u));
export const chargeRevision = (u) => store.charge(u.sub, "revision", revisionLimit(u));
