// Human-readable exports. JSON stays available for full-fidelity backups; Markdown and plain text
// are for reading and sharing. Screenshots are never included (only their extracted text, if any).

import type { ChatMessage, Conversation, MeetingInsights, Session, TranscriptSegment, TranscriptSession } from "../shared/types";
import { notesToMarkdown } from "./meetingService";

export type ExportFormat = "json" | "md" | "txt";

export interface SessionExport {
  session: Session;
  conversations: (Conversation & { messages: ChatMessage[] })[];
  transcripts: (TranscriptSession & { segments: TranscriptSegment[]; insights: unknown })[];
}

export function formatFromPath(file: string): ExportFormat {
  const ext = file.toLowerCase().split(".").pop();
  return ext === "md" || ext === "markdown" ? "md" : ext === "txt" ? "txt" : "json";
}

export function sessionToMarkdown(data: SessionExport): string {
  const s = data.session;
  const out = [`# ${s.title}`, "", `_Lumen session · created ${new Date(s.createdAt).toLocaleString()}_`, ""];
  if (s.notes.trim()) out.push("## Notes", "", s.notes.trim(), "");
  for (const c of data.conversations) {
    if (!c.messages.length) continue;
    out.push(`## ${c.title || "Conversation"}`, `_${new Date(c.createdAt).toLocaleString()}_`, "");
    for (const m of c.messages) {
      out.push(`**${m.role === "user" ? "You" : `Lumen${m.meta?.model ? ` (${m.meta.model})` : ""}`}:**`, "", m.content.trim(), "");
    }
  }
  for (const t of data.transcripts) {
    out.push(notesToMarkdown({ title: t.title, startedAt: t.startedAt, endedAt: t.endedAt }, (t.insights as MeetingInsights | null) ?? null, t.segments).replace(/^# /, "## "), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Plain text from our own Markdown output: drops emphasis markers, keeps structure and code. */
export function markdownToText(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`    ${line}`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const title = h[2]!.trim();
      out.push(title, (h[1]!.length === 1 ? "=" : "-").repeat(Math.min(title.length, 72)));
      continue;
    }
    out.push(
      line
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
        .replace(/^- \[ \] /, "- "),
    );
  }
  return out.join("\n");
}
