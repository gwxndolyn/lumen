# Commercial model and launch status

## Decision

Lumen pays for no inference: customers use **their own API key** (billed by the provider) or a
**local model** (free per question). Metering AI usage or adding accounts would add cost, a backend
and personal data without serving the customer. So the simplest viable model is:

| | Free | Pro (license key) |
|---|---|---|
| Assistant, screen/document/transcript/notes context, history, export | ✓ | ✓ |
| Any provider with your own key, or a local Ollama model | ✓ | ✓ |
| Privacy restriction, usage limits, response cache | ✓ | ✓ |
| Hybrid local/cloud routing (Local first / Cloud first) | — | ✓ |
| Semantic (embedding) knowledge search | — | ✓ |
| Live model evaluations and experiments | deterministic only | ✓ |
| Project memory | 50 items | unlimited |

**No accounts.** Nothing in Lumen requires one, so none is created; there is no password storage
and no identity provider. **No in-app payment.** "Get Pro" opens the vendor's store page in the
browser; the store (e.g. Lemon Squeezy, Paddle, Stripe Checkout — whichever the vendor uses) takes
payment and emails a license key. Lumen never sees card details or trusts a client-side "paid" flag:
the only proof of purchase is a key signed with the vendor's private key.

## Licensing

- Key = `LUMEN1.<base64url JSON payload>.<Ed25519 signature>`; payload `{v, id, plan, email?, issuedAt, expiresAt|null}`.
- Verified offline against the public key in `src/core/commerce/config.ts`. No server, no device
  fingerprint, works offline indefinitely; moving to a new computer = paste the key again.
- Expiry has a 7-day grace period, then Pro features turn off. **No data is ever locked**: an expired
  or invalid license only disables Pro features (existing memories beyond 50 remain readable and used).
- Revocation: add the license id to `revokedLicenses` and ship an update (offline design: revocation
  takes effect on update). The license survives *Delete everything* (it's a purchase, not content).
- Entitlement rules live only in `src/core/commerce/entitlements.ts` and are enforced in the core
  (settings changes, chat routing, memory, embedding search, live evaluations), not just the UI.
- Builds with an empty public key are "open" (everything on): development and self-built copies.

### Vendor setup (requires credentials — not done)

1. `node scripts/issue-license.mjs keygen --out <secure path>` → keep the private key in a password
   manager / KMS, paste the printed public key into `config.ts`.
2. Set `purchaseUrl` (HTTPS store page) and `updateFeedUrl` (HTTPS feed JSON) in `config.ts`.
3. Issue keys after payment: `node scripts/issue-license.mjs issue --key <path> --email <buyer> [--days 365]`.
   Automating this needs the store's webhook → a small serverless function holding the private key,
   with signature verification and idempotency on the store's event id. **Not built**: it needs the
   vendor's store account and hosting.

## Updates

Manual: *Plan & updates → Check for updates* fetches an HTTPS feed
(`{latest, releasedAt, notes, url, minimumSupported, sha256}`), shows notes and checksums, and opens
the HTTPS download page. Lumen never downloads or runs installers itself, so OS signature checks
(Gatekeeper / SmartScreen) apply. Settings and data live in the user-data folder, which installers
don't touch; schema migrations run on start and the previous database is kept if one fails.
Automatic updates (electron-updater) remain disabled until builds are signed — see `src/core/platform.ts`.

## Launch blockers (need the vendor)

| Blocker | Why it blocks |
|---|---|
| Apple Developer ID signing + notarization; Windows Authenticode | Unsigned apps are blocked or warned by macOS/Windows; auto-update needs signing |
| License key pair, store account, purchase URL, update feed hosting | Pro can't be sold or delivered without them |
| Purchase → license webhook (serverless) | Without it keys are issued by hand |
| Real-provider verification (`npm run test:live`, live evaluation) | Never run against real Anthropic/OpenAI/Gemini/Deepgram/Ollama |
| Windows hand testing | Only automated tests run on Windows |
| Terms, privacy policy, refund policy | Legal requirements for selling |
