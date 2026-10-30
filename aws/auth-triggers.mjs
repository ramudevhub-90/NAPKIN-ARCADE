// Cognito custom-auth (passwordless email code) triggers.
//  - PreSignUp: auto-confirm (the email code proves ownership at sign-in)
//  - DefineAuthChallenge: one CUSTOM_CHALLENGE, three tries
//  - CreateAuthChallenge: 6-digit code, emailed via SES (lib/mail.mjs);
//    the judge account gets a fixed code from the environment and no email
//  - VerifyAuthChallenge: compare the answer
import crypto from "node:crypto";
import { sendMail, codeEmail } from "./lib/mail.mjs";

const JUDGE_EMAIL = String(process.env.JUDGE_EMAIL || "").toLowerCase();
let JUDGE_CODE = String(process.env.JUDGE_CODE || "");
// The judge code lives encrypted in SSM Parameter Store; read once per container.
async function judgeCode() {
  if (JUDGE_CODE || !process.env.JUDGE_CODE_PARAM) return JUDGE_CODE;
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  try { JUDGE_CODE = (await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.JUDGE_CODE_PARAM, WithDecryption: true }))).Parameter.Value; } catch { JUDGE_CODE = ""; }
  return JUDGE_CODE;
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
      await sendMail({ to: email, ...codeEmail(code) });
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
