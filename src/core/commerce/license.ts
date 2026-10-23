// Offline-verifiable licenses. The vendor signs a small JSON payload with an Ed25519 private key
// (scripts/issue-license.mjs; the private key never ships); the app verifies it with the public key
// compiled into commercial builds. No server, no account, no device fingerprint: a license names a
// plan, an expiry and (optionally) the customer's email so they can recognise it.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const LICENSE_PREFIX = "LUMEN1";

export interface LicensePayload {
  /** Format version. */
  v: 1;
  /** License id (for support and revocation lists). */
  id: string;
  plan: "pro";
  /** Who it was issued to — shown to the user, not used for checks. */
  email?: string;
  issuedAt: number;
  /** null = perpetual. */
  expiresAt: number | null;
}

export type LicenseCheck = { ok: true; payload: LicensePayload } | { ok: false; reason: "malformed" | "bad_signature" | "unsupported" | "no_public_key" | "revoked"; message: string };

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function loadPublicKey(pem: string | null | undefined): KeyObject | null {
  if (!pem?.trim()) return null;
  try {
    const k = createPublicKey(pem);
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch {
    return null;
  }
}

/** Parse and verify a license string. Expiry is NOT checked here (see entitlements). */
export function verifyLicense(text: string, publicKey: KeyObject | null, revoked: ReadonlySet<string> = new Set()): LicenseCheck {
  if (!publicKey) return { ok: false, reason: "no_public_key", message: "This build of Lumen does not accept licenses." };
  const parts = text.trim().replace(/\s+/g, "").split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { ok: false, reason: "malformed", message: "That doesn't look like a Lumen license key. Paste the whole key, starting with LUMEN1." };
  let payloadBuf: Buffer;
  let sig: Buffer;
  try {
    payloadBuf = b64urlDecode(parts[1]!);
    sig = b64urlDecode(parts[2]!);
  } catch {
    return { ok: false, reason: "malformed", message: "The license key is damaged. Copy it again from your purchase email." };
  }
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, sig)) return { ok: false, reason: "bad_signature", message: "This license key is not valid for Lumen." };
  let p: LicensePayload;
  try {
    p = JSON.parse(payloadBuf.toString("utf8")) as LicensePayload;
  } catch {
    return { ok: false, reason: "malformed", message: "The license key is damaged." };
  }
  if (p.v !== 1 || p.plan !== "pro" || typeof p.id !== "string" || typeof p.issuedAt !== "number" || !(p.expiresAt === null || typeof p.expiresAt === "number"))
    return { ok: false, reason: "unsupported", message: "This license was issued for a newer version of Lumen. Update Lumen and try again." };
  if (revoked.has(p.id)) return { ok: false, reason: "revoked", message: "This license has been revoked. Contact the seller if you think this is a mistake." };
  return { ok: true, payload: p };
}
