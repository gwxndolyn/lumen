// Support file: credentials and the user's home directory must never survive into the saved file.
import { describe, expect, it } from "vitest";
import { buildSupportBundle, scrub } from "../core/supportBundle";

const now = new Date("2026-10-23T08:00:00Z");

describe("support bundle: scrub", () => {
  it("redacts provider keys, bearer tokens and key-like fields", () => {
    const text = [
      "anthropic sk-ant-api03-abcdefghijklmnop",
      "openai sk-proj1234567890abcdefXYZ",
      "gemini AIzaSyA1234567890abcdefghijk",
      "auth Bearer eyJhbGciOiJIUzI1NiJ9.payload",
      '{"x-api-key": "dg_live_1234567890"}',
      "sha 0123456789abcdef0123456789abcdef01234567",
    ].join("\n");
    const out = scrub(text, "");
    expect(out).not.toMatch(/abcdefghijklmnop|1234567890abcdef|eyJhbGci|dg_live|0123456789abcdef0123/);
    expect(out).toContain("sk-ant-[REDACTED]");
    expect(out).toContain("AIza[REDACTED]");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("replaces the home directory in plain, forward-slash and JSON-escaped forms", () => {
    const home = "C:\\Users\\Jane Doe";
    const text = `a C:\\Users\\Jane Doe\\x b C:/Users/Jane Doe/y c ${JSON.stringify(home + "\\z")}`;
    const out = scrub(text, home);
    expect(out).not.toContain("Jane Doe");
    expect(scrub("/Users/jane/Library/Logs", "/Users/jane")).toBe("~/Library/Logs");
  });

  it("leaves text alone when home is empty or the root", () => {
    expect(scrub("/usr/bin and /tmp", "/")).toBe("/usr/bin and /tmp");
  });
});

describe("support bundle: build", () => {
  it("keeps only the log tail and scrubs the whole document", () => {
    const logText = Array.from({ length: 10 }, (_, i) => `line ${i} /Users/jane/app key=sk-ant-secretsecret${i}`).join("\n") + "\n";
    const out = buildSupportBundle({ diagnostics: { dataPath: "/Users/jane/Lumen" }, logText, home: "/Users/jane", now, maxLogLines: 3 });
    const parsed = JSON.parse(out) as { kind: string; generatedAt: string; diagnostics: { dataPath: string }; log: { totalLines: number; included: number; lines: string[] } };
    expect(parsed.kind).toBe("lumen-support-bundle");
    expect(parsed.generatedAt).toBe(now.toISOString());
    expect(parsed.log.totalLines).toBe(10);
    expect(parsed.log.included).toBe(3);
    expect(parsed.log.lines[0]).toMatch(/^line 7 /);
    expect(parsed.diagnostics.dataPath).toBe("~/Lumen");
    expect(out).not.toContain("/Users/jane");
    expect(out).not.toContain("secretsecret");
  });

  it("produces valid JSON when the log is empty", () => {
    const parsed = JSON.parse(buildSupportBundle({ diagnostics: {}, logText: "", home: "/Users/jane", now })) as { log: { included: number } };
    expect(parsed.log.included).toBe(0);
  });
});
