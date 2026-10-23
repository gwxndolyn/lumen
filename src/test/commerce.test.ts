// Commercial layer: offline license verification, entitlements (single source of rules),
// graceful expiry that never locks data, enforcement in core paths, update checks, settings upgrade.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Entitlements } from "../core/commerce/entitlements";
import { LICENSE_PREFIX, loadPublicKey, verifyLicense, type LicensePayload } from "../core/commerce/license";
import { checkForUpdate, compareVersions } from "../core/commerce/updates";
import { loadSettings } from "../shared/settingsSchema";
import { harness } from "./harness";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 23);

function issue(p: Partial<LicensePayload> = {}, key: KeyObject = privateKey) {
  const payload: LicensePayload = { v: 1, id: "lic-1", plan: "pro", email: "a@example.com", issuedAt: T - DAY, expiresAt: T + 30 * DAY, ...p };
  const head = `${LICENSE_PREFIX}.${b64(JSON.stringify(payload))}`;
  return `${head}.${b64(sign(null, Buffer.from(head), key))}`;
}

const memStore = (v: string | null = null) => {
  let x = v;
  return { get: () => x, set: (y: string | null) => (x = y) };
};
const ents = (opts: { lic?: string | null; now?: number; pub?: KeyObject | null; revoked?: string[] } = {}) => {
  let now = opts.now ?? T;
  const store = memStore(opts.lic ?? null);
  const e = new Entitlements({ publicKey: opts.pub === undefined ? loadPublicKey(PEM) : opts.pub, store, now: () => now, revoked: new Set(opts.revoked ?? []) });
  return { e, store, setNow: (n: number) => (now = n) };
};

describe("license verification (offline, Ed25519)", () => {
  const pub = loadPublicKey(PEM);
  it("accepts a key signed by the vendor", () => {
    expect(verifyLicense(issue(), pub)).toMatchObject({ ok: true, payload: { id: "lic-1", plan: "pro" } });
  });
  it("rejects forged, tampered, malformed and revoked keys", () => {
    expect(verifyLicense(issue({}, other.privateKey), pub)).toMatchObject({ ok: false, reason: "bad_signature" });
    const [a, , c] = issue().split(".");
    const tampered = `${a}.${b64(JSON.stringify({ v: 1, id: "lic-1", plan: "pro", issuedAt: 0, expiresAt: null }))}.${c}`;
    expect(verifyLicense(tampered, pub)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyLicense("hello", pub)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyLicense(issue(), pub, new Set(["lic-1"]))).toMatchObject({ ok: false, reason: "revoked" });
  });
  it("tolerates whitespace from copy-paste", () => {
    const k = issue();
    expect(verifyLicense(`  ${k.slice(0, 20)}\n${k.slice(20)}  `, pub).ok).toBe(true);
  });
  it("only accepts an Ed25519 public key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(loadPublicKey(rsa)).toBeNull();
    expect(loadPublicKey("")).toBeNull();
  });
});

describe("entitlements", () => {
  it("builds without a license key are open: every feature on", () => {
    const { e } = ents({ pub: null });
    expect(e.state()).toMatchObject({ plan: "open", licensingEnabled: false });
    expect(e.can("hybrid_routing")).toBe(true);
    expect(() => e.activate(issue())).toThrow(/does not need a license/);
  });

  it("free by default, pro after activation, back to free after removal", () => {
    const { e, store } = ents();
    expect(e.state()).toMatchObject({ plan: "free", status: "no_license", limits: { memories: 50 } });
    expect(() => e.require("semantic_search")).toThrow(/part of Lumen Pro/);
    expect(e.activate(issue())).toMatchObject({ plan: "pro", status: "active", license: { email: "a@example.com" } });
    expect(store.get()).toBeTruthy();
    expect(e.limit("memories")).toBeNull();
    expect(e.deactivate().plan).toBe("free");
    expect(store.get()).toBeNull();
  });

  it("an invalid key is never saved", () => {
    const { e, store } = ents();
    expect(() => e.activate(issue({}, other.privateKey))).toThrow(/not valid/);
    expect(store.get()).toBeNull();
  });

  it("expiry: a 7-day grace period, then Free — with a message that data is untouched", () => {
    const { e, setNow } = ents({ lic: issue({ expiresAt: T + DAY }) });
    expect(e.state().plan).toBe("pro");
    setNow(T + 3 * DAY);
    expect(e.state()).toMatchObject({ plan: "pro", status: "active" });
    expect(e.state().message).toMatch(/expired/);
    setNow(T + 9 * DAY);
    expect(e.state()).toMatchObject({ plan: "free", status: "expired" });
    expect(e.state().message).toMatch(/data is untouched/);
  });

  it("a stored key that later fails (revoked) degrades to Free with the reason", () => {
    const { e } = ents({ lic: issue(), revoked: ["lic-1"] });
    expect(e.state()).toMatchObject({ plan: "free", status: "invalid" });
    expect(e.state().message).toMatch(/revoked/);
  });

  it("perpetual licenses never expire and work offline (no network involved)", () => {
    const { e, setNow } = ents({ lic: issue({ expiresAt: null }) });
    setNow(T + 3650 * DAY);
    expect(e.state().plan).toBe("pro");
  });
});

describe("enforcement in core paths, not just the UI", () => {
  const withPlan = (lic: string | null) => {
    const h = harness({ licensePublicKey: PEM });
    if (lic) h.core.entitlements.activate(lic);
    return h;
  };

  it("hybrid routing can't be enabled on Free; manual and privacy restriction stay free", () => {
    const h = withPlan(null);
    expect(() => h.core.updateSettings({ inference: { mode: "local_first" } })).toThrow(/Pro/);
    expect(() => h.core.updateSettings({ inference: { privacyRestricted: true } })).not.toThrow();
    const pro = withPlan(issue());
    expect(() => pro.core.updateSettings({ inference: { mode: "local_first" } })).not.toThrow();
  });

  it("when a license lapses, an existing hybrid setting falls back to manual instead of breaking chat", async () => {
    const h = harness({ licensePublicKey: PEM, settings: { inference: { mode: "cloud_first" } } });
    const evts = await h.ask("Hello");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
    expect((await h.core.inferenceTargets()).policy.mode).toBe("manual");
  });

  it("the Free memory limit blocks new memories but keeps existing ones", () => {
    const h = withPlan(null);
    for (let i = 0; i < 50; i++) h.core.memory.add("decision", `Decision number ${i} about the build`);
    expect(() => h.core.memory.add("decision", "One more decision")).toThrow(/Free plan keeps up to 50/);
    expect(h.core.memory.list()).toHaveLength(50);
    expect(h.core.memory.retrieve("decision build").length).toBeGreaterThan(0);
  });

  it("the license survives Delete everything (it is a purchase, not user content)", () => {
    const h = withPlan(issue());
    h.core.deleteAll();
    expect(h.core.entitlements.state().plan).toBe("pro");
  });

  it("core chat never depends on a license", async () => {
    const h = withPlan(null);
    expect((await h.ask("Hello")).at(-1)).toMatchObject({ type: "done" });
  });
});

describe("update check (manual, HTTPS only, never downloads)", () => {
  const feed = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("compares versions", () => {
    expect(compareVersions("0.4.0", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.4.0-beta.1", "0.4.0")).toBe(-1);
    expect(compareVersions("v1.10.0", "1.9.9")).toBe(1);
  });
  it("is disabled without a feed and refuses plain HTTP", async () => {
    expect(await checkForUpdate({ feedUrl: "", current: "0.3.0" })).toMatchObject({ status: "disabled" });
    expect(await checkForUpdate({ feedUrl: "http://x.example/feed.json", current: "0.3.0" })).toMatchObject({ status: "error" });
  });
  it("reports an available update with notes, required flag and only well-formed checksums", async () => {
    const r = await checkForUpdate({
      feedUrl: "https://x.example/feed.json",
      current: "0.3.0",
      fetch: feed({ latest: "0.4.0", notes: "Fixes", url: "https://x.example/dl", minimumSupported: "0.3.5", sha256: { "mac-arm64": "a".repeat(64), bad: "zzz" } }),
    });
    expect(r).toMatchObject({ status: "available", latest: "0.4.0", required: true, url: "https://x.example/dl", sha256: { "mac-arm64": "a".repeat(64) } });
    expect(Object.keys((r as { sha256: object }).sha256)).toEqual(["mac-arm64"]);
  });
  it("rejects malformed feeds, insecure download links and server errors", async () => {
    expect(await checkForUpdate({ feedUrl: "https://x.example/f", current: "0.3.0", fetch: feed({ latest: "soon", url: "https://x" }) })).toMatchObject({ status: "error" });
    expect(await checkForUpdate({ feedUrl: "https://x.example/f", current: "0.3.0", fetch: feed({ latest: "0.4.0", url: "http://x.example/dl" }) })).toMatchObject({ status: "error" });
    expect(await checkForUpdate({ feedUrl: "https://x.example/f", current: "0.3.0", fetch: feed({}, 503) })).toMatchObject({ status: "error", message: expect.stringMatching(/503/) });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ feedUrl: "https://x.example/f", current: "0.3.0", fetch: offline })).toMatchObject({ status: "error", message: expect.stringMatching(/connection/) });
  });
  it("up to date", async () => {
    expect(await checkForUpdate({ feedUrl: "https://x.example/f", current: "0.4.0", fetch: feed({ latest: "0.4.0", url: "https://x.example/dl" }) })).toMatchObject({ status: "up_to_date" });
  });
});

describe("upgrades preserve settings and onboarding progress", () => {
  it("settings from an older version (no inference/limits/onboardingStep) load with defaults and keep user values", () => {
    const old = { version: 1, onboardingComplete: true, theme: "light", provider: { kind: "gemini", dailySpendLimitUsd: 2 }, privacy: { conversationRetentionDays: 30 } };
    const s = loadSettings(old);
    expect(s).toMatchObject({
      onboardingComplete: true,
      theme: "light",
      provider: { kind: "gemini", dailySpendLimitUsd: 2 },
      privacy: { conversationRetentionDays: 30 },
      onboardingStep: 0,
      inference: { mode: "manual" },
    });
  });
  it("onboarding step persists", () => {
    const h = harness({ settings: { onboardingComplete: false } });
    h.core.updateSettings({ onboardingStep: 3 });
    expect(h.settings.onboardingStep).toBe(3);
  });
});
