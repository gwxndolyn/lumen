import { randomUUID } from "node:crypto";
import type { ContextItemSummary, ContextKind } from "../../shared/types";
import { looksLikeInjection } from "./injection";
import type { Candidate } from "./ranker";
import { contentHash, normalizeText, truncate } from "./text";

export interface SessionContextItem extends Candidate {
  enabled: boolean;
  pinned: boolean;
  hash: string;
}

const MAX_ITEMS = 40;
const MAX_TEXT_CHARS = 200_000;
/** Unpinned screenshots expire: screen context is ephemeral by design. */
export const SCREENSHOT_TTL_MS = 15 * 60_000;

/**
 * In-memory, session-scoped context the user has explicitly attached (notes, clipboard text,
 * documents, screenshots). Nothing here is written to disk; quitting the app clears it.
 */
export class ContextStore {
  private items: SessionContextItem[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  add(input: {
    kind: ContextKind;
    title: string;
    text: string;
    image?: Candidate["image"];
    pinned?: boolean;
  }): SessionContextItem {
    const text = truncate(normalizeText(input.text), MAX_TEXT_CHARS);
    if (!text && !input.image) throw new Error("Nothing to add — the content is empty.");
    const hash = input.image ? contentHash(input.image.data) : contentHash(`${input.kind}:${text}`);
    const dup = this.items.find((i) => i.hash === hash);
    if (dup) {
      dup.createdAt = this.now();
      dup.enabled = true;
      this.emit();
      return dup;
    }
    const item: SessionContextItem = {
      id: randomUUID(),
      kind: input.kind,
      title: truncate(normalizeText(input.title) || input.kind, 120),
      text,
      image: input.image,
      createdAt: this.now(),
      pinned: input.pinned ?? false,
      enabled: true,
      explicit: true,
      hash,
      suspicious: looksLikeInjection(text),
    };
    this.items.unshift(item);
    // Evict oldest unpinned items beyond the cap.
    while (this.items.length > MAX_ITEMS) {
      const idx = this.items.findLastIndex((i) => !i.pinned);
      if (idx < 0) break;
      this.items.splice(idx, 1);
    }
    this.emit();
    return item;
  }

  update(id: string, patch: Partial<Pick<SessionContextItem, "enabled" | "pinned">>) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.pinned !== undefined) item.pinned = patch.pinned;
    this.emit();
  }

  remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  clear(kind?: ContextKind) {
    this.items = kind ? this.items.filter((i) => i.kind !== kind) : [];
    this.emit();
  }

  /** Drop stale screenshots. Returns number removed. */
  expire(): number {
    const cutoff = this.now() - SCREENSHOT_TTL_MS;
    const before = this.items.length;
    this.items = this.items.filter((i) => i.pinned || i.kind !== "screenshot" || i.createdAt >= cutoff);
    const removed = before - this.items.length;
    if (removed) this.emit();
    return removed;
  }

  active(): SessionContextItem[] {
    this.expire();
    return this.items.filter((i) => i.enabled);
  }

  get(id: string) {
    return this.items.find((i) => i.id === id);
  }

  summaries(): ContextItemSummary[] {
    return this.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      chars: i.text.length,
      createdAt: i.createdAt,
      pinned: i.pinned,
      enabled: i.enabled,
      hasImage: !!i.image,
      suspicious: !!i.suspicious,
      preview: truncate(i.text.replace(/\s+/g, " "), 160),
    }));
  }
}
