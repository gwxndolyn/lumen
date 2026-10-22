import { describe, expect, it } from "vitest";
import { fingerprint, frameDistance, hasChanged, FINGERPRINT_SIZE } from "../core/frameDiff";
import { highlight } from "../renderer/lib/highlight";
import { formatFromPath, markdownToText, sessionToMarkdown, type SessionExport } from "../core/exportFormat";
import { technicalPrompt } from "../core/workflows";
import { loadSettings } from "../shared/settingsSchema";
import { harness } from "./harness";

const N = FINGERPRINT_SIZE;
function bitmap(fill: (x: number, y: number) => number) {
  const b = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) b.fill(fill(x, y), (y * N + x) * 4, (y * N + x) * 4 + 3);
  return b;
}

describe("live screen change detection", () => {
  it("treats identical and near-identical frames as unchanged, real changes as changed", () => {
    const a = fingerprint(bitmap(() => 200), N, N);
    const noise = fingerprint(bitmap((x) => 200 + (x % 2)), N, N);
    const changed = fingerprint(bitmap((x, y) => (y < N / 2 ? 30 : 200)), N, N);
    expect(frameDistance(a, a)).toBe(0);
    expect(hasChanged(a, noise)).toBe(false);
    expect(hasChanged(a, changed)).toBe(true);
    expect(hasChanged(null, a)).toBe(true);
  });

  it("skips unchanged live frames without adding context or re-running OCR", async () => {
    const h = harness();
    let shade = 200;
    let captures = 0;
    (h.core as unknown as { deps: { liveScreenCapture: unknown } }).deps.liveScreenCapture = async () => {
      captures++;
      return {
        title: "Display",
        sourceId: "screen:1",
        vision: { mediaType: "image/jpeg" as const, data: Buffer.from(`f${captures}`).toString("base64") },
        ocrPng: Buffer.from("x"),
        thumbnailDataUrl: "data:,",
        fingerprint: fingerprint(bitmap(() => shade), N, N),
      };
    };
    const tick = () => (h.core as unknown as { liveScreenTick(): Promise<boolean> }).liveScreenTick();
    expect(await tick()).toBe(true);
    const first = h.core.engine.list(h.core.activeSessionId).find((r) => r.source === "screenshot")!.id;
    expect(await tick()).toBe(false);
    expect(h.core.engine.list(h.core.activeSessionId).find((r) => r.source === "screenshot")!.id).toBe(first);
    shade = 20;
    expect(await tick()).toBe(true);
    const shots = h.core.engine.list(h.core.activeSessionId).filter((r) => r.source === "screenshot");
    expect(shots).toHaveLength(1);
    expect(shots[0]!.id).not.toBe(first);
  });
});

describe("syntax highlighting", () => {
  it("tokenizes keywords, strings, comments, numbers and calls without losing text", () => {
    const code = 'def two_sum(nums, target):  # O(n)\n    seen = {}\n    return "x" + str(42)';
    const toks = highlight(code, "python");
    expect(toks.map((t) => t.text).join("")).toBe(code);
    const kinds = (k: string) => toks.filter((t) => t.kind === k).map((t) => t.text.trim());
    expect(kinds("kw")).toContain("def");
    expect(kinds("com")).toContain("# O(n)");
    expect(kinds("str")).toContain('"x"');
    expect(kinds("num")).toContain("42");
    expect(kinds("fn")).toContain("two_sum");
  });

  it("handles C-like comments, SQL case-insensitivity, and unknown languages as plain text", () => {
    expect(highlight("int x = 1; // c", "java").some((t) => t.kind === "com" && t.text === "// c")).toBe(true);
    expect(highlight("SELECT id FROM t", "sql").filter((t) => t.kind === "kw").map((t) => t.text)).toEqual(["SELECT", "FROM"]);
    expect(highlight("<b>hi</b>", "")).toEqual([{ kind: "plain", text: "<b>hi</b>" }]);
  });
});

describe("Markdown and plain-text exports", () => {
  const data: SessionExport = {
    session: { id: "s1", title: "Mock interview", type: "interview", notes: "Prep **STAR** stories", createdAt: 0, updatedAt: 0, contextTtlMinutes: null, ai: {} as never },
    conversations: [
      {
        id: "c1", sessionId: "s1", title: "Two sum", mode: "technical", createdAt: 0, updatedAt: 0, messageCount: 2,
        messages: [
          { id: "m1", conversationId: "c1", role: "user", content: "Solve two sum", createdAt: 0, references: [], meta: {} },
          { id: "m2", conversationId: "c1", role: "assistant", content: "Use a hash map.\n```python\nseen = {}\n```", createdAt: 0, references: [], meta: { model: "claude-opus-5-5" } },
        ],
      },
    ],
    transcripts: [],
  };

  it("exports a session as readable Markdown and plain text", () => {
    const md = sessionToMarkdown(data);
    expect(md).toContain("# Mock interview");
    expect(md).toContain("## Notes");
    expect(md).toContain("**Lumen (claude-opus-5-5):**");
    expect(md).toContain("```python");
    const txt = markdownToText(md);
    expect(txt).not.toMatch(/\*\*|```|^#/m);
    expect(txt).toContain("Mock interview\n==");
    expect(txt).toContain("    seen = {}");
    expect(txt).toContain("Prep STAR stories");
  });

  it("chooses the format from the saved file extension", () => {
    expect(formatFromPath("/a/b.md")).toBe("md");
    expect(formatFromPath("/a/b.TXT")).toBe("txt");
    expect(formatFromPath("/a/b.json")).toBe("json");
  });
});

describe("technical prompts", () => {
  it("is concise by default and full on request; separates assumptions from facts", () => {
    const concise = technicalPrompt("solve", "python", null, "");
    const full = technicalPrompt("solve", "python", null, "", { detail: "full" });
    expect(concise).toMatch(/Be concise/);
    expect(full).not.toMatch(/Be concise/);
    expect(full).toMatch(/Walkthrough/);
    expect(concise).toMatch(/Assumption:/);
  });

  it("supports system design and experience levels", () => {
    const p = technicalPrompt("system_design", "go", null, "Design a URL shortener", { level: "senior" });
    expect(p).toMatch(/High-level design/);
    expect(p).toMatch(/senior engineer/);
    expect(p).not.toMatch(/Go: idiomatic/);
  });

  it("defaults new technical settings for existing users", () => {
    const s = loadSettings({ technical: { language: "java" } });
    expect(s.technical).toEqual({ language: "java", level: "mid", detail: "concise" });
  });
});

describe("global cancel and audio toggle", () => {
  it("reports when no transcript is running and cancels nothing when idle", () => {
    const h = harness();
    expect(h.core.toggleTranscriptPause()).toBe("none");
    expect(h.core.cancelAllAnswers()).toBe(0);
  });

  it("pauses and resumes a running transcript; paused audio is not sent", () => {
    const h = harness();
    h.core.updateSettings({ consent: { microphone: true } });
    const live = h.core.startTranscript("call");
    const ws = h.sockets[0]!;
    ws.open();
    expect(h.core.toggleTranscriptPause()).toBe("paused");
    expect(live.status).toBe("paused");
    const before = ws.sent.length;
    h.core.pushAudio(new Uint8Array(320));
    expect(ws.sent.length).toBe(before);
    expect(h.core.toggleTranscriptPause()).toBe("resumed");
    expect(live.status).not.toBe("paused");
    h.core.stopTranscript();
    expect(h.core.toggleTranscriptPause()).toBe("none");
  });
});
