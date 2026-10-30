// Calls AppSync with IAM (SigV4) credentials — the worker uses this to publish studio events.
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const URL_ = process.env.APPSYNC_URL, REGION = process.env.AWS_REGION || "us-east-1";
const signer = new SignatureV4({ credentials: defaultProvider(), region: REGION, service: "appsync", sha256: Sha256 });

export async function gql(query, variables) {
  const url = new URL(URL_);
  const body = JSON.stringify({ query, variables });
  const req = await signer.sign({ method: "POST", hostname: url.hostname, path: url.pathname, protocol: "https:", headers: { host: url.hostname, "content-type": "application/json" }, body });
  const r = await fetch(URL_, { method: "POST", headers: req.headers, body });
  const j = await r.json();
  if (j.errors?.length) throw new Error(`AppSync: ${j.errors[0].message}`);
  return j.data;
}

const PUBLISH = `mutation P($gameId: ID!, $owner: String!, $payload: AWSJSON!) { publishStudioEvent(gameId: $gameId, owner: $owner, payload: $payload) { gameId owner payload } }`;
// Events larger than AppSync's limit (code, payloads) are trimmed; clients re-fetch full data.
export async function publishStudioEvent(gameId, owner, event) {
  let payload = JSON.stringify(event);
  if (payload.length > 200_000) payload = JSON.stringify({ ...event, payload: undefined, code: undefined, images: undefined, trimmed: true });
  await gql(PUBLISH, { gameId, owner, payload });
}
