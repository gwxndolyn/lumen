// Regression tests for physical deletion: deleted user content must not remain readable in the
// database file or its write-ahead log (FTS segment pages, freed pages, WAL frames).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../core/storage/db";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fileStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-del-"));
  dirs.push(dir);
  const file = path.join(dir, "t.db");
  return { s: new Store(file), file };
}

function onDisk(file: string, marker: string): boolean {
  return ["", "-wal"].some((x) => fs.existsSync(file + x) && fs.readFileSync(file + x).includes(marker));
}

describe("physical deletion", () => {
  it("deleting a session removes its text from the DB file, the WAL and the FTS segments", () => {
    const { s, file } = fileStore();
    const sess = s.createSession({ title: "S", type: "general" });
    const c = s.createConversation(sess.id, "t", "general");
    for (let i = 0; i < 40; i++) s.addMessage({ conversationId: c.id, role: "user", content: `zxqvplumbus ${i} ${"pad ".repeat(100)}`, references: [], meta: {} });
    const t = s.createTranscriptSession(sess.id, "tr", "deepgram");
    s.addSegment({ sessionId: t.id, startMs: 0, endMs: 1, speaker: null, channel: "mic", confidence: null, text: "glorbfrazzle spoken" });
    s.addKnowledgeDoc({ title: "d", source: "m", chunks: ["quizzleworth passage"], sessionId: sess.id });
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(onDisk(file, "zxqvplumbus")).toBe(true);

    s.deleteSession(sess.id);
    for (const m of ["zxqvplumbus", "glorbfrazzle", "quizzleworth"]) expect(onDisk(file, m), m).toBe(false);
    s.close();
    for (const m of ["zxqvplumbus", "glorbfrazzle", "quizzleworth"]) expect(onDisk(file, m), m).toBe(false);
  });

  it("deleting a document, conversation or segment, or editing a segment, purges the old text", () => {
    const { s, file } = fileStore();
    const sess = s.createSession({ title: "S", type: "general" });
    const d = s.addKnowledgeDoc({ title: "d", source: "m", chunks: ["docmarkerqq text"], sessionId: null });
    const c = s.createConversation(sess.id, "t", "general");
    s.addMessage({ conversationId: c.id, role: "user", content: "convmarkerqq hello", references: [], meta: {} });
    const t = s.createTranscriptSession(sess.id, "tr", "deepgram");
    const seg = s.addSegment({ sessionId: t.id, startMs: 0, endMs: 1, speaker: null, channel: "mic", confidence: null, text: "segmarkerqq original" });
    const seg2 = s.addSegment({ sessionId: t.id, startMs: 2, endMs: 3, speaker: null, channel: "mic", confidence: null, text: "delmarkerqq gone" });
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    s.deleteKnowledgeDoc(d.id);
    s.deleteConversation(c.id);
    s.updateSegment(seg.id, "corrected wording", null);
    s.deleteSegment(seg2.id);
    for (const m of ["docmarkerqq", "convmarkerqq", "segmarkerqq", "delmarkerqq"]) expect(onDisk(file, m), m).toBe(false);
    expect(s.search("corrected", null)).toHaveLength(1);
  });

  it("delete-all leaves no user content behind", () => {
    const { s, file } = fileStore();
    const sess = s.createSession({ title: "allmarkerqq", type: "general" });
    const c = s.createConversation(sess.id, "t", "general");
    s.addMessage({ conversationId: c.id, role: "user", content: "allmarkerqq body", references: [], meta: {} });
    s.deleteAll();
    expect(onDisk(file, "allmarkerqq")).toBe(false);
  });

  it("segmentOwner reports the workspace session for authorization checks", () => {
    const { s } = fileStore();
    const a = s.createSession({ title: "A", type: "general" });
    const t = s.createTranscriptSession(a.id, "tr", "deepgram");
    const seg = s.addSegment({ sessionId: t.id, startMs: 0, endMs: 1, speaker: null, channel: "mic", confidence: null, text: "x" });
    expect(s.segmentOwner(seg.id)).toBe(a.id);
    expect(s.segmentOwner("nope")).toBeNull();
  });
});
