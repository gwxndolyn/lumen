import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AssistantMode,
  ChatMessage,
  Conversation,
  ContextReference,
  ContextSource,
  KnowledgeDoc,
  KnowledgeHit,
  MessageMeta,
  SearchHit,
  Session,
  SessionAiConfig,
  SessionSummary,
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
  // 4: workspace sessions. Every conversation, transcript and session-scoped document belongs to one;
  // deleting a session cascades to all of them (and, via triggers, to their FTS index rows).
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, context_ttl_minutes INTEGER, ai TEXT NOT NULL DEFAULT '{}');
   INSERT INTO sessions (id, title, type, created_at, updated_at)
     SELECT 'default', 'My first session', 'general',
       COALESCE((SELECT MIN(created_at) FROM conversations), 0), COALESCE((SELECT MAX(updated_at) FROM conversations), 0)
     WHERE EXISTS (SELECT 1 FROM conversations) OR EXISTS (SELECT 1 FROM transcript_sessions);
   ALTER TABLE conversations ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
   UPDATE conversations SET session_id = 'default';
   CREATE INDEX idx_conversations_session ON conversations(session_id, updated_at);
   ALTER TABLE transcript_sessions ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
   UPDATE transcript_sessions SET session_id = 'default';
   ALTER TABLE transcript_segments ADD COLUMN channel TEXT;
   ALTER TABLE transcript_segments ADD COLUMN confidence REAL;
   ALTER TABLE knowledge_docs ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
   ALTER TABLE knowledge_docs ADD COLUMN format TEXT NOT NULL DEFAULT 'text';
   ALTER TABLE knowledge_docs ADD COLUMN content_hash TEXT;
   CREATE TABLE context_items (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
     hash TEXT NOT NULL);
   CREATE INDEX idx_context_session ON context_items(session_id);
   CREATE TRIGGER chunks_au AFTER UPDATE OF text ON knowledge_chunks BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
     INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;`,
  // 5: usage ledger (no content: model, token counts, cost only) and last-open conversation
  `CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL);
   CREATE INDEX idx_usage_at ON usage_ledger(at);
   ALTER TABLE sessions ADD COLUMN last_conversation_id TEXT;`,
  // 6: durable, user-approved project memory (separate from session history)
  `CREATE TABLE memories (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
     session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER);
   CREATE INDEX idx_memories_kind ON memories(kind, updated_at);
   CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='rowid');
   CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text); END;
   CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
   CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
     INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text); END;`,
  // 7: richer usage accounting (provider, session, task, reported vs estimated) and local embeddings
  `ALTER TABLE usage_ledger ADD COLUMN provider TEXT;
   ALTER TABLE usage_ledger ADD COLUMN session_id TEXT;
   ALTER TABLE usage_ledger ADD COLUMN category TEXT;
   ALTER TABLE usage_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE usage_ledger ADD COLUMN cost_basis TEXT NOT NULL DEFAULT 'list_price';
   ALTER TABLE usage_ledger ADD COLUMN usage_basis TEXT NOT NULL DEFAULT 'reported';
   ALTER TABLE usage_ledger ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ok';
   ALTER TABLE usage_ledger ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE usage_ledger ADD COLUMN latency_ms INTEGER;
   CREATE INDEX idx_usage_session ON usage_ledger(session_id, at);
   CREATE TABLE chunk_embeddings (
     chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
     model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model, dims);`,
  // 8: local quality loop — response feedback, content-free quality events, user benchmark cases
  `CREATE TABLE feedback (
     id TEXT PRIMARY KEY, message_id TEXT, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
     note TEXT, expected TEXT, meta TEXT NOT NULL);
   CREATE INDEX idx_feedback_at ON feedback(created_at);
   CREATE TABLE quality_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, provider TEXT, model TEXT,
     category TEXT, code TEXT, latency_ms INTEGER, ttft_ms INTEGER, route TEXT, detail TEXT);
   CREATE INDEX idx_quality_events_at ON quality_events(at, type);
   CREATE TABLE user_eval_cases (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, feedback_id TEXT, definition TEXT NOT NULL, last_run TEXT);`,
  // 9: beta reports — what the user typed (draft) and the export status. The exported file itself
  // lives wherever the user saved it; only its file name is kept here.
  `CREATE TABLE beta_reports (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft','exported','export_failed')),
     input TEXT NOT NULL, exported_at INTEGER, exported_name TEXT, last_error TEXT);
   CREATE INDEX idx_beta_reports_updated ON beta_reports(updated_at);`,
  // 10: project workspace — approved local roots, durable tasks/plans, agent evidence, traced file
  // changes (with before/after content for conflict-safe revert), verification runs and approvals.
  // Everything is keyed by project_id; deleting a project reference cascades to its records only
  // (never to files on disk).
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
     last_opened_at INTEGER, settings TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '');
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
     tags TEXT NOT NULL DEFAULT '[]', reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     checkpoint TEXT, verification_required INTEGER NOT NULL DEFAULT 1);
   CREATE INDEX idx_tasks_project ON tasks(project_id, updated_at);
   CREATE TABLE task_steps (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, ord INTEGER NOT NULL,
     title TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]', note TEXT);
   CREATE INDEX idx_steps_task ON task_steps(task_id, ord);
   CREATE TABLE task_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     project_id TEXT NOT NULL, run_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, data TEXT);
   CREATE INDEX idx_events_task ON task_events(task_id, at);
   CREATE TABLE approvals (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id TEXT NOT NULL, kind TEXT NOT NULL,
     payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER);
   CREATE INDEX idx_approvals_project ON approvals(project_id, status);
   CREATE TABLE file_changes (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, run_id TEXT, path TEXT NOT NULL, kind TEXT NOT NULL,
     before_hash TEXT, after_hash TEXT, before_text TEXT, after_text TEXT, created_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'applied', note TEXT);
   CREATE INDEX idx_changes_project ON file_changes(project_id, created_at);
   CREATE TABLE verifications (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, label TEXT NOT NULL, argv TEXT NOT NULL, cwd TEXT NOT NULL,
     started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, exit_code INTEGER,
     output TEXT NOT NULL DEFAULT '', fingerprint TEXT);
   CREATE INDEX idx_verifications_project ON verifications(project_id, started_at);`,
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

const RETRIEVAL_STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your me my we our can do does tell about please".split(
    " ",
  ),
);

/** OR-query of meaningful terms for retrieval (stopwords would match everything). */
export function toRetrievalQuery(input: string): string | null {
  const terms = [...new Set(input.toLowerCase().split(/[^\p{L}\p{N}_]+/u))].filter((t) => t.length > 1 && !RETRIEVAL_STOPWORDS.has(t));
  return terms.length ? toFtsQuery(terms.join(" "), " OR ") : null;
}

export interface PersistedContextItem {
  id: string;
  sessionId: string;
  source: ContextSource;
  sourceId: string;
  title: string;
  text: string;
  createdAt: number;
  expiresAt: number | null;
  pinned: boolean;
  enabled: boolean;
  hash: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(
    readonly path: string,
    migrations: string[] = MIGRATIONS,
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;");
      this.migrate(migrations);
    } catch (err) {
      this.db.close();
      throw err;
    }
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
        throw new Error(`Database migration ${v + 1} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  }

  /**
   * Make deletions physical. `secure_delete` zeroes freed table pages, but FTS5 keeps deleted
   * terms (and their positions) inside its segment b-tree until the index is merged, and WAL keeps
   * old page images until a checkpoint. Run after any user-initiated deletion.
   */
  purgeDeleted() {
    for (const t of ["messages_fts", "segments_fts", "chunks_fts", "memories_fts"]) this.db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- kv ----
  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }
  deleteKv(key: string) {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- sessions ----
  createSession(input: { title: string; type: AssistantMode; notes?: string; contextTtlMinutes?: number | null; ai?: SessionAiConfig }, now = Date.now()): Session {
    const s: Session = {
      id: randomUUID(),
      title: input.title.trim().slice(0, 120) || "Untitled session",
      type: input.type,
      notes: input.notes ?? "",
      createdAt: now,
      updatedAt: now,
      contextTtlMinutes: input.contextTtlMinutes ?? null,
      ai: input.ai ?? {},
    };
    this.db
      .prepare("INSERT INTO sessions (id, title, type, notes, created_at, updated_at, context_ttl_minutes, ai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.title, s.type, s.notes, s.createdAt, s.updatedAt, s.contextTtlMinutes, JSON.stringify(s.ai));
    return s;
  }

  getSession(id: string): Session | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "type" | "notes" | "contextTtlMinutes" | "ai">>, now = Date.now()): Session | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: now };
    this.db
      .prepare("UPDATE sessions SET title = ?, type = ?, notes = ?, context_ttl_minutes = ?, ai = ?, updated_at = ? WHERE id = ?")
      .run(next.title.slice(0, 120), next.type, next.notes.slice(0, 50_000), next.contextTtlMinutes, JSON.stringify(next.ai), now, id);
    return next;
  }

  touchSession(id: string, now = Date.now()) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
  }

  listSessions(): SessionSummary[] {
    return (
      this.db
        .prepare(
          `SELECT s.*,
             (SELECT COUNT(*) FROM conversations c WHERE c.session_id = s.id) AS nc,
             (SELECT COUNT(*) FROM transcript_sessions t WHERE t.session_id = s.id) AS nt,
             (SELECT COUNT(*) FROM context_items x WHERE x.session_id = s.id) AS nx,
             (SELECT COUNT(*) FROM knowledge_docs d WHERE d.session_id = s.id) AS nd
           FROM sessions s ORDER BY updated_at DESC`,
        )
        .all() as Row[]
    ).map((r) => ({
      ...toSession(r),
      conversations: Number(r.nc),
      transcripts: Number(r.nt),
      contextItems: Number(r.nx),
      documents: Number(r.nd),
    }));
  }

  /** Deletes the session and, by cascade, its conversations, messages, transcripts, segments, insights, documents, chunks and stored context. */
  deleteSession(id: string): boolean {
    const ok = Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) > 0;
    this.purgeDeleted();
    return ok;
  }

  exportSession(id: string) {
    const session = this.getSession(id);
    if (!session) return null;
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: this.schemaVersion(),
      session,
      conversations: this.listConversations(id, 100_000).map((c) => ({ ...c, messages: this.listMessages(c.id) })),
      transcripts: this.listTranscriptSessions(id).map((t) => ({ ...t, segments: this.listSegments(t.id), insights: this.getInsights(t.id) })),
      documents: this.listKnowledgeDocs(id, false).map((d) => ({ ...d, chunks: this.docChunks(d.id) })),
      context: this.listContextItems(id),
    };
  }

  setLastConversation(sessionId: string, conversationId: string | null) {
    this.db.prepare("UPDATE sessions SET last_conversation_id = ? WHERE id = ?").run(conversationId, sessionId);
  }

  /** Last conversation the user had open in a session, if it still exists and belongs to it. */
  getLastConversation(sessionId: string): string | null {
    const r = this.db.prepare("SELECT c.id FROM sessions s JOIN conversations c ON c.id = s.last_conversation_id AND c.session_id = s.id WHERE s.id = ?").get(sessionId) as Row | undefined;
    return r ? String(r.id) : null;
  }

  // ---- usage ledger (spend limits; no content) ----
  recordUsage(model: string, inputTokens: number, outputTokens: number, costUsd: number, at = Date.now(), extra: Partial<UsageExtra> = {}) {
    this.db
      .prepare(
        `INSERT INTO usage_ledger (at, model, input_tokens, output_tokens, cost_usd, provider, session_id, category, cache_read_tokens, cost_basis, usage_basis, outcome, retries, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        extra.provider ?? null,
        extra.sessionId ?? null,
        extra.category ?? null,
        extra.cacheReadTokens ?? 0,
        extra.costBasis ?? "list_price",
        extra.usageBasis ?? "reported",
        extra.outcome ?? "ok",
        extra.retries ?? 0,
        extra.latencyMs ?? null,
      );
    this.db.prepare("DELETE FROM usage_ledger WHERE at < ?").run(at - 90 * 86_400_000);
  }

  sessionUsage(sessionId: string): { costUsd: number; requests: number } {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM usage_ledger WHERE session_id = ?").get(sessionId) as Row;
    return { costUsd: Number(r.c), requests: Number(r.n) };
  }

  /** Aggregates for the usage report: totals per provider/model and per task category. */
  usageReport(since: number) {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(provider, '') AS provider, model, COALESCE(category, '') AS category, cost_basis, usage_basis, outcome,
                COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cost_usd) AS c, SUM(retries) AS rt, AVG(latency_ms) AS lat
         FROM usage_ledger WHERE at >= ? GROUP BY provider, model, category, cost_basis, usage_basis, outcome ORDER BY c DESC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      provider: String(r.provider) || null,
      model: String(r.model),
      category: String(r.category) || null,
      costBasis: String(r.cost_basis) as UsageExtra["costBasis"],
      usageBasis: String(r.usage_basis) as UsageExtra["usageBasis"],
      outcome: String(r.outcome),
      requests: Number(r.n),
      inputTokens: Number(r.i),
      outputTokens: Number(r.o),
      cacheReadTokens: Number(r.cr),
      costUsd: Math.round(Number(r.c) * 1e6) / 1e6,
      retries: Number(r.rt),
      avgLatencyMs: r.lat == null ? null : Math.round(Number(r.lat)),
    }));
  }

  // ---- quality loop (local only) ----
  addFeedback(f: { id: string; messageId: string | null; createdAt: number; kind: string; note: string | null; expected: string | null; meta: unknown }) {
    this.db
      .prepare("INSERT INTO feedback (id, message_id, created_at, kind, note, expected, meta) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(f.id, f.messageId, f.createdAt, f.kind, f.note, f.expected, JSON.stringify(f.meta));
  }

  listFeedback(limit = 500): { id: string; messageId: string | null; createdAt: number; kind: string; note: string | null; expected: string | null; meta: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: String(r.id),
      messageId: r.message_id == null ? null : String(r.message_id),
      createdAt: Number(r.created_at),
      kind: String(r.kind),
      note: r.note == null ? null : String(r.note),
      expected: r.expected == null ? null : String(r.expected),
      meta: safeJson<Record<string, unknown>>(String(r.meta), {}),
    }));
  }

  getFeedback(id: string) {
    return this.listFeedback(100_000).find((f) => f.id === id) ?? null;
  }

  deleteFeedback(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM feedback WHERE id = ?").run(id).changes) > 0;
  }

  addQualityEvent(e: {
    at: number;
    type: string;
    provider?: string | null;
    model?: string | null;
    category?: string | null;
    code?: string | null;
    latencyMs?: number | null;
    ttftMs?: number | null;
    route?: string | null;
    detail?: string | null;
  }) {
    this.db
      .prepare("INSERT INTO quality_events (at, type, provider, model, category, code, latency_ms, ttft_ms, route, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.at, e.type, e.provider ?? null, e.model ?? null, e.category ?? null, e.code ?? null, e.latencyMs ?? null, e.ttftMs ?? null, e.route ?? null, e.detail ?? null);
  }

  qualityEvents(since: number): {
    at: number;
    type: string;
    provider: string | null;
    model: string | null;
    category: string | null;
    code: string | null;
    latencyMs: number | null;
    ttftMs: number | null;
    route: string | null;
    detail: string | null;
  }[] {
    return (this.db.prepare("SELECT * FROM quality_events WHERE at >= ? ORDER BY at").all(since) as Row[]).map((r) => ({
      at: Number(r.at),
      type: String(r.type),
      provider: r.provider == null ? null : String(r.provider),
      model: r.model == null ? null : String(r.model),
      category: r.category == null ? null : String(r.category),
      code: r.code == null ? null : String(r.code),
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
      ttftMs: r.ttft_ms == null ? null : Number(r.ttft_ms),
      route: r.route == null ? null : String(r.route),
      detail: r.detail == null ? null : String(r.detail),
    }));
  }

  pruneQuality(before: number): number {
    const a = Number(this.db.prepare("DELETE FROM quality_events WHERE at < ?").run(before).changes);
    const b = Number(this.db.prepare("DELETE FROM feedback WHERE created_at < ?").run(before).changes);
    return a + b;
  }

  clearQuality() {
    this.db.exec("DELETE FROM quality_events; DELETE FROM feedback; DELETE FROM user_eval_cases;");
  }

  // ---- beta reports (local drafts and export status) ----
  saveBetaReport(r: { id: string; createdAt: number; updatedAt: number; status: string; input: unknown; exportedAt?: number | null; exportedName?: string | null; lastError?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO beta_reports (id, created_at, updated_at, status, input, exported_at, exported_name, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, input = excluded.input,
           exported_at = excluded.exported_at, exported_name = excluded.exported_name, last_error = excluded.last_error`,
      )
      .run(r.id, r.createdAt, r.updatedAt, r.status, JSON.stringify(r.input), r.exportedAt ?? null, r.exportedName ?? null, r.lastError ?? null);
  }

  listBetaReports(
    limit = 200,
  ): { id: string; createdAt: number; updatedAt: number; status: string; input: unknown; exportedAt: number | null; exportedName: string | null; lastError: string | null }[] {
    return (this.db.prepare("SELECT * FROM beta_reports ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      status: String(r.status),
      input: safeJson(String(r.input), null),
      exportedAt: r.exported_at == null ? null : Number(r.exported_at),
      exportedName: r.exported_name == null ? null : String(r.exported_name),
      lastError: r.last_error == null ? null : String(r.last_error),
    }));
  }

  getBetaReport(id: string) {
    const r = this.db.prepare("SELECT id FROM beta_reports WHERE id = ?").get(id) as Row | undefined;
    return r ? (this.listBetaReports(100_000).find((x) => x.id === id) ?? null) : null;
  }

  deleteBetaReport(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM beta_reports WHERE id = ?").run(id).changes) > 0;
  }

  pruneBetaReports(before: number): number {
    return Number(this.db.prepare("DELETE FROM beta_reports WHERE updated_at < ?").run(before).changes);
  }

  saveUserCase(id: string, definition: unknown, feedbackId: string | null, now = Date.now()) {
    this.db
      .prepare("INSERT OR REPLACE INTO user_eval_cases (id, created_at, feedback_id, definition, last_run) VALUES (?, ?, ?, ?, (SELECT last_run FROM user_eval_cases WHERE id = ?))")
      .run(id, now, feedbackId, JSON.stringify(definition), id);
  }

  listUserCases(): { id: string; createdAt: number; feedbackId: string | null; definition: unknown; lastRun: unknown }[] {
    return (this.db.prepare("SELECT * FROM user_eval_cases ORDER BY created_at DESC").all() as Row[]).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      feedbackId: r.feedback_id == null ? null : String(r.feedback_id),
      definition: safeJson(String(r.definition), null),
      lastRun: r.last_run == null ? null : safeJson(String(r.last_run), null),
    }));
  }

  setUserCaseRun(id: string, result: unknown) {
    this.db.prepare("UPDATE user_eval_cases SET last_run = ? WHERE id = ?").run(JSON.stringify(result), id);
  }

  deleteUserCase(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM user_eval_cases WHERE id = ?").run(id).changes) > 0;
  }

  // ---- local embeddings (one model per index; mixing spaces is rejected) ----
  embeddingIndexInfo(): { model: string; dims: number; chunks: number }[] {
    return (this.db.prepare("SELECT model, dims, COUNT(*) AS n FROM chunk_embeddings GROUP BY model, dims").all() as Row[]).map((r) => ({
      model: String(r.model),
      dims: Number(r.dims),
      chunks: Number(r.n),
    }));
  }

  chunksWithoutEmbedding(model: string, limit: number): { id: string; text: string }[] {
    return (
      this.db.prepare("SELECT c.id, c.text FROM knowledge_chunks c LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? WHERE e.chunk_id IS NULL LIMIT ?").all(model, limit) as Row[]
    ).map((r) => ({ id: String(r.id), text: String(r.text) }));
  }

  countChunks(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as Row).n);
  }

  saveEmbeddings(model: string, rows: { chunkId: string; vector: Float32Array }[], now = Date.now()) {
    const dims = rows[0]?.vector.length ?? 0;
    const existing = this.embeddingIndexInfo();
    if (existing.some((e) => e.model !== model || e.dims !== dims)) throw new Error("The embedding index was built with a different model. Rebuild it before adding new vectors.");
    const ins = this.db.prepare("INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (r.vector.length !== dims) throw new Error("Embedding dimensions changed within one batch.");
        ins.run(r.chunkId, model, dims, Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength), now);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Vectors for chunks visible to a session (its own and global documents). */
  embeddingsForScope(model: string, sessionId: string | null): { chunkId: string; docId: string; title: string; text: string; vector: Float32Array }[] {
    const scope = sessionId ? "(d.session_id IS NULL OR d.session_id = ?)" : "d.session_id IS NULL";
    const rows = this.db
      .prepare(
        `SELECT e.chunk_id, e.vector, c.doc_id, c.text, d.title FROM chunk_embeddings e JOIN knowledge_chunks c ON c.id = e.chunk_id JOIN knowledge_docs d ON d.id = c.doc_id
         WHERE e.model = ? AND ${scope}`,
      )
      .all(...(sessionId ? [model, sessionId] : [model])) as Row[];
    return rows.map((r) => {
      const b = r.vector as Uint8Array;
      return {
        chunkId: String(r.chunk_id),
        docId: String(r.doc_id),
        title: String(r.title),
        text: String(r.text),
        vector: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
      };
    });
  }

  clearEmbeddings() {
    this.db.exec("DELETE FROM chunk_embeddings");
  }

  spendSince(since: number): { costUsd: number; requests: number } {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM usage_ledger WHERE at >= ?").get(since) as Row;
    return { costUsd: Number(r.c), requests: Number(r.n) };
  }

  // ---- persisted session context (text only; images are never stored) ----
  saveContextItem(c: PersistedContextItem) {
    this.db
      .prepare(
        `INSERT INTO context_items (id, session_id, source, source_id, title, text, created_at, expires_at, pinned, enabled, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, text = excluded.text, created_at = excluded.created_at,
           expires_at = excluded.expires_at, pinned = excluded.pinned, enabled = excluded.enabled, hash = excluded.hash`,
      )
      .run(c.id, c.sessionId, c.source, c.sourceId, c.title, c.text, c.createdAt, c.expiresAt, c.pinned ? 1 : 0, c.enabled ? 1 : 0, c.hash);
  }

  deleteContextItem(id: string) {
    this.db.prepare("DELETE FROM context_items WHERE id = ?").run(id);
  }

  /** Physically drop freed pages for deleted context items (no FTS involved). */
  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  listContextItems(sessionId?: string): PersistedContextItem[] {
    const rows = (
      sessionId ? this.db.prepare("SELECT * FROM context_items WHERE session_id = ? ORDER BY created_at").all(sessionId) : this.db.prepare("SELECT * FROM context_items ORDER BY created_at").all()
    ) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      source: String(r.source) as ContextSource,
      sourceId: String(r.source_id),
      title: String(r.title),
      text: String(r.text),
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      pinned: Number(r.pinned) === 1,
      enabled: Number(r.enabled) === 1,
      hash: String(r.hash),
    }));
  }

  deleteExpiredContext(now = Date.now()): number {
    return Number(this.db.prepare("DELETE FROM context_items WHERE expires_at IS NOT NULL AND expires_at <= ? AND pinned = 0").run(now).changes);
  }

  // ---- conversations ----
  createConversation(sessionId: string, title: string, mode: AssistantMode, now = Date.now()): Conversation {
    const id = randomUUID();
    this.db.prepare("INSERT INTO conversations (id, title, mode, created_at, updated_at, session_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, title, mode, now, now, sessionId);
    this.touchSession(sessionId, now);
    return { id, sessionId, title, mode, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c WHERE id = ?").get(id) as Row | undefined;
    return r ? toConversation(r) : null;
  }

  listConversations(sessionId: string | null, limit = 200): Conversation[] {
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c
                 ${sessionId ? "WHERE session_id = ?" : ""} ORDER BY updated_at DESC LIMIT ?`;
    const rows = (sessionId ? this.db.prepare(sql).all(sessionId, limit) : this.db.prepare(sql).all(limit)) as Row[];
    return rows.map(toConversation);
  }

  renameConversation(id: string, title: string) {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.slice(0, 200), id);
  }

  deleteConversation(id: string) {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    this.purgeDeleted();
  }

  addMessage(m: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: number }): ChatMessage {
    const msg: ChatMessage = { ...m, id: m.id ?? randomUUID(), createdAt: m.createdAt ?? Date.now() };
    this.db
      .prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, refs, meta) VALUES (?, ?, ?, ?, ?, ?, ?)")
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
    return (this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as Row[]).map(toMessage);
  }

  // ---- transcripts ----
  createTranscriptSession(sessionId: string, title: string, provider: string, now = Date.now()): TranscriptSession {
    const id = randomUUID();
    this.db.prepare("INSERT INTO transcript_sessions (id, title, started_at, ended_at, provider, session_id) VALUES (?, ?, ?, NULL, ?, ?)").run(id, title, now, provider, sessionId);
    this.touchSession(sessionId, now);
    return { id, sessionId, title, startedAt: now, endedAt: null, segmentCount: 0, provider, persisted: true };
  }

  /**
   * Close transcripts left open by a crash or forced quit (no live recording can exist at startup).
   * The end time is the last segment's time, so durations stay truthful. Returns how many were closed.
   */
  closeInterruptedTranscripts(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE transcript_sessions SET ended_at = started_at + COALESCE((SELECT MAX(end_ms) FROM transcript_segments g WHERE g.session_id = transcript_sessions.id), 0)
           WHERE ended_at IS NULL`,
        )
        .run().changes,
    );
  }

  endTranscriptSession(id: string, now = Date.now()) {
    this.db.prepare("UPDATE transcript_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now, id);
  }

  renameTranscriptSession(id: string, title: string) {
    this.db.prepare("UPDATE transcript_sessions SET title = ? WHERE id = ?").run(title.slice(0, 200), id);
  }

  getTranscriptSession(id: string): TranscriptSession | null {
    return this.listTranscriptSessions(null).find((t) => t.id === id) ?? null;
  }

  listTranscriptSessions(sessionId: string | null): TranscriptSession[] {
    const sql = `SELECT s.*, (SELECT COUNT(*) FROM transcript_segments g WHERE g.session_id = s.id) AS n FROM transcript_sessions s
                 ${sessionId ? "WHERE s.session_id = ?" : ""} ORDER BY started_at DESC`;
    const rows = (sessionId ? this.db.prepare(sql).all(sessionId) : this.db.prepare(sql).all()) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      title: String(r.title),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      segmentCount: Number(r.n),
      provider: String(r.provider),
      persisted: true,
    }));
  }

  addSegment(s: Omit<TranscriptSegment, "id" | "edited">): TranscriptSegment {
    const seg: TranscriptSegment = { ...s, id: randomUUID(), edited: false };
    this.db
      .prepare("INSERT INTO transcript_segments (id, session_id, start_ms, end_ms, speaker, text, edited, channel, confidence) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(seg.id, seg.sessionId, seg.startMs, seg.endMs, seg.speaker, seg.text, seg.channel, seg.confidence);
    return seg;
  }

  updateSegment(id: string, text: string, speaker: string | null) {
    this.db.prepare("UPDATE transcript_segments SET text = ?, speaker = ?, edited = 1 WHERE id = ?").run(text, speaker, id);
    this.purgeDeleted(); // the edited-away text must not linger in the index
  }

  deleteSegment(id: string) {
    this.db.prepare("DELETE FROM transcript_segments WHERE id = ?").run(id);
    this.purgeDeleted();
  }

  /** Workspace session that owns a transcript segment (for authorization checks). */
  segmentOwner(segmentId: string): string | null {
    const r = this.db.prepare("SELECT s.session_id FROM transcript_segments g JOIN transcript_sessions s ON s.id = g.session_id WHERE g.id = ?").get(segmentId) as Row | undefined;
    return r ? String(r.session_id) : null;
  }

  listSegments(transcriptId: string): TranscriptSegment[] {
    return (this.db.prepare("SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY start_ms, rowid").all(transcriptId) as Row[]).map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      speaker: r.speaker == null ? null : String(r.speaker),
      channel: r.channel == null ? null : (String(r.channel) as TranscriptSegment["channel"]),
      text: String(r.text),
      edited: Number(r.edited) === 1,
      confidence: r.confidence == null ? null : Number(r.confidence),
    }));
  }

  deleteTranscriptSession(id: string) {
    this.db.prepare("DELETE FROM transcript_sessions WHERE id = ?").run(id);
    this.purgeDeleted();
  }

  saveInsights(transcriptId: string, data: unknown) {
    this.db
      .prepare("INSERT INTO meeting_insights (session_id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at")
      .run(transcriptId, JSON.stringify(data), Date.now());
  }

  /** Replace stored notes after a user edit (kept separate from generation). */
  updateInsights(transcriptId: string, data: unknown): boolean {
    return Number(this.db.prepare("UPDATE meeting_insights SET data = ? WHERE session_id = ?").run(JSON.stringify(data), transcriptId).changes) > 0;
  }

  getInsights<T>(transcriptId: string): T | null {
    const r = this.db.prepare("SELECT data FROM meeting_insights WHERE session_id = ?").get(transcriptId) as Row | undefined;
    return r ? (JSON.parse(String(r.data)) as T) : null;
  }

  // ---- knowledge base ----
  findDocByHash(hash: string, sessionId: string | null): KnowledgeDoc | null {
    const r = this.db
      .prepare(`SELECT d.*, 0 AS n FROM knowledge_docs d WHERE content_hash = ? AND ${sessionId ? "session_id = ?" : "session_id IS NULL"}`)
      .get(...(sessionId ? [hash, sessionId] : [hash])) as Row | undefined;
    return r ? toDoc(r) : null;
  }

  addKnowledgeDoc(input: { title: string; source: string; chunks: string[]; sessionId?: string | null; format?: string; hash?: string }, now = Date.now()): KnowledgeDoc {
    const id = randomUUID();
    const chars = input.chunks.reduce((s, c) => s + c.length, 0);
    const sessionId = input.sessionId ?? null;
    this.tx(() => {
      this.db
        .prepare("INSERT INTO knowledge_docs (id, title, source, chars, created_at, session_id, format, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.title, input.source, chars, now, sessionId, input.format ?? "text", input.hash ?? null);
      const ins = this.db.prepare("INSERT INTO knowledge_chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)");
      input.chunks.forEach((c, i) => ins.run(randomUUID(), id, i, c));
    });
    return { id, title: input.title, source: input.source, sessionId, format: input.format ?? "text", chars, chunkCount: input.chunks.length, createdAt: now };
  }

  /** Global documents plus (optionally) those attached to one session. */
  listKnowledgeDocs(sessionId: string | null, includeGlobal = true): KnowledgeDoc[] {
    const where = sessionId ? (includeGlobal ? "WHERE d.session_id IS NULL OR d.session_id = ?" : "WHERE d.session_id = ?") : "WHERE d.session_id IS NULL";
    const rows = this.db
      .prepare(`SELECT d.*, (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.doc_id = d.id) AS n FROM knowledge_docs d ${where} ORDER BY created_at DESC`)
      .all(...(sessionId ? [sessionId] : [])) as Row[];
    return rows.map(toDoc);
  }

  docChunks(docId: string): string[] {
    return (this.db.prepare("SELECT text FROM knowledge_chunks WHERE doc_id = ? ORDER BY ord").all(docId) as Row[]).map((r) => String(r.text));
  }

  deleteKnowledgeDoc(id: string) {
    this.db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(id);
    this.purgeDeleted();
  }

  /** BM25-ranked knowledge passages visible to `sessionId` (global + that session's documents only). */
  // ---------------- project memory ----------------

  addMemory(m: { kind: MemoryKind; text: string; sessionId: string | null; expiresAt: number | null }, now = Date.now()): MemoryItem {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO memories (id, kind, text, session_id, created_at, updated_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(id, m.kind, m.text, m.sessionId, now, now, m.expiresAt);
    return this.getMemory(id)!;
  }

  getMemory(id: string): MemoryItem | null {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return r ? toMemory(r) : null;
  }

  listMemories(now = Date.now()): MemoryItem[] {
    return (this.db.prepare("SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ? ORDER BY kind, updated_at DESC").all(now) as Row[]).map(toMemory);
  }

  updateMemory(id: string, patch: { text?: string; kind?: MemoryKind; expiresAt?: number | null }, now = Date.now()): MemoryItem | null {
    const cur = this.getMemory(id);
    if (!cur) return null;
    this.db
      .prepare("UPDATE memories SET text = ?, kind = ?, expires_at = ?, updated_at = ? WHERE id = ?")
      .run(patch.text ?? cur.text, patch.kind ?? cur.kind, patch.expiresAt === undefined ? cur.expiresAt : patch.expiresAt, now, id);
    if (patch.text !== undefined && patch.text !== cur.text) this.purgeDeleted();
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const ok = Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
    if (ok) this.purgeDeleted();
    return ok;
  }

  /** Full-text match over active memories, most relevant first. */
  searchMemories(query: string, limit: number, now = Date.now()): MemoryItem[] {
    const q = toRetrievalQuery(query);
    if (!q) return [];
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND (m.expires_at IS NULL OR m.expires_at > ?) ORDER BY bm25(memories_fts) LIMIT ?`,
        )
        .all(q, now, limit) as Row[]
    ).map(toMemory);
  }

  touchMemories(ids: string[], now = Date.now()) {
    const st = this.db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
    for (const id of ids) st.run(now, id);
  }

  sweepMemories(now = Date.now()): number {
    const n = Number(this.db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now).changes);
    if (n) this.purgeDeleted();
    return n;
  }

  searchKnowledge(query: string, sessionId: string | null, limit = 6): KnowledgeHit[] {
    const q = toRetrievalQuery(query);
    if (!q) return [];
    const scope = sessionId ? "(d.session_id IS NULL OR d.session_id = ?)" : "d.session_id IS NULL";
    return (
      this.db
        .prepare(
          `SELECT c.id AS chunk_id, c.doc_id, d.title, c.text, d.session_id, snippet(chunks_fts, 0, '«', '»', '…', 16) AS snip
           FROM chunks_fts f JOIN knowledge_chunks c ON c.rowid = f.rowid JOIN knowledge_docs d ON d.id = c.doc_id
           WHERE chunks_fts MATCH ? AND ${scope} ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
        .all(...(sessionId ? [q, sessionId, limit] : [q, limit])) as Row[]
    ).map((r) => ({
      docId: String(r.doc_id),
      chunkId: String(r.chunk_id),
      title: String(r.title),
      text: String(r.text),
      snippet: String(r.snip),
      sessionId: r.session_id == null ? null : String(r.session_id),
    }));
  }

  // ---- search ----
  /** Full-text search of messages and transcripts. When `sessionId` is set, results are restricted to it. */
  search(query: string, sessionId: string | null, limit = 50, mode: "all" | "any" = "all"): SearchHit[] {
    const q = mode === "any" ? toRetrievalQuery(query) : toFtsQuery(query);
    if (!q) return [];
    const msgs = (
      this.db
        .prepare(
          `SELECT m.id, m.conversation_id, c.title, c.session_id, m.created_at, snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? ${sessionId ? "AND c.session_id = ?" : ""} ORDER BY bm25(messages_fts) LIMIT ?`,
        )
        .all(...(sessionId ? [q, sessionId, limit] : [q, limit])) as Row[]
    ).map<SearchHit>((r) => ({
      kind: "message",
      sessionId: String(r.session_id),
      parentId: String(r.conversation_id),
      parentTitle: String(r.title),
      itemId: String(r.id),
      snippet: String(r.snip),
      createdAt: Number(r.created_at),
    }));
    const segs = (
      this.db
        .prepare(
          `SELECT g.id, g.session_id AS tid, s.title, s.session_id, s.started_at + g.start_ms AS at, snippet(segments_fts, 0, '«', '»', '…', 12) AS snip
           FROM segments_fts f JOIN transcript_segments g ON g.rowid = f.rowid JOIN transcript_sessions s ON s.id = g.session_id
           WHERE segments_fts MATCH ? ${sessionId ? "AND s.session_id = ?" : ""} ORDER BY bm25(segments_fts) LIMIT ?`,
        )
        .all(...(sessionId ? [q, sessionId, limit] : [q, limit])) as Row[]
    ).map<SearchHit>((r) => ({
      kind: "transcript",
      sessionId: String(r.session_id),
      parentId: String(r.tid),
      parentTitle: String(r.title),
      itemId: String(r.id),
      snippet: String(r.snip),
      createdAt: Number(r.at),
    }));
    return [...msgs, ...segs].slice(0, limit);
  }

  /** Row counts in each FTS index — used to verify deletion really removes indexed data. */
  ftsCounts() {
    const n = (t: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}_docsize`).get() as Row).n);
    return { messages: n("messages_fts"), segments: n("segments_fts"), chunks: n("chunks_fts") };
  }

  // ---- retention, export, deletion ----
  applyRetention(conversationDays: number, transcriptDays: number, now = Date.now()): { conversations: number; transcripts: number; context: number } {
    let conversations = 0;
    let transcripts = 0;
    if (conversationDays > 0) {
      conversations = Number(this.db.prepare("DELETE FROM conversations WHERE updated_at < ?").run(now - conversationDays * 86_400_000).changes);
    }
    if (transcriptDays > 0) {
      transcripts = Number(this.db.prepare("DELETE FROM transcript_sessions WHERE COALESCE(ended_at, started_at) < ?").run(now - transcriptDays * 86_400_000).changes);
    }
    const context = this.deleteExpiredContext(now);
    if (conversations || transcripts || context) this.purgeDeleted();
    return { conversations, transcripts, context };
  }

  counts() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      sessions: n("SELECT COUNT(*) AS n FROM sessions"),
      conversations: n("SELECT COUNT(*) AS n FROM conversations"),
      messages: n("SELECT COUNT(*) AS n FROM messages"),
      transcripts: n("SELECT COUNT(*) AS n FROM transcript_sessions"),
      knowledgeDocs: n("SELECT COUNT(*) AS n FROM knowledge_docs"),
      contextItems: n("SELECT COUNT(*) AS n FROM context_items"),
      memories: n("SELECT COUNT(*) AS n FROM memories"),
    };
  }

  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: this.schemaVersion(),
      sessions: this.listSessions().map((s) => this.exportSession(s.id)),
      globalKnowledge: this.listKnowledgeDocs(null).map((d) => ({ ...d, chunks: this.docChunks(d.id) })),
    };
  }

  deleteAll() {
    this.db.exec(
      "BEGIN; DELETE FROM sessions; DELETE FROM conversations; DELETE FROM transcript_sessions; DELETE FROM knowledge_docs; DELETE FROM meeting_insights; DELETE FROM context_items; DELETE FROM memories; DELETE FROM chunk_embeddings; DELETE FROM feedback; DELETE FROM quality_events; DELETE FROM user_eval_cases; DELETE FROM beta_reports; DELETE FROM projects; UPDATE usage_ledger SET session_id = NULL, category = NULL; COMMIT;",
    );
    this.purgeDeleted();
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}

function toSession(r: Row): Session {
  return {
    id: String(r.id),
    title: String(r.title),
    type: String(r.type) as AssistantMode,
    notes: String(r.notes ?? ""),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    contextTtlMinutes: r.context_ttl_minutes == null ? null : Number(r.context_ttl_minutes),
    ai: safeJson<SessionAiConfig>(String(r.ai ?? "{}"), {}),
  };
}

function toDoc(r: Row): KnowledgeDoc {
  return {
    id: String(r.id),
    title: String(r.title),
    source: String(r.source),
    sessionId: r.session_id == null ? null : String(r.session_id),
    format: String(r.format ?? "text"),
    chars: Number(r.chars),
    chunkCount: Number(r.n ?? 0),
    createdAt: Number(r.created_at),
  };
}

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
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

export interface UsageExtra {
  provider: string | null;
  sessionId: string | null;
  category: string | null;
  cacheReadTokens: number;
  /** list_price: bundled price list; user_price: price the user entered; none: no price (cost recorded as 0, not free). */
  costBasis: "list_price" | "user_price" | "local" | "none";
  /** reported: token counts from the provider; estimated: counted by Lumen. */
  usageBasis: "reported" | "estimated";
  outcome: "ok" | "error" | "cancelled";
  retries: number;
  latencyMs: number | null;
}

export type MemoryKind = "preference" | "convention" | "architecture" | "decision" | "known_issue" | "task";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

function toMemory(r: Row): MemoryItem {
  return {
    id: String(r.id),
    kind: String(r.kind) as MemoryKind,
    text: String(r.text),
    sessionId: r.session_id == null ? null : String(r.session_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
  };
}
