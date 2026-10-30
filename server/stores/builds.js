// Cloud builds run as a GitHub Actions workflow in the platform's build repository
// (deploy/build-runner): Linux for Android, macOS for iOS. The runner pulls the job with a one-time
// token, builds, and reports back. Off until BUILD_GITHUB_REPO and BUILD_GITHUB_TOKEN are set.
import crypto from "node:crypto";

const GH = () => process.env.GITHUB_API_BASE || "https://api.github.com";
export const buildsEnabled = () => /^[\w.-]+\/[\w.-]+$/.test(process.env.BUILD_GITHUB_REPO || "") && !!process.env.BUILD_GITHUB_TOKEN;
export const newBuildToken = () => crypto.randomBytes(32).toString("hex");
export const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export async function dispatchBuild({ releaseId, platform, api, token }) {
  if (!buildsEnabled()) throw Object.assign(new Error("Cloud builds aren't set up on this server yet."), { status: 503 });
  const r = await fetch(`${GH()}/repos/${process.env.BUILD_GITHUB_REPO}/actions/workflows/release.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BUILD_GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: process.env.BUILD_GITHUB_REF || "main", inputs: { release_id: releaseId, platform, api, token } }),
  });
  if (r.status !== 204) throw Object.assign(new Error(`Couldn't start the cloud build (GitHub ${r.status}).`), { status: 502 });
}
