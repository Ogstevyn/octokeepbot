import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. Stored as "v1:" + base64(iv | tag | ciphertext) so the format
// can change later without guessing which version a row uses.
const VERSION = "v1";

function keyFrom(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (64 hex characters)");
  return key;
}

export function encrypt(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt(token: string, keyHex: string): string {
  const [version, body] = token.split(":", 2);
  if (version !== VERSION || !body) throw new Error("Unknown ciphertext format");
  const raw = Buffer.from(body, "base64");
  if (raw.length < 28) throw new Error("Ciphertext is too short");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyHex), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const encryptJson = (value: unknown, keyHex: string) => encrypt(JSON.stringify(value), keyHex);
export const decryptJson = <T>(token: string, keyHex: string): T => JSON.parse(decrypt(token, keyHex)) as T;
