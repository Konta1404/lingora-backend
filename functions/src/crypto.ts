import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * AES-256-GCM encryption for the ChatGPT tokens stored in a user's account.
 * The key is the Firebase secret TOKEN_ENC_KEY: 32 random bytes, base64.
 *   openssl rand -base64 32 | firebase functions:secrets:set TOKEN_ENC_KEY
 */
function key(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encrypt(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(keyB64), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(box: string, keyB64: string): string {
  const [v, iv, tag, data] = box.split(".");
  if (v !== "v1") throw new Error("Unknown token format");
  const d = createDecipheriv("aes-256-gcm", key(keyB64), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
