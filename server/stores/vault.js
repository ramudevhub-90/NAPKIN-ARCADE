// Creators' store credentials (Google Play service accounts, App Store Connect keys, Android upload
// keystores) are sealed with AES-256-GCM under the server's CONNECTOR_KEY before they touch the database.
import crypto from "node:crypto";

const key = () => {
  const hex = process.env.CONNECTOR_KEY || "";
  if (!/^[a-f0-9]{64}$/.test(hex)) throw Object.assign(new Error("App store connections aren't enabled on this server yet."), { status: 503 });
  return Buffer.from(hex, "hex");
};
export const vaultReady = () => /^[a-f0-9]{64}$/.test(process.env.CONNECTOR_KEY || "");
export function seal(value) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}
export function unseal(box) {
  const [v, iv, tag, ct] = String(box || "").split(".");
  if (v !== "v1") throw new Error("Unreadable credentials.");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
}
