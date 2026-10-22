import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, Store, toFtsQuery } from "../core/storage/db";
import { applySettingsPatch, deepMerge, loadSettings } from "../shared/settingsSchema";
import { DEFAULT_SETTINGS } from "../shared/defaults";

const tmp: string[] = [];
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-test-"));
  tmp.push(dir);
  return path.join(dir, "t.db");
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("migrations", () => {
  it("migrates a fresh database to the latest version", () => {
    const s = new Store(":memory:");
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("upgrades an older database in place without losing data", () => {
    const file = tmpDb();
    const old = new Store(file);
    old.db.exec("PRAGMA user_version = 0");
    old.close();
    // Simulate a v1 database: create only the first migration.
    fs.rmSync(file);
    const raw = new DatabaseSync(file);
    raw.exec(MIGRATIONS[0]!);
    raw.exec("PRAGMA user_version = 1");
    raw.exec("INSERT INTO conversations VALUES ('c1','Old chat','general',1,1)");
    raw.exec("INSERT INTO messages VALUES ('m1','c1','user','legacy kubernetes question',1,'[]','{}')");
    raw.close();

    const s = new Store(file);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    expect(s.listMessages("c1")).toHaveLength(1);
    // v4 moves pre-session data into a default session.
    expect(s.getConversation("c1")!.sessionId).toBe("default");
    expect(s.listSessions().map((x) => x.title)).toEqual(["My first session"]);
    // Rows inserted before FTS existed are not indexed; new rows are.
    s.addMessage({ conversationId: "c1", role: "assistant", content: "kubernetes answer", references: [], meta: {} });
    expect(s.search("kubernetes", null).map((h) => h.itemId)).toHaveLength(1);
    s.close();
  });

  it("a fresh database has no implicit default session", () => {
    expect(new Store(":memory:").listSessions()).toEqual([]);
  });

  it("rolls back a failing migration and leaves the version unchanged", () => {
    const s = new Store(":memory:");
    expect(() => s.migrate([...MIGRATIONS, "CREATE TABLE broken (;"])).toThrow(new RegExp(`migration ${MIGRATIONS.length + 1} failed`));
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
  });
});

describe("Store", () => {
  it("stores conversations and messages with references and meta", () => {
    const s = new Store(":memory:");
    const sess = s.createSession({ title: "S", type: "coding" });
    const conv = s.createConversation(sess.id, "Test", "coding");
    s.addMessage({ conversationId: conv.id, role: "user", content: "hi", references: [], meta: {} });
    s.addMessage({ conversationId: conv.id, role: "assistant", content: "hello", references: [{ label: "C1", kind: "note", title: "n", excerpt: "e" }], meta: { model: "m" } });
    const msgs = s.listMessages(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.references[0]!.label).toBe("C1");
    expect(s.listConversations(sess.id)[0]!.messageCount).toBe(2);
    s.deleteConversation(conv.id);
    expect(s.listMessages(conv.id)).toHaveLength(0);
  });

  it("full-text searches messages and transcripts with safe query handling", () => {
    const s = new Store(":memory:");
    const sess = s.createSession({ title: "S", type: "general" });
    const conv = s.createConversation(sess.id, "Budget", "general");
    s.addMessage({ conversationId: conv.id, role: "assistant", content: "The Q3 budget review is on Friday", references: [], meta: {} });
    const t = s.createTranscriptSession(sess.id, "Standup", "deepgram");
    const seg = s.addSegment({ sessionId: t.id, startMs: 0, endMs: 1000, speaker: "Speaker 1", channel: "mic", confidence: 0.9, text: "Budget approval is pending" });
    expect(s.search("budget", null).map((h) => h.kind).sort()).toEqual(["message", "transcript"]);
    expect(s.search("bud", null)).toHaveLength(2); // prefix match
    expect(s.search('" OR 1=1; DROP TABLE messages; --', null)).toEqual([]);
    expect(s.search("", null)).toEqual([]);
    s.updateSegment(seg.id, "Funding approval is pending", null);
    expect(s.search("budget", null).map((h) => h.kind)).toEqual(["message"]);
    expect(s.listSegments(t.id)[0]!.edited).toBe(true);
  });

  it("toFtsQuery quotes terms so FTS operators cannot be injected", () => {
    expect(toFtsQuery('foo NEAR(bar) "x"')).toBe('"foo" AND "NEAR" AND "bar" AND "x"*');
    expect(toFtsQuery("!!!")).toBeNull();
  });

  it("retrieves knowledge chunks by relevance", () => {
    const s = new Store(":memory:");
    s.addKnowledgeDoc({ title: "Resume", source: "manual", chunks: ["Led migration of payments platform to Kotlin", "Hobbies: climbing"] });
    s.addKnowledgeDoc({ title: "JD", source: "manual", chunks: ["Senior Android engineer, Kotlin required"] });
    const hits = s.searchKnowledge("tell me about my kotlin experience", null);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => /kotlin/i.test(h.text))).toBe(true);
    expect(s.listKnowledgeDocs(null)[0]!.chunkCount).toBeGreaterThan(0);
  });

  it("applies retention and export/delete-all", () => {
    const s = new Store(":memory:");
    const day = 86_400_000;
    const now = 100 * day;
    const sess = s.createSession({ title: "S", type: "general" }, now);
    const old = s.createConversation(sess.id, "old", "general", now - 40 * day);
    s.createConversation(sess.id, "new", "general", now - day);
    const ot = s.createTranscriptSession(sess.id, "old t", "deepgram", now - 10 * day);
    s.endTranscriptSession(ot.id, now - 10 * day);
    s.createTranscriptSession(sess.id, "new t", "deepgram", now);
    expect(s.applyRetention(30, 7, now)).toEqual({ conversations: 1, transcripts: 1, context: 0 });
    expect(s.getConversation(old.id)).toBeNull();
    expect(s.applyRetention(0, 0, now)).toEqual({ conversations: 0, transcripts: 0, context: 0 });
    const exp = s.exportAll();
    expect(exp.sessions[0]!.conversations).toHaveLength(1);
    expect(exp.sessions[0]!.transcripts).toHaveLength(1);
    s.deleteAll();
    expect(s.counts()).toEqual({ sessions: 0, conversations: 0, messages: 0, transcripts: 0, knowledgeDocs: 0, contextItems: 0 });
  });
});

describe("settings persistence", () => {
  it("upgrades v0.1 settings (answer length → style) and drops unknown keys", () => {
    const s = loadSettings({ assistant: { length: "detailed", mode: "coding" }, bogus: 1, consent: { clipboard: true } });
    expect(s.assistant.style).toBe("detailed");
    expect(s.assistant.mode).toBe("coding");
    expect("length" in s.assistant).toBe(false);
    expect("bogus" in s).toBe(false);
    expect("clipboard" in s.consent).toBe(false);
  });

  it("fills missing fields from defaults and repairs invalid sections", () => {
    const s = loadSettings({ provider: { model: "claude-sonnet-5-5" }, overlay: { opacity: 99 } });
    expect(s.provider.model).toBe("claude-sonnet-5-5");
    expect(s.provider.effort).toBe(DEFAULT_SETTINGS.provider.effort);
    expect(s.overlay).toEqual(DEFAULT_SETTINGS.overlay);
    expect(loadSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects invalid patches with a readable error", () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { toggleOverlay: "rm -rf /" } })).toThrow(/shortcuts.toggleOverlay/);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { privacy: { keepScreenshotsInHistory: true } })).toThrow();
    expect(applySettingsPatch(DEFAULT_SETTINGS, { assistant: { mode: "coding" } }).assistant.mode).toBe("coding");
  });

  it("deepMerge ignores prototype-pollution keys", () => {
    const merged = deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true},"b":2}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged.b).toBe(2);
  });
});
