import { z } from "zod";
import type { MeetingInsights, Settings, TranscriptSegment } from "../shared/types";
import { redact } from "./context/sensitivity";
import { BASE_SYSTEM_PROMPT } from "./context/promptBuilder";
import { escapeForEnvelope } from "./context/injection";
import { ProviderError, type AIProvider } from "./providers/types";
import type { Store } from "./storage/db";
import { segmentsToText } from "./transcription/session";

const insightsSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  actionItems: z.array(z.object({ task: z.string(), owner: z.string().nullable() })),
  questionsToAsk: z.array(z.string()),
  suggestedResponses: z.array(z.string()),
  followUpEmail: z.object({ subject: z.string(), body: z.string() }),
});

/** JSON Schema for structured outputs (kept in sync with insightsSchema above). */
export const INSIGHTS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "keyPoints", "actionItems", "questionsToAsk", "suggestedResponses", "followUpEmail"],
  properties: {
    summary: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner"],
        properties: { task: { type: "string" }, owner: { type: ["string", "null"] } },
      },
    },
    questionsToAsk: { type: "array", items: { type: "string" } },
    suggestedResponses: { type: "array", items: { type: "string" } },
    followUpEmail: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: { type: "string" }, body: { type: "string" } },
    },
  },
};

const INSIGHTS_INSTRUCTIONS = `Analyse the meeting transcript in <context> and produce structured meeting notes.
- summary: 3–6 sentences, only what was actually said.
- keyPoints: decisions and important facts, each traceable to the transcript.
- actionItems: commitments made in the transcript; owner is the speaker label or name only if stated, otherwise null.
- questionsToAsk: useful clarifying questions the user could ask next (these are suggestions, not things that were said).
- suggestedResponses: 2–3 short things the user could say next, grounded in the conversation.
- followUpEmail: a concise follow-up email draft.
Never invent statements, names, numbers or commitments that are not in the transcript. If the transcript is too short to support a field, return an empty list or say so in the summary.`;

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
      model: provider.kind === "openai_compat" ? settings.provider.openaiCompat.model : (opts.model ?? settings.provider.model),
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
  const insights: MeetingInsights = { sessionId: transcriptId, generatedAt: Date.now(), model: res.model, isMock: provider.isMock, ...parsed };
  if (!opts.segments) store.saveInsights(transcriptId, insights);
  return insights;
}

/** Tolerate providers that wrap JSON in a code fence. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}
