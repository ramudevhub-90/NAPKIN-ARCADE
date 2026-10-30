// Every email Napkin Arcade sends: one branded layout (table-based and inline-styled so it
// renders the same in Gmail, Outlook and Apple Mail), sent through SES — optionally another
// account's, by assuming a send-only role.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const BRAND = { ink: "#2a2a35", muted: "#6f6a60", accent: "#ff6b4a", pink: "#ff2fa0", paper: "#fbf6ec", card: "#ffffff", line: "#eadfcb", night: "#15151b" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const siteUrl = () => (process.env.PUBLIC_URL || "https://napkinarcade.revenuerush.in").replace(/\/$/, "");

let ses = null, sesUntil = 0;
async function sesClient() {
  if (!process.env.SES_ROLE_ARN) return (ses ||= new SESv2Client({ region: process.env.SES_REGION || process.env.AWS_REGION }));
  if (ses && Date.now() < sesUntil) return ses;
  const { Credentials: c } = await new STSClient({}).send(new AssumeRoleCommand({ RoleArn: process.env.SES_ROLE_ARN, RoleSessionName: "napkin-arcade-mail" }));
  ses = new SESv2Client({ region: process.env.SES_REGION || "us-east-1", credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } });
  sesUntil = new Date(c.Expiration).getTime() - 60e3;
  return ses;
}

export async function sendMail({ to, subject, html, text, replyTo }) {
  await (await sesClient()).send(new SendEmailCommand({
    FromEmailAddress: process.env.MAIL_FROM || "Napkin Arcade <no-reply@revenuerush.in>",
    Destination: { ToAddresses: [to] },
    ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } } } },
  }));
}

// A button that survives Outlook (table cell with a background, not a styled link alone).
export const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0"><tr><td align="center" bgcolor="${BRAND.accent}" style="border-radius:12px;background:${BRAND.accent};background-image:linear-gradient(135deg,${BRAND.pink},${BRAND.accent})"><a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 16px ${FONT};color:#ffffff;text-decoration:none;border-radius:12px">${esc(label)}</a></td></tr></table>`;

// The shared page: hidden preview line, dark brand header, white card, quiet footer.
export function layout({ preheader, body, footer }) {
  const site = siteUrl();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Napkin Arcade</title></head>
<body style="margin:0;padding:0;background:${BRAND.paper};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.paper}" style="background:${BRAND.paper}"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td bgcolor="${BRAND.night}" style="background:${BRAND.night};background-image:linear-gradient(135deg,#1c1530,${BRAND.night} 60%);border-radius:18px 18px 0 0;padding:22px 28px">
      <a href="${site}" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px"><img src="${site}/logo-96.png" width="44" height="44" alt="" style="display:block;border:0"></td>
        <td><div style="font:800 22px ${FONT};color:#ffffff;letter-spacing:.2px">Napkin <span style="color:${BRAND.accent}">Arcade</span></div>
        <div style="font:13px ${FONT};color:#a9a7b8;margin-top:2px">Draw a game. An AI studio builds it in 3D.</div></td>
      </tr></table></a>
    </td></tr>
    <tr><td bgcolor="${BRAND.card}" style="background:${BRAND.card};border:1px solid ${BRAND.line};border-top:0;border-radius:0 0 18px 18px;padding:30px 28px 28px;font:16px/1.55 ${FONT};color:${BRAND.ink}">${body}</td></tr>
    <tr><td style="padding:18px 28px;font:12px/1.6 ${FONT};color:${BRAND.muted};text-align:center">${footer || ""}<br><a href="${site}" style="color:${BRAND.muted}">napkinarcade.revenuerush.in</a> · Built with NVIDIA Nemotron on Nebius</td></tr>
  </table>
</td></tr></table></body></html>`;
}

const h1 = (t) => `<h1 style="margin:0 0 10px;font:800 24px/1.25 ${FONT};color:${BRAND.ink}">${t}</h1>`;
const p = (t, style = "") => `<p style="margin:0 0 16px;${style}">${t}</p>`;

// Sign-in code.
export function codeEmail(code) {
  const digits = String(code).split("").map((d) => `<td align="center" style="width:44px;height:56px;background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:10px;font:800 28px ${FONT};color:${BRAND.ink}">${esc(d)}</td><td style="width:6px"></td>`).join("");
  return {
    subject: `${code} is your Napkin Arcade code`,
    html: layout({
      preheader: `Your sign-in code is ${code}. It expires in a few minutes.`,
      body: h1("Your sign-in code") + p("Enter this code on the Napkin Arcade sign-in page:", `color:${BRAND.muted}`) +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px"><tr>${digits}</tr></table>` +
        p("It expires in a few minutes and works once.", `font-size:14px;color:${BRAND.muted}`),
      footer: "You're getting this because someone asked to sign in with this email. If it wasn't you, ignore it — no account changes were made.",
    }),
    text: `Your Napkin Arcade sign-in code is ${code}.\n\nIt expires in a few minutes and works once. If you didn't ask for it, ignore this email.\n\n${siteUrl()}`,
  };
}

// "You've been added to someone's circle", with their circle-only games.
function gameList(games) {
  const site = siteUrl();
  return games.map((g) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border:1px solid ${BRAND.line};border-radius:14px"><tr>
    <td style="padding:14px 16px"><div style="font:800 17px ${FONT};color:${BRAND.ink}">🔒 ${esc(g.title || "Untitled game")}</div>${g.tagline ? `<div style="font:14px/1.45 ${FONT};color:${BRAND.muted};margin-top:3px">${esc(g.tagline)}</div>` : ""}</td>
    <td align="right" style="padding:14px 16px;white-space:nowrap"><a href="${site}/play/${esc(g.id)}" style="font:700 15px ${FONT};color:${BRAND.accent};text-decoration:none">▶ Play</a></td></tr></table>`).join("");
}
export function circleInviteEmail({ from, to, games }) {
  const site = siteUrl(), first = games[0];
  const cta = first && games.length === 1 ? `${site}/play/${first.id}` : `${site}/login?next=${encodeURIComponent("/studio#shared")}`;
  return {
    subject: `${from} added you to their Napkin Arcade circle`,
    html: layout({
      preheader: games.length ? `Play ${first.title || "their private games"}${games.length > 1 ? ` and ${games.length - 1} more` : ""} — only their circle can.` : `You'll get access to their private games.`,
      body: h1(`${esc(from)} added you to their circle 🎮`) +
        p(`${esc(from)} makes games on Napkin Arcade, where you draw or describe a game and an AI studio builds it in 3D. Their circle-only games are private: only people they add can play them.`) +
        (games.length ? gameList(games) : p("They haven't made a circle-only game yet — you'll be able to play them as soon as they do.", `color:${BRAND.muted}`)) +
        `<div style="margin:22px 0 18px">${button(cta, games.length === 1 ? `Play ${first.title || "now"}` : "See your shared games")}</div>` +
        p(`Sign in with <b>${esc(to)}</b> — we'll email you a 6-digit code, no password needed. Shared games appear under <b>Shared with me</b> in your studio.`, `font-size:14px;color:${BRAND.muted}`),
      footer: `${esc(from)} added ${esc(to)} to their Napkin Arcade circle. Reply to this email to reach them.`,
    }),
    text: `${from} added you to their Napkin Arcade circle.\n\n${games.map((g) => `• ${g.title || "Untitled game"} — ${site}/play/${g.id}`).join("\n") || "They haven't shared a game yet."}\n\nSign in with ${to} (we'll email you a code). Shared games appear under "Shared with me" in your studio: ${site}/studio\n`,
  };
}
// A game newly made circle-only: tell the people already in the circle.
export function gameSharedEmail({ from, to, game }) {
  const site = siteUrl();
  return {
    subject: `${from} shared “${game.title || "a new game"}” with you`,
    html: layout({
      preheader: `${game.tagline || "A private game for their circle."}`,
      body: h1(`New in ${esc(from)}'s circle`) + p(`${esc(from)} shared a private game with their circle, and you're in it.`) + gameList([game]) +
        `<div style="margin:22px 0 18px">${button(`${site}/play/${game.id}`, `Play ${game.title || "now"}`)}</div>` +
        p(`Sign in with <b>${esc(to)}</b> to play.`, `font-size:14px;color:${BRAND.muted}`),
      footer: `You're in ${esc(from)}'s Napkin Arcade circle. Reply to this email to reach them.`,
    }),
    text: `${from} shared "${game.title || "a new game"}" with their circle.\n\nPlay: ${site}/play/${game.id}\nSign in with ${to}.\n`,
  };
}
