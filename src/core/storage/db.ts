import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AssistantMode,
  ChatMessage,
  Conversation,
  ContextReference,
  KnowledgeDoc,
  MessageMeta,
  SearchHit,
  TranscriptSegment,
  TranscriptSession,
} from "../../shared/types";

/** Ordered, append-only list of schema migrations. Never edit a shipped migration — add a new one. */
export const MIGRATIONS: string[] = [
  // 1: core tables
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
     created_at INTEGER NOT NULL, refs TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}');
   CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
   CREATE TABLE transcript_sessions (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, provider TEXT NOT NULL);
   CREATE TABLE transcript_segments (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES transcript_sessions(id) ON DELETE CASCADE,
     start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, speaker TEXT, text TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX idx_segments_session ON transcript_segments(session_id, start_ms);
   CREATE TABLE knowledge_docs (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, chars INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE knowledge_chunks (
     id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
     ord INTEGER NOT NULL, text TEXT NOT NULL);`,
  // 2: full-text search across messages, transcripts and knowledge
  `CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
   CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
   CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
   CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
     INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
   CREATE VIRTUAL TABLE segments_fts USING fts5(text, content='transcript_segments', content_rowid='rowid');
   CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
     INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text); END;
   CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
     INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
   CREATE TRIGGER segments_au AFTER UPDATE OF text ON transcript_segments BEGIN
     INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
     INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text); END;
   CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='knowledge_chunks', content_rowid='rowid');
   CREATE TRIGGER chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
     INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;
   CREATE TRIGGER chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;`,
  // 3: settings key/value store and meeting insights cache
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE meeting_insights (session_id TEXT PRIMARY KEY REFERENCES transcript_sessions(id) ON DELETE CASCADE,
     data TEXT NOT NULL, created_at INTEGER NOT NULL);`,
];

type Row = Record<string, unknown>;

/** Turn free text into a safe FTS5 query: quoted terms joined by AND, prefix match on the last. */
export function toFtsQuery(input: string, joiner = " AND "): string | null {
  const terms = input
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(joiner);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  migrate(migrations = MIGRATIONS) {
    const current = this.schemaVersion();
    for (let v = current; v < migrations.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(migrations[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw new Error(`Database migration ${v + 1} failed: ${(err as Error).message}`);
      }
    }
  }

  // ---- kv ----
  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }
  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- conversations ----
  createConversation(title: string, mode: AssistantMode, now = Date.now()): Conversation {
    const id = randomUUID();
    this.db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)").run(id, title, mode, now, now);
    return { id, title, mode, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  getConversation(id: string): Conversation | null {
    const r = this.db
      .prepare(
        "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c WHERE id = ?",
      )
      .get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  listConversations(limit = 200): Conversation[] {
    return (
      this.db
        .prepare(
          "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c ORDER BY updated_at DESC LIMIT ?",
        )
        .all(limit) as Row[]
    ).map(toConversation);
  }

  renameConversation(id: string, title: string) {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.slice(0, 200), id);
  }

  deleteConversation(id: string) {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  addMessage(
    m: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): ChatMessage {
    const msg: ChatMessage = { ...m, id: m.id ?? randomUUID(), createdAt: m.createdAt ?? Date.now() };
    this.db
      .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(msg.id, msg.conversationId, msg.role, msg.content, msg.createdAt, JSON.stringify(msg.references), JSON.stringify(msg.meta));
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(msg.createdAt, msg.conversationId);
    return msg;
  }

  getMessage(id: string): ChatMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  deleteMessage(id: string) {
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }

  listMessages(conversationId: string): ChatMessage[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as Row[]
    ).map(toMessage);
  }

  // ---- transcripts ----
  createTranscriptSession(title: string, provider: string, now = Date.now()): TranscriptSession {
    const id = randomUUID();
    this.db.prepare("INSERT INTO transcript_sessions VALUES (?, ?, ?, NULL, ?)").run(id, title, now, provider);
    return { id, title, startedAt: now, endedAt: null, segmentCount: 0, provider };
  }

  endTranscriptSession(id: string, now = Date.now()) {
    this.db.prepare("UPDATE transcript_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now, id);
  }

  renameTranscriptSession(id: string, title: string) {
    this.db.prepare("UPDATE transcript_sessions SET title = ? WHERE id = ?").run(title.slice(0, 200), id);
  }

  listTranscriptSessions(): TranscriptSession[] {
    return (
      this.db
        .prepare(
          "SELECT s.*, (SELECT COUNT(*) FROM transcript_segments g WHERE g.session_id = s.id) AS n FROM transcript_sessions s ORDER BY started_at DESC",
        )
        .all() as Row[]
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      segmentCount: Number(r.n),
      provider: String(r.provider),
    }));
  }

  addSegment(s: Omit<TranscriptSegment, "id" | "edited">): TranscriptSegment {
    const seg: TranscriptSegment = { ...s, id: randomUUID(), edited: false };
    this.db
      .prepare("INSERT INTO transcript_segments VALUES (?, ?, ?, ?, ?, ?, 0)")
      .run(seg.id, seg.sessionId, seg.startMs, seg.endMs, seg.speaker, seg.text);
    return seg;
  }

  updateSegment(id: string, text: string, speaker: string | null) {
    this.db.prepare("UPDATE transcript_segments SET text = ?, speaker = ?, edited = 1 WHERE id = ?").run(text, speaker, id);
  }

  deleteSegment(id: string) {
    this.db.prepare("DELETE FROM transcript_segments WHERE id = ?").run(id);
  }

  listSegments(sessionId: string): TranscriptSegment[] {
    return (
      this.db.prepare("SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY start_ms, rowid").all(sessionId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      speaker: r.speaker == null ? null : String(r.speaker),
      text: String(r.text),
      edited: Number(r.edited) === 1,
    }));
  }

  deleteTranscriptSession(id: string) {
    this.db.prepare("DELETE FROM transcript_sessions WHERE id = ?").run(id);
  }

  saveInsights(sessionId: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO meeting_insights VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
      )
      .run(sessionId, JSON.stringify(data), Date.now());
  }

  getInsights<T>(sessionId: string): T | null {
    const r = this.db.prepare("SELECT data FROM meeting_insights WHERE session_id = ?").get(sessionId) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as T) : null;
  }

  // ---- knowledge base ----
  addKnowledgeDoc(title: string, source: string, chunks: string[], now = Date.now()): KnowledgeDoc {
    const id = randomUUID();
    const chars = chunks.reduce((s, c) => s + c.length, 0);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO knowledge_docs VALUES (?, ?, ?, ?, ?)").run(id, title, source, chars, now);
      const ins = this.db.prepare("INSERT INTO knowledge_chunks VALUES (?, ?, ?, ?)");
      chunks.forEach((c, i) => ins.run(randomUUID(), id, i, c));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { id, title, source, chars, chunkCount: chunks.length, createdAt: now };
  }

  listKnowledgeDocs(): KnowledgeDoc[] {
    return (
      this.db
        .prepare(
          "SELECT d.*, (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.doc_id = d.id) AS n FROM knowledge_docs d ORDER BY created_at DESC",
        )
        .all() as Row[]
    ).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      source: String(r.source),
      chars: Number(r.chars),
      chunkCount: Number(r.n),
      createdAt: Number(r.created_at),
    }));
  }

  deleteKnowledgeDoc(id: string) {
    this.db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(id);
  }

  /** BM25-ranked knowledge chunks for retrieval. */
  searchKnowledge(query: string, limit = 6): { docId: string; title: string; text: string; createdAt: number }[] {
    // Retrieval uses OR semantics so partial matches still surface.
    const orQuery = toFtsQuery(query, " OR ");
    if (!orQuery) return [];
    return (
      this.db
        .prepare(
          `SELECT c.doc_id, d.title, c.text, d.created_at FROM chunks_fts f
           JOIN knowledge_chunks c ON c.rowid = f.rowid JOIN knowledge_docs d ON d.id = c.doc_id
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
        .all(orQuery, limit) as Row[]
    ).map((r) => ({ docId: String(r.doc_id), title: String(r.title), text: String(r.text), createdAt: Number(r.created_at) }));
  }

  // ---- search ----
  search(query: string, limit = 50): SearchHit[] {
    const q = toFtsQuery(query);
    if (!q) return [];
    const msgs = (
      this.db
        .prepare(
          `SELECT m.id, m.conversation_id, c.title, m.created_at,
                  snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
        )
        .all(q, limit) as Row[]
    ).map<SearchHit>((r) => ({
      kind: "message",
      parentId: String(r.conversation_id),
      parentTitle: String(r.title),
      itemId: String(r.id),
      snippet: String(r.snip),
      createdAt: Number(r.created_at),
    }));
    const segs = (
      this.db
        .prepare(
          `SELECT g.id, g.session_id, s.title, s.started_at + g.start_ms AS at,
                  snippet(segments_fts, 0, '«', '»', '…', 12) AS snip
           FROM segments_fts f JOIN transcript_segments g ON g.rowid = f.rowid JOIN transcript_sessions s ON s.id = g.session_id
           WHERE segments_fts MATCH ? ORDER BY bm25(segments_fts) LIMIT ?`,
        )
        .all(q, limit) as Row[]
    ).map<SearchHit>((r) => ({
      kind: "transcript",
      parentId: String(r.session_id),
      parentTitle: String(r.title),
      itemId: String(r.id),
      snippet: String(r.snip),
      createdAt: Number(r.at),
    }));
    return [...msgs, ...segs].slice(0, limit);
  }

  // ---- retention, export, deletion ----
  applyRetention(conversationDays: number, transcriptDays: number, now = Date.now()): { conversations: number; transcripts: number } {
    let conversations = 0;
    let transcripts = 0;
    if (conversationDays > 0) {
      conversations = Number(
        this.db.prepare("DELETE FROM conversations WHERE updated_at < ?").run(now - conversationDays * 86_400_000).changes,
      );
    }
    if (transcriptDays > 0) {
      transcripts = Number(
        this.db
          .prepare("DELETE FROM transcript_sessions WHERE COALESCE(ended_at, started_at) < ?")
          .run(now - transcriptDays * 86_400_000).changes,
      );
    }
    return { conversations, transcripts };
  }

  counts() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      conversations: n("SELECT COUNT(*) AS n FROM conversations"),
      messages: n("SELECT COUNT(*) AS n FROM messages"),
      transcripts: n("SELECT COUNT(*) AS n FROM transcript_sessions"),
      knowledgeDocs: n("SELECT COUNT(*) AS n FROM knowledge_docs"),
    };
  }

  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: this.schemaVersion(),
      conversations: this.listConversations(100_000).map((c) => ({ ...c, messages: this.listMessages(c.id) })),
      transcripts: this.listTranscriptSessions().map((s) => ({
        ...s,
        segments: this.listSegments(s.id),
        insights: this.getInsights(s.id),
      })),
      knowledge: this.listKnowledgeDocs().map((d) => ({
        ...d,
        chunks: (this.db.prepare("SELECT text FROM knowledge_chunks WHERE doc_id = ? ORDER BY ord").all(d.id) as Row[]).map((r) =>
          String(r.text),
        ),
      })),
    };
  }

  deleteAll() {
    this.db.exec(
      "BEGIN; DELETE FROM conversations; DELETE FROM transcript_sessions; DELETE FROM knowledge_docs; DELETE FROM meeting_insights; COMMIT; VACUUM;",
    );
  }
}

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    mode: String(r.mode) as AssistantMode,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    messageCount: Number(r.n ?? 0),
  };
}

function toMessage(r: Row): ChatMessage {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    role: String(r.role) as ChatMessage["role"],
    content: String(r.content),
    createdAt: Number(r.created_at),
    references: safeJson<ContextReference[]>(String(r.refs), []),
    meta: safeJson<MessageMeta>(String(r.meta), {}),
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
