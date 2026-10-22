// Phase 5 end-to-end workflows through AppCore with the real SDK against the fake HTTP backend.
import { describe, expect, it } from "vitest";
import { notesToMarkdown } from "../core/meetingService";
import type { AIProvider } from "../core/providers/types";
import type { ChatEvent, MeetingInsights } from "../shared/types";
import { FakeOcr, harness } from "./harness";
import { sentText } from "./helpers";

const systemOf = (body: Record<string, unknown>) => JSON.stringify(body.system);

describe("A. Interview: question → profile context → personalized suggestion", () => {
  it("detects an interviewer question in the live transcript and answers it grounded in the profile", async () => {
    const h = harness({ turns: [{ text: ["**Opening:** At Northwind I led the migration [C1]."] }] });
    h.core.createSession({ title: "Acme interview", type: "interview" });
    h.core.saveProfileSection("experience", "Senior engineer at Northwind (2021–2024). Led the migration of the billing system from a monolith to services; cut deploy time from 2 hours to 15 minutes.");
    h.core.saveProfileSection("skills", "Kotlin, Go, PostgreSQL, Kafka.");
    const live = h.core.startTranscript("Interview");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("Thanks for joining.", true, 0, 0);
    ws.result("Tell me about a time you led a difficult migration project?", true, 2, 0);
    // Debounce has not elapsed: nothing yet.
    expect(h.core.pollQuestions()).toBeNull();
    const q = h.core.pollQuestions(true)!;
    expect(q.text).toBe("Tell me about a time you led a difficult migration project?");
    expect(q.category).toBe("behavioral");
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && !h.chat.some((e) => e.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
    const suggestion = h.chat.find((e) => e.type === "suggestion") as Extract<ChatEvent, { type: "suggestion" }>;
    expect(suggestion.question.categoryLabel).toBe("Behavioral");
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("Led the migration of the billing system"); // profile retrieved
    expect(sent).toContain("Tell me about a time you led a difficult migration project?"); // transcript context
    expect(sent).toMatch(/Never invent employers, projects, dates, metrics/);
    expect(systemOf(h.calls[0]!.body)).toContain("interview answer suggestion");
    // Stored as the question the user saw, tagged as an interview suggestion.
    const start = h.chat.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;
    const userMsg = h.store.listMessages(start.conversationId)[0]!;
    expect(userMsg.content).toBe("Tell me about a time you led a difficult migration project?");
    expect(userMsg.meta.origin).toMatchObject({ kind: "interview", label: "Behavioral" });
    expect(live.status).toBe("recording");
  });

  it("does not generate for statements or repeated questions, and a newer question cancels the older answer", async () => {
    const h = harness({ turns: [{ text: Array.from({ length: 40 }, () => "w "), delayMs: 5 }, { text: ["second"] }] });
    h.core.createSession({ title: "I", type: "interview" });
    h.core.startTranscript("x");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("I'll share the agenda after this call.", true, 0, 0);
    expect(h.core.pollQuestions(true)).toBeNull();
    ws.result("How would you design a URL shortener?", true, 5, 0);
    h.core.pollQuestions(true);
    await new Promise((r) => setTimeout(r, 30));
    ws.result("So how would you design a URL shortener?", true, 9, 0); // rephrase → suppressed
    expect(h.core.pollQuestions(true)).toBeNull();
    ws.result("What is the difference between a process and a thread?", true, 20, 0);
    h.core.pollQuestions(true);
    for (let i = 0; i < 200 && h.chat.filter((e) => e.type === "done" || e.type === "cancelled").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const terminals = h.chat.filter((e) => e.type === "done" || e.type === "cancelled").map((e) => e.type);
    expect(terminals).toEqual(["cancelled", "done"]);
    expect(h.chat.filter((e) => e.type === "suggestion")).toHaveLength(2);
  });

  it("flags missing experience instead of inventing it when the profile is empty", async () => {
    const h = harness({ turns: [{ text: ["No matching example in your profile."] }] });
    h.core.createSession({ title: "I", type: "interview" });
    await h.core.sendInterview({ requestId: "q1", conversationId: null, question: "Tell me about your biggest accomplishment", length: "short" });
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("No matching example in your profile");
    expect(sent).toContain("(no context sources are active)");
  });

  it("interview auto-suggest is off outside interview sessions", () => {
    const h = harness();
    h.core.startTranscript("standup");
    h.sockets[0]!.open();
    h.sockets[0]!.result("What did you work on yesterday?", true, 0, 0);
    expect(h.core.pollQuestions(true)).toBeNull();
  });
});

describe("B. Technical: problem → requirements → approach → code → complexity", () => {
  const PROBLEM = "Two Sum\nGiven an array of integers nums and an integer target, return indices of the two numbers that add up to target.\n\nExample 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\n\nConstraints:\n2 <= nums.length <= 10^4";

  it("structures the problem as pinned session context and asks for the full analysis in the chosen language", async () => {
    const h = harness({ turns: [{ text: ["1. **Understanding**…\n```java\nclass Solution {}\n```"] }, { text: ["follow-up"] }] });
    h.core.createSession({ title: "Practice", type: "coding" });
    await h.core.sendTechnical({ requestId: "t1", conversationId: null, text: "", task: "solve", language: "java", problem: PROBLEM });
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]");
    expect(sent).toContain("- 2 <= nums.length <= 10^4");
    expect(sent).toMatch(/Language: Java .*```java/);
    expect(sent).toMatch(/Java 17/);
    expect(sent).toMatch(/\*\*Complexity\*\*/);
    expect(sent).toMatch(/Inference from constraints/);
    // Follow-up in the same session reuses the stored problem without re-pasting.
    const start = h.chat.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;
    await h.ask("Can you do it in one pass?", { conversationId: start.conversationId });
    expect(sentText(h.calls[1]!.body)).toContain("Two Sum");
    expect(((h.calls[1]!.body as { messages: unknown[] }).messages).length).toBe(3);
  });

  it("combines a screenshot of the problem with a spoken clarification", async () => {
    const h = harness({ ocr: new FakeOcr("Longest Substring\nGiven a string s, find the length of the longest substring without repeating characters.\nExample 1:\nInput: s = \"abcabcbb\"\nOutput: 3", 0.93), turns: [{ text: ["ok"] }] });
    h.core.createSession({ title: "Live coding", type: "coding" });
    await h.capture("Problem").ocr;
    const parsed = h.core.analyzeProblem("");
    expect(parsed.title).toBe("Longest Substring");
    expect(parsed.missing).toContain("the constraints (input sizes / value ranges)");
    h.core.startTranscript("call");
    h.sockets[0]!.open();
    h.sockets[0]!.result("You can assume the string is only lowercase ASCII and up to ten thousand characters.", true, 0, 0);
    await h.core.sendTechnical({ requestId: "t2", conversationId: null, text: "", task: "solve", language: "python", includeLiveTranscript: true });
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("longest substring without repeating characters"); // OCR (observed)
    expect(sent).toContain("only lowercase ASCII and up to ten thousand"); // spoken clarification
    expect(sent).toMatch(/missing: the constraints/); // still flagged so the model labels assumptions
  });

  it("asks for missing content when the capture is cut off", async () => {
    const h = harness({ turns: [{ text: ["I need the rest."] }] });
    h.core.createSession({ title: "c", type: "coding" });
    await h.core.sendTechnical({ requestId: "t3", conversationId: null, text: "", task: "solve", language: "python", problem: "Given an array of integers, return the" });
    expect(sentText(h.calls[0]!.body)).toMatch(/appears to be cut off/);
  });

  it("practice (hints) mode withholds the solution", async () => {
    const h = harness({ turns: [{ text: ["Hint 1"] }] });
    await h.core.sendTechnical({ requestId: "t4", conversationId: null, text: "", task: "hints", language: "python", problem: PROBLEM });
    expect(sentText(h.calls[0]!.body)).toMatch(/do NOT give the solution or code/);
  });
});

describe("C. Notetaker: conversation → transcript → structured notes → search & export", () => {
  it("generates all note sections, keeps uncertain speakers unattributed, supports edits, search and Markdown export", async () => {
    const notes = {
      summary: "The team agreed to ship v2 on Friday.",
      keyPoints: ["Ship v2 Friday"],
      discussionPoints: ["Release timing", "QA capacity"],
      questionsAsked: [{ question: "Can QA finish by Thursday?", askedBy: null, answerSummary: "Yes, if scope is frozen." }],
      topics: ["Release", "QA"],
      decisions: ["Freeze scope today"],
      actionItems: [{ task: "Freeze scope", owner: null }],
      unansweredQuestions: ["Who owns the release notes?"],
      followUpPrep: ["Draft release notes"],
      conceptsToRevisit: ["Canary deploys"],
      questionsToAsk: ["What's the rollback plan?"],
      suggestedResponses: ["I'll take the release notes."],
      followUpEmail: { subject: "v2 release", body: "Hi all, …" },
    };
    let schema: unknown;
    const fake: AIProvider = {
      kind: "anthropic",
      isMock: false,
      supportsImages: true,
      test: async () => ({ ok: true, message: "", latencyMs: 0 }),
      generate: async (req) => {
        schema = req.jsonSchema;
        expect(JSON.stringify(req.system)).toMatch(/never attribute a statement to a person unless the transcript says so/);
        return { text: JSON.stringify(notes), model: "claude-opus-5-5", stopReason: "end_turn", servedByFallback: null, ttftMs: 1, retries: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const h = harness();
    (h.core as unknown as { deps: { providerFactory: () => AIProvider } }).deps.providerFactory = () => fake;
    h.core.createSession({ title: "Release sync", type: "meeting" });
    const live = h.core.startTranscript("Release sync");
    h.sockets[0]!.open();
    h.sockets[0]!.result("Can QA finish by Thursday?", true, 0, 0);
    h.sockets[0]!.result("Yes, if we freeze scope today.", true, 3, 1);
    h.core.stopTranscript();
    const insights = await h.core.generateInsights(live.id, new AbortController().signal);
    expect((schema as { required: string[] }).required).toEqual(expect.arrayContaining(["discussionPoints", "questionsAsked", "decisions", "unansweredQuestions", "conceptsToRevisit"]));
    expect(insights.questionsAsked![0]!.askedBy).toBeNull();

    const edited = h.core.updateNotes(live.id, { summary: "Ship v2 Friday; scope frozen today." });
    expect(edited.edited).toBe(true);
    expect(h.store.getInsights<MeetingInsights>(live.id)!.summary).toBe("Ship v2 Friday; scope frozen today.");

    expect(h.store.search("freeze scope", h.core.activeSessionId).some((x) => x.kind === "transcript")).toBe(true);

    const { filename, markdown } = h.core.exportNotes(live.id, true);
    expect(filename).toBe("Release-sync.md");
    for (const s of ["# Release sync", "## Summary", "Ship v2 Friday; scope frozen today.", "## Questions asked", "- Can QA finish by Thursday?", "  - Answer: Yes, if scope is frozen.", "## Decisions", "- [ ] Freeze scope", "## Unanswered questions", "## Concepts to revisit", "## Transcript", "Speaker 2: Yes, if we freeze scope today.", "edited by you", "may be inaccurate"]) expect(markdown, s).toContain(s);
    expect(markdown).not.toMatch(/_\(Speaker 1\)_/); // no attribution invented for the question
  });

  it("exports notes even without generated insights, and refuses another session's transcript", () => {
    const h = harness();
    const live = h.core.startTranscript("t");
    h.sockets[0]!.open();
    h.sockets[0]!.result("hello there", true, 0);
    h.core.stopTranscript();
    expect(h.core.exportNotes(live.id, true).markdown).toContain("hello there");
    h.core.createSession({ title: "other", type: "general" });
    expect(() => h.core.exportNotes(live.id, true)).toThrow(/another session/);
    expect(() => h.core.updateNotes(live.id, { summary: "x" })).toThrow(/another session/);
  });

  it("markdown export omits the transcript when asked", () => {
    const md = notesToMarkdown({ title: "T", startedAt: 0, endedAt: 60_000 }, null, [{ id: "1", sessionId: "t", startMs: 0, endMs: 1, speaker: null, channel: "mic", text: "secret line", edited: false, confidence: null }], { includeTranscript: false });
    expect(md).not.toContain("secret line");
  });
});

describe("profile", () => {
  it("profile sections are stored as global, replaceable, deletable knowledge", () => {
    const h = harness();
    h.core.saveProfileSection("skills", "Rust and Go");
    h.core.saveProfileSection("skills", "Rust, Go and Kotlin");
    expect(h.core.profileText().skills).toBe("Rust, Go and Kotlin");
    expect(h.store.listKnowledgeDocs(null).filter((d) => d.format === "profile:skills")).toHaveLength(1);
    h.core.saveProfileSection("skills", "");
    expect(h.core.profileText().skills).toBe("");
  });
});
