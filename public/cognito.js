// Amazon Cognito in the browser (no SDK): custom passwordless sign-in and token refresh.
// Tokens stay in this tab's localStorage for AppSync; the server gets the ID token once
// and answers with its own HTTP-only session cookie.
let cfgPromise = null;
export const config = () => (cfgPromise ||= fetch("/api/config").then((r) => r.json()));

async function idp(target, body) {
  const { cognito } = await config();
  const r = await fetch(`https://cognito-idp.${cognito.region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: cognito.clientId, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.message || j.__type || "Sign-in failed"), { code: (j.__type || "").split("#").pop() });
  return j;
}
const randomPassword = () => { const a = new Uint8Array(24); crypto.getRandomValues(a); return "Na1!" + btoa(String.fromCharCode(...a)).replace(/[^A-Za-z0-9]/g, "x"); };

// Step 1: make sure the account exists, then start the custom challenge (the email code is sent now).
export async function startSignIn(email, name) {
  email = email.trim().toLowerCase();
  try {
    await idp("SignUp", { Username: email, Password: randomPassword(), UserAttributes: [{ Name: "email", Value: email }, ...(name ? [{ Name: "name", Value: name }] : [])] });
  } catch (e) { if (e.code !== "UsernameExistsException") throw e; }
  const r = await idp("InitiateAuth", { AuthFlow: "CUSTOM_AUTH", AuthParameters: { USERNAME: email } });
  return { email, session: r.Session, judge: r.ChallengeParameters?.judge === "1" };
}

// Step 2: answer with the code. Returns tokens, or a new session when the code was wrong.
export async function answer(state, code) {
  const r = await idp("RespondToAuthChallenge", { ChallengeName: "CUSTOM_CHALLENGE", Session: state.session, ChallengeResponses: { USERNAME: state.email, ANSWER: code.trim() } });
  if (r.AuthenticationResult) { saveTokens(r.AuthenticationResult); return { ok: true, idToken: r.AuthenticationResult.IdToken }; }
  return { ok: false, session: r.Session };
}

function saveTokens(t) {
  const prev = load();
  const exp = JSON.parse(atob(t.IdToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000;
  try { localStorage.setItem("na_tokens", JSON.stringify({ id: t.IdToken, refresh: t.RefreshToken || prev?.refresh, exp })); } catch {}
}
const load = () => { try { return JSON.parse(localStorage.getItem("na_tokens")); } catch { return null; } };
export function clearTokens() { try { localStorage.removeItem("na_tokens"); } catch {} }

// A valid ID token for AppSync, refreshing it when it's about to expire.
export async function idToken() {
  const t = load();
  if (!t) return null;
  if (t.exp - Date.now() > 120e3) return t.id;
  if (!t.refresh) return null;
  try {
    const r = await idp("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: t.refresh } });
    saveTokens(r.AuthenticationResult);
    return r.AuthenticationResult.IdToken;
  } catch { clearTokens(); return null; }
}
