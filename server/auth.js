// Accounts with email one-time codes (no passwords): request a 6-digit code, verify it,
// get an HTTP-only session cookie. New emails become accounts on first verification.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data");
const USERS = path.join(DATA, "users.json"), SESSIONS = path.join(DATA, "sessions.json");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const users = read(USERS), sessions = read(SESSIONS);
const persist = () => { fs.writeFileSync(USERS, JSON.stringify(users)); fs.writeFileSync(SESSIONS, JSON.stringify(sessions)); };
const otps = new Map(); // email -> { hash, expires, tries, sent: [timestamps] }
const COOKIE = "na_session", MAX_AGE = 30 * 24 * 3600;
export const DAILY_BUILDS = +(process.env.DAILY_BUILDS_PER_USER || 5);

const today = () => new Date().toISOString().slice(0, 10);
const buildsToday = (u) => (u.builds || []).filter((d) => d === today()).length;
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, buildsToday: buildsToday(u), dailyBuilds: DAILY_BUILDS };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();

// ---------- email delivery: SMTP (e.g. Gmail app password) or Resend; dev fallback logs the code ----------
const FROM = process.env.MAIL_FROM || "Napkin Arcade <no-reply@napkin-arcade.dev>";
let smtp = null;
if (process.env.SMTP_HOST) smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: +(process.env.SMTP_PORT || 587) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
let ses = null;
if (process.env.MAIL_PROVIDER === "ses") {
  const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  // Optionally send through another account's SES (e.g. where the domain is verified) by assuming a role there.
  let credentials;
  if (process.env.SES_ROLE_ARN) {
    const { fromTemporaryCredentials } = await import("@aws-sdk/credential-providers");
    credentials = fromTemporaryCredentials({ params: { RoleArn: process.env.SES_ROLE_ARN, RoleSessionName: "napkin-arcade-mail" }, clientConfig: { region: process.env.AWS_REGION || "us-east-1" } });
  }
  const client = new SESv2Client({ region: process.env.SES_REGION || process.env.AWS_REGION || "us-east-1", credentials });
  ses = (msg) => client.send(new SendEmailCommand({ FromEmailAddress: msg.from, Destination: { ToAddresses: [msg.to] }, Content: { Simple: { Subject: { Data: msg.subject }, Body: { Text: { Data: msg.text }, Html: { Data: msg.html } } } } }));
}
export const mailMode = ses ? "ses" : smtp ? "smtp" : process.env.RESEND_API_KEY ? "resend" : "dev";

async function sendCode(email, code) {
  const subject = `${code} is your Napkin Arcade code`;
  const text = `Your Napkin Arcade sign-in code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">✏️🎮 Napkin Arcade</h2><p>Your sign-in code:</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3ecdf;border-radius:12px;padding:14px;text-align:center">${code}</div><p style="color:#777;font-size:13px">It expires in 10 minutes. If you didn't ask for it, ignore this email.</p></div>`;
  if (ses) return ses({ from: FROM, to: email, subject, text, html });
  if (smtp) return smtp.sendMail({ from: FROM, to: email, subject, text, html });
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: FROM, to: [email], subject, text, html }) });
    if (!r.ok) throw new Error(`Email failed: ${r.status} ${await r.text()}`);
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("Email is not configured on this server.");
  console.log(`[dev mail] sign-in code for ${email}: ${code}`);
}

export async function requestCode({ email }) {
  email = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Please enter a valid email.");
  const now = Date.now(), prev = otps.get(email);
  const sent = (prev?.sent || []).filter((t) => now - t < 3600e3);
  if (sent.length && now - sent.at(-1) < 30e3) throw bad("Please wait 30 seconds before asking for another code.", 429);
  if (sent.length >= 5) throw bad("Too many codes requested. Try again in an hour.", 429);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  otps.set(email, { hash: sha(email + code), expires: now + 10 * 60e3, tries: 0, sent: [...sent, now] });
  await sendCode(email, code);
  return { sent: true, newUser: !users[email], mail: mailMode };
}

export function verifyCode(res, { email, code, name }) {
  email = normEmail(email);
  const o = otps.get(email);
  if (!o || Date.now() > o.expires) throw bad("That code expired. Ask for a new one.", 401);
  if (++o.tries > 5) { otps.delete(email); throw bad("Too many wrong attempts. Ask for a new code.", 429); }
  const ok = crypto.timingSafeEqual(Buffer.from(o.hash, "hex"), Buffer.from(sha(email + String(code || "").trim()), "hex"));
  if (!ok) throw bad("Wrong code. Check your email and try again.", 401);
  otps.delete(email);
  let u = users[email];
  if (!u) {
    const nm = String(name || "").trim().slice(0, 40) || email.split("@")[0];
    u = users[email] = { id: crypto.randomBytes(6).toString("hex"), name: nm, email, created: new Date().toISOString(), builds: [] };
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { userId: email, created: Date.now() };
  persist();
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
  return publicUser(u);
}

export function currentUser(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`${COOKIE}=([a-f0-9]{64})`));
  const s = m && sessions[m[1]];
  if (!s || Date.now() - s.created > MAX_AGE * 1000) return null;
  return users[s.userId] || null;
}

export function logout(req, res) {
  const m = (req.headers.cookie || "").match(new RegExp(`${COOKIE}=([a-f0-9]{64})`));
  if (m) { delete sessions[m[1]]; persist(); }
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export const me = (req) => publicUser(currentUser(req));

// Throws if the user may not start another build today; otherwise records it.
export function chargeBuild(user) {
  if (buildsToday(user) >= DAILY_BUILDS) throw bad(`You've used today's ${DAILY_BUILDS} game builds. Come back tomorrow!`, 429);
  user.builds = [...(user.builds || []).filter((d) => d === today()), today()];
  persist();
}
