// Vendor tool: create the license signing key pair, and issue license keys.
// The PRIVATE key must never be committed or shipped. Keep it in a password manager / KMS.
//
//   node scripts/issue-license.mjs keygen --out ~/lumen-license-key.pem
//       → writes the private key (0600) and prints the PUBLIC key to paste into
//         src/core/commerce/config.ts (licensePublicKey).
//   node scripts/issue-license.mjs issue --key ~/lumen-license-key.pem --email a@b.com [--days 365]
//       → prints a license key (LUMEN1.<payload>.<signature>). Omit --days for perpetual.

import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k) => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : undefined;
};
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

if (cmd === "keygen") {
  const out = opt("--out");
  if (!out) throw new Error("--out <path> is required");
  if (fs.existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a signing key.`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`Private key written to ${out} (keep it secret).\n\nPublic key for config.ts:\n${publicKey.export({ type: "spki", format: "pem" })}`);
} else if (cmd === "issue") {
  const keyPath = opt("--key");
  if (!keyPath) throw new Error("--key <private key path> is required");
  const days = opt("--days");
  const now = Date.now();
  const payload = { v: 1, id: randomUUID(), plan: "pro", email: opt("--email"), issuedAt: now, expiresAt: days ? now + Number(days) * 86_400_000 : null };
  const head = `LUMEN1.${b64url(JSON.stringify(payload))}`;
  const sig = sign(null, Buffer.from(head), createPrivateKey(fs.readFileSync(keyPath)));
  console.error(`License ${payload.id}${payload.expiresAt ? ` expires ${new Date(payload.expiresAt).toISOString().slice(0, 10)}` : " (perpetual)"}`);
  console.log(`${head}.${b64url(sig)}`);
} else {
  console.error("usage: issue-license.mjs keygen --out <path> | issue --key <path> [--email x] [--days n]");
  process.exit(2);
}
