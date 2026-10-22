import { z } from "zod";
import type { MeetingInsights, Settings, TranscriptSegment } from "../shared/types";
import { redact } from "./context/sensitivity";
import { activeModel } from "../shared/defaults";
import { BASE_SYSTEM_PROMPT } from "./context/promptBuilder";
import { escapeForEnvelope } from "./context/injection";
import { ProviderError, type AIProvider } from "./providers/types";
import type { Store } from "./storage/db";
import { segmentsToText } from "./transcription/session";

const strList = z.array(z.string());
/**
 * The summary is mandatory; list sections default to empty. Providers that cannot enforce a JSON
 * schema (custom endpoints) may omit sections, which must not discard an otherwise valid note.
 */
const insightsSchema = z.object({
  summary: z.string().min(1),
  keyPoints: strList.default([]),
  discussionPoints: strList.default([]),
  questionsAsked: z.array(z.object({ question: z.string(), askedBy: z.string().nullable().default(null), answerSummary: z.string().nullable().default(null) })).default([]),
  topics: strList.default([]),
  decisions: strList.default([]),
  actionItems: z.array(z.object({ task: z.string(), owner: z.string().nullable().default(null) })).default([]),
  unansweredQuestions: strList.default([]),
  followUpPrep: strList.default([]),
  conceptsToRevisit: strList.default([]),
  questionsToAsk: strList.default([]),
  suggestedResponses: strList.default([]),
  followUpEmail: z.object({ subject: z.string(), body: z.string() }).default({ subject: "", body: "" }),
});

const arr = { type: "array", items: { type: "string" } };
/** JSON Schema for structured outputs (kept in sync with insightsSchema above). */
export const INSIGHTS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(insightsSchema.shape),
  properties: {
    summary: { type: "string" },
    keyPoints: arr,
    discussionPoints: arr,
    questionsAsked: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "askedBy", "answerSummary"],
        properties: { question: { type: "string" }, askedBy: { type: ["string", "null"] }, answerSummary: { type: ["string", "null"] } },
      },
    },
    topics: arr,
    decisions: arr,
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner"],
        properties: { task: { type: "string" }, owner: { type: ["string", "null"] } },
      },
    },
    unansweredQuestions: arr,
    followUpPrep: arr,
    conceptsToRevisit: arr,
    questionsToAsk: arr,
    suggestedResponses: arr,
    followUpEmail: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: { type: "string" }, body: { type: "string" } },
    },
  },
};

const INSIGHTS_INSTRUCTIONS = `Analyse the transcript in <context> and produce structured notes.
- summary: executive summary, 3–6 sentences, only what was actually said.
- keyPoints: the most important facts and conclusions.
- discussionPoints: main discussion threads, in order.
- questionsAsked: questions that were asked (interviews: every interviewer question). askedBy is the speaker label exactly as it appears in the transcript ONLY when the line is clearly attributed; otherwise null. answerSummary is a one-line summary of the answer given, or null if none.
- topics: short topic names.
- decisions: decisions that were explicitly made.
- actionItems: commitments that were made; owner is a speaker label or name only if explicitly stated, otherwise null.
- unansweredQuestions: questions raised but not answered.
- followUpPrep: what the user should prepare before a follow-up (suggestions).
- conceptsToRevisit: technical concepts or terms worth studying afterwards.
- questionsToAsk: useful questions the user could ask next (suggestions, not things that were said).
- suggestedResponses: 2–3 short things the user could say next.
- followUpEmail: a concise follow-up email draft.
Speaker labels like "Speaker 1" come from automatic diarization and may be wrong: never turn them into names, and never attribute a statement to a person unless the transcript says so. Never invent statements, names, numbers, decisions or commitments. If the transcript is too short to support a field, return an empty list.`;

/**
 * Generate structured meeting notes. Segments come from the store, or — for transcripts that are
 * kept in memory only — are passed in directly; in that case the insights are not persisted.
 */
export async function generateInsights(
  provider: AIProvider,
  store: Store,
  settings: Settings,
  transcriptId: string,
  signal: AbortSignal,
  opts: { segments?: TranscriptSegment[]; model?: string; redactSensitive?: boolean } = {},
): Promise<MeetingInsights> {
  const segments = opts.segments ?? store.listSegments(transcriptId);
  if (!segments.length) throw new ProviderError("The transcript is empty — record something first.", "bad_request", false);
  let transcript = segmentsToText(segments).slice(-150_000);
  if (opts.redactSensitive ?? settings.privacy.redactSensitive) transcript = redact(transcript);
  const res = await provider.generate(
    {
      model: activeModel(settings.provider, opts.model),
      system: [
        { text: BASE_SYSTEM_PROMPT, cache: true },
        { text: INSIGHTS_INSTRUCTIONS, cache: false },
      ],
      messages: [
        {
          role: "user",
          content: `<context>\n<source label="C1" kind="meeting transcript" title="Transcript">\n${escapeForEnvelope(transcript)}\n</source>\n</context>\n\n<question>\nProduce the meeting notes.\n</question>`,
        },
      ],
      maxTokens: 16000,
      effort: settings.provider.effort,
      timeoutMs: Math.max(settings.provider.timeoutMs, 120_000),
      idleTimeoutMs: settings.provider.idleTimeoutMs,
      jsonSchema: INSIGHTS_JSON_SCHEMA,
    },
    signal,
  );
  let parsed: z.infer<typeof insightsSchema>;
  try {
    parsed = insightsSchema.parse(JSON.parse(extractJson(res.text)));
  } catch {
    throw new ProviderError("The AI returned meeting notes in an unexpected format. Try again.", "unknown", true);
  }
  const insights: MeetingInsights = { sessionId: transcriptId, generatedAt: Date.now(), model: res.model, isMock: provider.isMock, ...parsed, edited: false };
  if (!opts.segments) store.saveInsights(transcriptId, insights);
  return insights;
}

/** Tolerate providers that wrap JSON in a code fence. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

const list = (title: string, items: string[] | undefined) => (items?.length ? `## ${title}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");

/** Markdown export of notes + (optionally) the transcript. Speaker labels are kept as recorded. */
export function notesToMarkdown(
  meta: { title: string; startedAt: number; endedAt: number | null; sessionTitle?: string },
  insights: MeetingInsights | null,
  segments: TranscriptSegment[],
  opts: { includeTranscript: boolean } = { includeTranscript: true },
): string {
  const when = new Date(meta.startedAt).toLocaleString();
  const dur = meta.endedAt ? ` · ${Math.max(1, Math.round((meta.endedAt - meta.startedAt) / 60000))} min` : "";
  const out = [`# ${meta.title}`, "", `_${meta.sessionTitle ? `${meta.sessionTitle} · ` : ""}${when}${dur}_`, ""];
  if (insights) {
    out.push(
      `## Summary\n${insights.summary}\n`,
      list("Main discussion points", insights.discussionPoints ?? insights.keyPoints),
      insights.questionsAsked?.length
        ? `## Questions asked\n${insights.questionsAsked.map((q) => `- ${q.question}${q.askedBy ? ` _(${q.askedBy})_` : ""}${q.answerSummary ? `\n  - Answer: ${q.answerSummary}` : ""}`).join("\n")}\n`
        : "",
      list("Topics", insights.topics),
      list("Decisions", insights.decisions),
      insights.actionItems.length ? `## Action items\n${insights.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` — ${a.owner}` : ""}`).join("\n")}\n` : "",
      list("Unanswered questions", insights.unansweredQuestions),
      list("Follow-up preparation", insights.followUpPrep),
      list("Concepts to revisit", insights.conceptsToRevisit),
      `## Follow-up email (draft)\n**Subject:** ${insights.followUpEmail.subject}\n\n${insights.followUpEmail.body}\n`,
      `_Notes generated by ${insights.isMock ? "development mode (not AI)" : insights.model}${insights.edited ? ", edited by you" : ""}. Speaker labels come from automatic diarization and may be inaccurate._\n`,
    );
  }
  if (opts.includeTranscript && segments.length) out.push("## Transcript", "", segmentsToText(segments), "");
  return out.filter((x) => x !== "").join("\n");
}
