import crypto from "node:crypto";
import { config } from "./config";

/**
 * AES-256-GCM encryption for Plaid access tokens at rest.
 * Format stored in DB: <iv_hex>:<authtag_hex>:<ciphertext_hex>
 */

const KEY = Buffer.from(config.encKeyHex, "hex");
if (KEY.length !== 32) {
  throw new Error("APP_ENC_KEY must be 32 bytes (64 hex chars)");
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
