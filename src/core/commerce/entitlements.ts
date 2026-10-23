// Central entitlements. Every paid-feature check in Lumen goes through `Entitlements.can()` /
// `limit()`, so plan rules live in one table instead of being scattered across screens.
//
// Commercial model (see docs/COMMERCIAL.md):
// - Free: the full assistant — screen, documents, transcripts, notes, every provider with your own
//   key, and a local model. Lumen pays for no inference, so nothing core is metered by Lumen.
// - Pro (one license key, verified offline): power features listed in PRO_FEATURES.
// - Builds without a license public key (development, self-built) are "open": everything on.
//
// Lumen never locks anyone out of their data: an expired or invalid license only hides Pro
// features; history, notes, transcripts and memories stay readable and exportable.

import type { KeyObject } from "node:crypto";
import { verifyLicense, type LicensePayload } from "./license";

export type Plan = "free" | "pro" | "open";

export type Feature =
  /** Local-first / cloud-first hybrid routing (manual local or cloud is free). */
  | "hybrid_routing"
  /** Local embedding (semantic) knowledge search. */
  | "semantic_search"
  /** Live-model evaluations and experiments in the Evaluation Lab (deterministic runs are free). */
  | "live_evaluation"
  /** More than FREE_LIMITS.memories project-memory items. */
  | "unlimited_memory";

export const FEATURE_LABELS: Record<Feature, string> = {
  hybrid_routing: "Hybrid local/cloud routing",
  semantic_search: "Semantic knowledge search",
  live_evaluation: "Live model evaluations and experiments",
  unlimited_memory: "Unlimited project memory",
};

const PRO_FEATURES: ReadonlySet<Feature> = new Set(["hybrid_routing", "semantic_search", "live_evaluation", "unlimited_memory"]);

export type LimitName = "memories";
const FREE_LIMITS: Record<LimitName, number> = { memories: 50 };

export interface EntitlementState {
  plan: Plan;
  /** Why this plan applies, in customer language. */
  status: "open_build" | "no_license" | "active" | "expired" | "invalid";
  message: string;
  license: { id: string; email: string | null; expiresAt: number | null; issuedAt: number } | null;
  features: Record<Feature, boolean>;
  limits: Record<LimitName, number | null>;
  /** Licensing is configured for this build (a public key is present). */
  licensingEnabled: boolean;
}

export class EntitlementError extends Error {
  constructor(
    message: string,
    readonly feature: Feature,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

export interface LicenseStore {
  get(): string | null;
  set(value: string | null): void;
}

export class Entitlements {
  private cached: EntitlementState | null = null;

  constructor(private readonly opts: { publicKey: KeyObject | null; store: LicenseStore; now?: () => number; revoked?: ReadonlySet<string>; graceDays?: number }) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  state(): EntitlementState {
    // Re-evaluate when the expiry or the end of grace has been crossed since the last check.
    const exp = this.cached?.license?.expiresAt;
    const t = this.now();
    const phase = exp == null ? 0 : t <= exp ? 0 : t <= exp + this.grace() ? 1 : 2;
    if (this.cached && this.cachedPhase === phase) return this.cached;
    this.cached = this.compute();
    this.cachedPhase = phase;
    return this.cached;
  }

  private cachedPhase = -1;

  private grace() {
    return (this.opts.graceDays ?? 7) * 86_400_000;
  }

  private build(plan: Plan, status: EntitlementState["status"], message: string, lic: LicensePayload | null): EntitlementState {
    const pro = plan !== "free";
    return {
      plan,
      status,
      message,
      license: lic ? { id: lic.id, email: lic.email ?? null, expiresAt: lic.expiresAt, issuedAt: lic.issuedAt } : null,
      features: Object.fromEntries([...PRO_FEATURES].map((f) => [f, pro])) as Record<Feature, boolean>,
      limits: { memories: pro ? null : FREE_LIMITS.memories },
      licensingEnabled: !!this.opts.publicKey,
    };
  }

  private compute(): EntitlementState {
    if (!this.opts.publicKey) return this.build("open", "open_build", "This build has every feature enabled.", null);
    const raw = this.opts.store.get();
    if (!raw) return this.build("free", "no_license", "Free plan. Add a Pro license key to unlock Pro features.", null);
    const r = verifyLicense(raw, this.opts.publicKey, this.opts.revoked);
    if (!r.ok) return this.build("free", "invalid", r.message, null);
    const exp = r.payload.expiresAt;
    if (exp != null && this.now() > exp + this.grace()) {
      return this.build("free", "expired", `Your Pro license expired on ${new Date(exp).toLocaleDateString()}. Pro features are off; your data is untouched. Renew to turn them back on.`, r.payload);
    }
    const inGrace = exp != null && this.now() > exp;
    return this.build(
      "pro",
      "active",
      inGrace
        ? `Your Pro license expired on ${new Date(exp).toLocaleDateString()}. Pro features stay on for a few more days — renew to keep them.`
        : exp
          ? `Pro — valid until ${new Date(exp).toLocaleDateString()}.`
          : "Pro — perpetual license.",
      r.payload,
    );
  }

  /** Store a license after verifying it. Invalid keys are rejected and not saved. */
  activate(text: string): EntitlementState {
    if (!this.opts.publicKey) throw new Error("This build of Lumen does not need a license — every feature is already on.");
    const r = verifyLicense(text, this.opts.publicKey, this.opts.revoked);
    if (!r.ok) throw new Error(r.message);
    if (r.payload.expiresAt != null && this.now() > r.payload.expiresAt + this.grace()) throw new Error(`This license expired on ${new Date(r.payload.expiresAt).toLocaleDateString()}.`);
    this.opts.store.set(text.trim().replace(/\s+/g, ""));
    this.cached = null;
    this.cachedPhase = -1;
    return this.state();
  }

  deactivate(): EntitlementState {
    this.opts.store.set(null);
    this.cached = null;
    this.cachedPhase = -1;
    return this.state();
  }

  can(f: Feature): boolean {
    return this.state().features[f];
  }

  /** Throws a customer-facing error when a feature isn't included in the current plan. */
  require(f: Feature) {
    if (!this.can(f)) throw new EntitlementError(`${FEATURE_LABELS[f]} is part of Lumen Pro. Your current plan: Free. Everything else keeps working; see Settings → Plan.`, f);
  }

  limit(l: LimitName): number | null {
    return this.state().limits[l];
  }
}
