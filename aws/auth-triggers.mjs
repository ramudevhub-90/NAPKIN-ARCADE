// Cognito custom-auth (passwordless email code) triggers.
//  - PreSignUp: auto-confirm (the email code proves ownership at sign-in)
//  - DefineAuthChallenge: one CUSTOM_CHALLENGE, three tries
//  - CreateAuthChallenge: 6-digit code, emailed via SES (optionally another account's, by assuming a send-only role);
//    the judge account gets a fixed code from the environment and no email
//  - VerifyAuthChallenge: compare the answer
import crypto from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const JUDGE_EMAIL = String(process.env.JUDGE_EMAIL || "").toLowerCase();
let JUDGE_CODE = String(process.env.JUDGE_CODE || "");
// The judge code lives encrypted in SSM Parameter Store; read once per container.
async function judgeCode() {
  if (JUDGE_CODE || !process.env.JUDGE_CODE_PARAM) return JUDGE_CODE;
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  try { JUDGE_CODE = (await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.JUDGE_CODE_PARAM, WithDecryption: true }))).Parameter.Value; } catch { JUDGE_CODE = ""; }
  return JUDGE_CODE;
}
let ses = null, sesUntil = 0;
async function sesClient() {
  if (!process.env.SES_ROLE_ARN) return (ses ||= new SESv2Client({ region: process.env.SES_REGION || process.env.AWS_REGION }));
  if (ses && Date.now() < sesUntil) return ses;
  const { Credentials: c } = await new STSClient({}).send(new AssumeRoleCommand({ RoleArn: process.env.SES_ROLE_ARN, RoleSessionName: "napkin-arcade-otp" }));
  ses = new SESv2Client({ region: process.env.SES_REGION || "us-east-1", credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } });
  sesUntil = new Date(c.Expiration).getTime() - 60e3;
  return ses;
}

export async function preSignUp(event) {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}

export async function defineAuthChallenge(event) {
  const s = event.request.session || [];
  const last = s.at(-1);
  if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult === true) { event.response.issueTokens = true; event.response.failAuthentication = false; }
  else if (s.length >= 3) { event.response.issueTokens = false; event.response.failAuthentication = true; }
  else { event.response.issueTokens = false; event.response.failAuthentication = false; event.response.challengeName = "CUSTOM_CHALLENGE"; }
  return event;
}

export async function createAuthChallenge(event) {
  const email = String(event.request.userAttributes.email || "").toLowerCase();
  const judge = JUDGE_EMAIL && email === JUDGE_EMAIL && (await judgeCode()).length >= 6;
  // Reuse the code within one sign-in so retries don't send new emails.
  const prev = (event.request.session || []).map((x) => x.challengeMetadata).filter(Boolean).at(-1);
  let code = prev?.startsWith("CODE-") ? prev.slice(5) : null;
  if (!code) {
    code = judge ? JUDGE_CODE : String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    if (!judge) {
      const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 8px">✏️🎮 Napkin Arcade</h2><p>Your sign-in code:</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3ecdf;border-radius:12px;padding:14px;text-align:center">${code}</div><p style="color:#777;font-size:13px">It expires in a few minutes. If you didn't ask for it, ignore this email.</p></div>`;
      await (await sesClient()).send(new SendEmailCommand({
        FromEmailAddress: process.env.MAIL_FROM, Destination: { ToAddresses: [email] },
        Content: { Simple: { Subject: { Data: `${code} is your Napkin Arcade code` }, Body: { Html: { Data: html }, Text: { Data: `Your Napkin Arcade sign-in code is ${code}.` } } } },
      }));
    }
  }
  event.response.publicChallengeParameters = { email, judge: judge ? "1" : "0" };
  event.response.privateChallengeParameters = { code };
  event.response.challengeMetadata = `CODE-${code}`;
  return event;
}

export async function verifyAuthChallenge(event) {
  const expected = Buffer.from(String(event.request.privateChallengeParameters.code));
  const got = Buffer.from(String(event.request.challengeAnswer || "").trim());
  event.response.answerCorrect = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  return event;
}
