import { randomUUID } from "node:crypto";
import type { ContextItemSummary, ContextPermission, ContextReference, ContextSource, Sensitivity, SourceAvailability } from "../../shared/types";
import type { PersistedContextItem, Store } from "../storage/db";
import { looksLikeInjection } from "./injection";
import { classify, redact } from "./sensitivity";
import { contentHash, normalizeText, truncate } from "./text";
import { rankCandidates, type Candidate, type Ranked } from "./ranker";

/** The normalized representation of every piece of context Lumen knows about. */
export interface ContextRecord {
  id: string;
  sessionId: string;
  source: ContextSource;
  /** Stable identifier of the origin (file path, capture id, transcript id, message id…). */
  sourceId: string;
  title: string;
  text: string;
  createdAt: number;
  /** null = never expires (until removed or the session is deleted). */
  expiresAt: number | null;
  pinned: boolean;
  enabled: boolean;
  status: "pending" | "active";
  permission: ContextPermission;
  /** 0–1 reliability of the text (e.g. OCR confidence). null = not applicable (user-typed). */
  confidence: number | null;
  sensitivity: Sensitivity;
  sensitiveKinds: string[];
  suspicious: boolean;
  hash: string;
  image?: { mediaType: "image/png" | "image/jpeg"; data: string };
  thumbnailDataUrl?: string;
  ocr: "none" | "running" | "done" | "failed";
  warning: string | null;
}

export interface IngestInput {
  sessionId: string;
  source: ContextSource;
  sourceId?: string;
  title: string;
  text: string;
  permission?: ContextPermission;
  confidence?: number | null;
  image?: ContextRecord["image"];
  thumbnailDataUrl?: string;
  pinned?: boolean;
  /** Requires user confirmation before it can be used. */
  pending?: boolean;
  /** Overrides the default TTL for this source. 0 = never expires. */
  ttlMinutes?: number;
  ocr?: ContextRecord["ocr"];
}

export interface EngineConfig {
  /** TTL for screen-derived context in minutes. */
  screenTtlMinutes: number;
  /** Per-session override (null = use defaults; 0 = never expire). */
  sessionTtlMinutes: (sessionId: string) => number | null;
  /** Whether each permission is currently granted by the user. */
  isPermitted: (p: ContextPermission) => boolean;
  redactSensitive: boolean;
}

/** Sources that are written to disk (text only). Screen-derived items stay in memory. */
const PERSISTED: ReadonlySet<ContextSource> = new Set(["note", "document", "clipboard", "selected_text"]);
const SCREEN: ReadonlySet<ContextSource> = new Set(["screenshot", "ocr"]);
const MAX_TEXT_CHARS = 200_000;
const MAX_ITEMS_PER_SESSION = 60;

export interface PreparedContext {
  ranked: Ranked[];
  availability: SourceAvailability;
  prepMs: number;
  /** Candidates looked at, before the relevance cut. */
  considered: number;
}

/**
 * Centralized, session-scoped context engine.
 *
 * Every authorized source is ingested through `ingest()`, which normalizes, classifies, timestamps
 * and deduplicates it. `prepare()` gathers candidates for one question — strictly from one session —
 * ranks them, and applies redaction. Expiry is enforced on read and by `sweep()`.
 */
export class ContextEngine {
  private items = new Map<string, ContextRecord>();
  private listeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly store: Store | null,
    private config: EngineConfig,
    private readonly now: () => number = Date.now,
  ) {
    if (store) for (const p of store.listContextItems()) this.items.set(p.id, this.fromPersisted(p));
  }

  configure(patch: Partial<EngineConfig>) {
    this.config = { ...this.config, ...patch };
  }

  onChange(fn: (sessionId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(sessionId: string) {
    for (const l of this.listeners) l(sessionId);
  }

  private ttlFor(source: ContextSource, sessionId: string, override?: number): number | null {
    if (override !== undefined) return override === 0 ? null : override;
    const session = this.config.sessionTtlMinutes(sessionId);
    if (SCREEN.has(source)) {
      // Screen context always expires; a session may shorten it but "never" falls back to the app default.
      return session && session > 0 ? Math.min(session, this.config.screenTtlMinutes) : this.config.screenTtlMinutes;
    }
    if (session === null || session === 0) return null;
    return session;
  }

  ingest(input: IngestInput): ContextRecord {
    const permission = input.permission ?? (SCREEN.has(input.source) ? "screen" : "user");
    if (!this.config.isPermitted(permission)) throw new Error(`Permission for ${permission} context is not granted.`);
    const text = truncate(normalizeText(input.text), MAX_TEXT_CHARS);
    if (!text && !input.image) throw new Error("Nothing to add — the content is empty.");
    const hash = input.image ? contentHash(input.image.data) : contentHash(`${input.source}:${text.toLowerCase()}`);
    const now = this.now();
    const ttl = this.ttlFor(input.source, input.sessionId, input.ttlMinutes);

    // Dedupe within the session: refresh the existing record instead of adding a copy.
    for (const existing of this.items.values()) {
      if (existing.sessionId === input.sessionId && existing.hash === hash && !this.isExpired(existing)) {
        existing.createdAt = now;
        existing.expiresAt = ttl ? now + ttl * 60_000 : null;
        existing.enabled = true;
        this.persist(existing);
        this.emit(existing.sessionId);
        return existing;
      }
    }

    const cls = classify(text);
    const rec: ContextRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      source: input.source,
      sourceId: input.sourceId ?? hash.slice(0, 16),
      title: truncate(normalizeText(input.title) || input.source, 120),
      text,
      createdAt: now,
      expiresAt: ttl ? now + ttl * 60_000 : null,
      pinned: input.pinned ?? false,
      enabled: true,
      status: input.pending ? "pending" : "active",
      permission,
      confidence: input.confidence ?? null,
      sensitivity: cls.sensitivity,
      sensitiveKinds: cls.kinds,
      suspicious: looksLikeInjection(text),
      hash,
      image: input.image,
      thumbnailDataUrl: input.thumbnailDataUrl,
      ocr: input.ocr ?? "none",
      warning: null,
    };
    this.items.set(rec.id, rec);
    this.evict(input.sessionId);
    this.persist(rec);
    this.emit(rec.sessionId);
    return rec;
  }

  /** Attach OCR output (or a failure) to a screen capture. */
  setOcr(id: string, result: { text: string; confidence: number } | { error: string }) {
    const rec = this.items.get(id);
    if (!rec) return;
    if ("error" in result) {
      rec.ocr = "failed";
      rec.warning = `Text recognition failed: ${result.error}`;
    } else {
      rec.ocr = "done";
      rec.text = truncate(normalizeText(result.text), MAX_TEXT_CHARS);
      rec.confidence = result.confidence;
      const cls = classify(rec.text);
      rec.sensitivity = cls.sensitivity;
      rec.sensitiveKinds = cls.kinds;
      rec.suspicious = looksLikeInjection(rec.text);
      if (!rec.text) rec.warning = "No text was recognized in this capture.";
      else if (result.confidence < 0.6) rec.warning = `Low OCR confidence (${Math.round(result.confidence * 100)}%) — recognized text may be inaccurate.`;
    }
    this.emit(rec.sessionId);
  }

  setOcrRunning(id: string) {
    const rec = this.items.get(id);
    if (rec) {
      rec.ocr = "running";
      this.emit(rec.sessionId);
    }
  }

  confirm(id: string) {
    const rec = this.items.get(id);
    if (!rec) return;
    rec.status = "active";
    this.emit(rec.sessionId);
  }

  update(id: string, patch: Partial<Pick<ContextRecord, "enabled" | "pinned" | "title">>) {
    const rec = this.items.get(id);
    if (!rec) return;
    if (patch.enabled !== undefined) rec.enabled = patch.enabled;
    if (patch.title !== undefined) rec.title = truncate(patch.title, 120) || rec.title;
    if (patch.pinned !== undefined) {
      rec.pinned = patch.pinned;
      if (patch.pinned) rec.expiresAt = null;
      else {
        const ttl = this.ttlFor(rec.source, rec.sessionId);
        rec.expiresAt = ttl ? this.now() + ttl * 60_000 : null;
      }
    }
    this.persist(rec);
    this.emit(rec.sessionId);
  }

  get(id: string): ContextRecord | undefined {
    const r = this.items.get(id);
    return r && !this.isExpired(r) ? r : undefined;
  }

  remove(id: string) {
    const rec = this.items.get(id);
    if (!rec) return;
    this.items.delete(id);
    this.store?.deleteContextItem(id);
    this.emit(rec.sessionId);
  }

  /** Clear context for a session, optionally only certain sources. */
  clear(sessionId: string, sources?: ContextSource[]) {
    for (const rec of [...this.items.values()]) {
      if (rec.sessionId !== sessionId) continue;
      if (sources && !sources.includes(rec.source)) continue;
      this.items.delete(rec.id);
      this.store?.deleteContextItem(rec.id);
    }
    this.emit(sessionId);
  }

  /** Remove every item gated by a permission that was just revoked (all sessions). */
  revoke(permission: ContextPermission): number {
    const touched = new Set<string>();
    for (const rec of [...this.items.values()]) {
      if (rec.permission !== permission) continue;
      this.items.delete(rec.id);
      this.store?.deleteContextItem(rec.id);
      touched.add(rec.sessionId);
    }
    for (const s of touched) this.emit(s);
    return [...touched].length;
  }

  /** Forget everything held for a session (used when the session is deleted). */
  dropSession(sessionId: string) {
    for (const rec of [...this.items.values()]) if (rec.sessionId === sessionId) this.items.delete(rec.id);
  }

  dropAll() {
    this.items.clear();
  }

  private isExpired(r: ContextRecord): boolean {
    return !r.pinned && r.expiresAt !== null && r.expiresAt <= this.now();
  }

  /** Delete expired items. Returns the number removed. */
  sweep(): number {
    const touched = new Set<string>();
    let n = 0;
    for (const rec of [...this.items.values()]) {
      if (!this.isExpired(rec)) continue;
      this.items.delete(rec.id);
      this.store?.deleteContextItem(rec.id);
      touched.add(rec.sessionId);
      n++;
    }
    for (const s of touched) this.emit(s);
    return n;
  }

  /** Items of one session, newest first, excluding expired ones. */
  list(sessionId: string): ContextRecord[] {
    return [...this.items.values()].filter((r) => r.sessionId === sessionId && !this.isExpired(r)).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Usable items: in this session, enabled, confirmed, not expired, and still permitted. */
  active(sessionId: string): ContextRecord[] {
    return this.list(sessionId).filter((r) => r.enabled && r.status === "active" && this.config.isPermitted(r.permission));
  }

  summaries(sessionId: string): ContextItemSummary[] {
    return this.list(sessionId).map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      source: r.source,
      sourceId: r.sourceId,
      title: r.title,
      chars: r.text.length,
      createdAt: r.createdAt,
      expiresAt: r.pinned ? null : r.expiresAt,
      pinned: r.pinned,
      enabled: r.enabled,
      status: r.status,
      hasImage: !!r.image,
      thumbnailDataUrl: r.thumbnailDataUrl ?? null,
      ocr: r.ocr,
      confidence: r.confidence,
      sensitivity: r.sensitivity,
      sensitiveKinds: r.sensitiveKinds,
      permission: r.permission,
      suspicious: r.suspicious,
      warning: r.warning,
      preview: truncate(r.text.replace(/\s+/g, " "), 160),
    }));
  }

  /**
   * Gather, rank and sanitize the context for one question in one session. Session isolation is
   * enforced here: only records whose sessionId matches are ever considered, and externally
   * supplied candidates (knowledge, history, transcript) must already be scoped by the caller.
   */
  prepare(sessionId: string, question: string, extra: Candidate[], opts: { sendImages: boolean; minScore?: number } = { sendImages: true }): PreparedContext {
    const started = performance.now();
    const own: Candidate[] = this.active(sessionId).map((r) => ({
      id: r.id,
      kind: r.source,
      title: r.title,
      text: r.text,
      createdAt: r.createdAt,
      pinned: r.pinned,
      explicit: true,
      suspicious: r.suspicious,
      confidence: r.confidence,
      image: opts.sendImages ? r.image : undefined,
      sourceId: r.sourceId,
    }));
    // Captures with neither an image to send nor any recognized text carry no information.
    const usable = own.filter((c) => c.image || c.text.trim());
    const minScore = opts.minScore ?? 0.6;
    const ranked = rankCandidates(question, [...usable, ...extra], this.now()).filter((c) => c.explicit || c.pinned || c.score > minScore);
    const sanitized = this.config.redactSensitive ? ranked.map((r) => ({ ...r, text: redact(r.text), title: redact(r.title) })) : ranked;
    const count = (pred: (c: Ranked) => boolean) => sanitized.filter(pred).length;
    const availability: SourceAvailability = {
      transcript: sanitized.some((c) => c.kind === "transcript") ? "live" : "none",
      screen: count((c) => c.kind === "screenshot" || c.kind === "ocr"),
      documents: count((c) => c.kind === "document"),
      notes: count((c) => c.kind === "note" || c.kind === "clipboard" || c.kind === "selected_text"),
      knowledge: count((c) => c.kind === "knowledge"),
      history: count((c) => c.kind === "history"),
      memory: count((c) => c.kind === "memory"),
    };
    return { ranked: sanitized, availability, prepMs: Math.round((performance.now() - started) * 10) / 10, considered: usable.length + extra.length };
  }

  /** Keep each session bounded: evict the oldest unpinned items beyond the cap. */
  private evict(sessionId: string) {
    const own = this.list(sessionId).filter((r) => !r.pinned);
    const total = this.list(sessionId).length;
    let over = total - MAX_ITEMS_PER_SESSION;
    for (let i = own.length - 1; i >= 0 && over > 0; i--, over--) {
      this.items.delete(own[i]!.id);
      this.store?.deleteContextItem(own[i]!.id);
    }
  }

  private persist(rec: ContextRecord) {
    if (!this.store || !PERSISTED.has(rec.source) || rec.status !== "active") return;
    this.store.saveContextItem({
      id: rec.id,
      sessionId: rec.sessionId,
      source: rec.source,
      sourceId: rec.sourceId,
      title: rec.title,
      text: rec.text,
      createdAt: rec.createdAt,
      expiresAt: rec.pinned ? null : rec.expiresAt,
      pinned: rec.pinned,
      enabled: rec.enabled,
      hash: rec.hash,
    });
  }

  private fromPersisted(p: PersistedContextItem): ContextRecord {
    const cls = classify(p.text);
    return {
      ...p,
      status: "active",
      permission: "user",
      confidence: null,
      sensitivity: cls.sensitivity,
      sensitiveKinds: cls.kinds,
      suspicious: looksLikeInjection(p.text),
      ocr: "none",
      warning: null,
    };
  }
}

/** Which labels an answer actually cited, e.g. "[C1]" or "[C1, C3]". */
export function citedLabels(text: string, refs: ContextReference[]): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\[(C\d+(?:\s*,\s*C\d+)*)\]/g)) for (const l of m[1]!.split(/\s*,\s*/)) found.add(l);
  return refs.map((r) => r.label).filter((l) => found.has(l));
}
