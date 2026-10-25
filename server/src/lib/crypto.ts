import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Enkripsi rahasia (mis. kunci API) untuk disimpan di database: AES-256-GCM dengan kunci dari env SETTINGS_ENCRYPTION_KEY
 * (32 byte, base64). Format: v1.<iv>.<tag>.<ciphertext> (base64url). Kunci tidak pernah disimpan bersama data terenkripsi.
 */
function keyFrom(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY harus 32 byte dalam base64 (mis. openssl rand -base64 32)");
  return k;
}

export const encryptionAvailable = (b64: string) => { try { keyFrom(b64); return true; } catch { return false; } };

export function encryptSecret(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("format rahasia tidak dikenal");
  const d = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Tampilkan hanya 4 karakter terakhir. Nilai pendek ditutup penuh agar tidak membocorkan kunci. */
export const maskSecret = (s: string) => (s.length >= 12 ? `••••${s.slice(-4)}` : s ? "••••" : "");
