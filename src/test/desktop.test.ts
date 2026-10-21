import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clampToArea, defaultOverlayRect, moveToDisplay, resolveBounds } from "../../electron/geometry";
import { Logger, redact } from "../../electron/logger";
import { SecretStore, type Cipher } from "../../electron/secrets";
import { htmlToText } from "../../electron/documents";
import { toAccelerator } from "../renderer/lib/accelerator";

const primary = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const right = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

describe("multi-monitor geometry", () => {
  it("keeps a rect on its display when valid", () => {
    expect(resolveBounds({ x: 1600, y: 100, width: 560, height: 400, displayId: 2 }, [primary, right], primary)).toEqual({ x: 1600, y: 100, width: 560, height: 400, displayId: 2 });
  });

  it("recovers when the saved display was unplugged", () => {
    const r = resolveBounds({ x: 2500, y: 600, width: 560, height: 400, displayId: 2 }, [primary], primary);
    expect(r.displayId).toBe(1);
    expect(r.x + r.width).toBeLessThanOrEqual(1440);
    expect(r.y).toBeGreaterThanOrEqual(25);
  });

  it("moves to the display it mostly overlaps", () => {
    const r = resolveBounds({ x: 1300, y: 100, width: 560, height: 400, displayId: 1 }, [primary, right], primary);
    expect(r.displayId).toBe(2);
    expect(r.x).toBeGreaterThanOrEqual(1440);
  });

  it("shrinks rects larger than the work area", () => {
    expect(clampToArea({ x: -50, y: -50, width: 5000, height: 5000 }, primary.workArea)).toEqual(primary.workArea);
  });

  it("places the default overlay top-centre and preserves relative position across displays", () => {
    const d = defaultOverlayRect(primary.workArea);
    expect(d.x).toBe(440);
    const moved = moveToDisplay({ x: 0, y: 25, width: 560, height: 400 }, primary.workArea, right.workArea);
    expect(moved).toEqual({ x: 1440, y: 0, width: 560, height: 400 });
  });
});

describe("logging redaction", () => {
  it("removes API keys and tokens", () => {
    const s = redact('key sk-ant-api03-abcdefghijklmnop token="dg_1234567890abcdef" authorization: Bearer abcdefghijklmnop');
    expect(s).not.toMatch(/abcdefghijklmnop|dg_1234567890abcdef/);
    expect(s).toContain("sk-ant-[REDACTED]");
  });

  it("writes JSON lines with 0600 permissions and redacts on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-log-"));
    const l = new Logger(dir);
    l.info("hello", { apiKey: "sk-ant-api03-SECRETSECRETSECRET" });
    const text = fs.readFileSync(l.file, "utf8");
    expect(JSON.parse(text.trim()).msg).toBe("hello");
    expect(text).not.toContain("SECRETSECRET");
    if (process.platform !== "win32") expect(fs.statSync(l.file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("secret storage", () => {
  const xor: Cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  };

  it("never writes plaintext keys to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-sec-"));
    const s = new SecretStore(dir, xor);
    s.set("anthropic", "sk-ant-api03-PLAINTEXTKEY");
    const disk = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(disk).not.toContain("PLAINTEXTKEY");
    expect(new SecretStore(dir, xor).get("anthropic")).toBe("sk-ant-api03-PLAINTEXTKEY");
    s.clear("anthropic");
    expect(new SecretStore(dir, xor).has("anthropic")).toBe(Boolean(process.env.ANTHROPIC_API_KEY));
    fs.rmSync(dir, { recursive: true });
  });

  it("keeps keys in memory only when OS encryption is unavailable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-sec-"));
    const none: Cipher = { ...xor, isEncryptionAvailable: () => false };
    const s = new SecretStore(dir, none);
    s.set("deepgram", "dgkey1234567");
    expect(s.get("deepgram")).toBe("dgkey1234567");
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(() => s.set("deepgram", "has spaces in it")).toThrow();
    fs.rmSync(dir, { recursive: true });
  });
});

describe("documents", () => {
  it("strips scripts and tags from HTML", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><script>alert(1)</script>").trim()).toBe("Hi there");
  });
});

describe("shortcut recorder", () => {
  const ev = (o: Partial<Parameters<typeof toAccelerator>[0]>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  it("builds Electron accelerators and rejects bare keys", () => {
    expect(toAccelerator(ev({ code: "Space", key: " ", metaKey: true, shiftKey: true }), "darwin")).toBe("CommandOrControl+Shift+Space");
    expect(toAccelerator(ev({ code: "KeyK", key: "k", ctrlKey: true, altKey: true }), "win32")).toBe("CommandOrControl+Alt+K");
    expect(toAccelerator(ev({ code: "KeyK", key: "k" }), "win32")).toBeNull();
    expect(toAccelerator(ev({ code: "F9", key: "F9" }), "linux")).toBe("F9");
  });
});
