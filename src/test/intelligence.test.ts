import { describe, expect, it } from "vitest";
import { classifyTask } from "../core/intelligence/classify";
import { answerLanguage, planResponse, priorTurn } from "../core/intelligence/orchestrator";
import { buildStrategy, preferencesBlock, type Preferences } from "../core/intelligence/strategy";
import { requestedLanguage, resolveTurn, type PriorTurn } from "../core/intelligence/turns";
import { DeepgramProvider } from "../core/transcription/deepgram";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { loadSettings, settingsSchema } from "../shared/settingsSchema";
import type { ChatMessage } from "../shared/types";
import { harness } from "./harness";

const tree: PriorTurn = { question: "How do I do an inorder traversal of a binary tree recursively?", answer: "Recurse left, visit, recurse right.\n```python\ndef inorder(n): ...\n```", language: "python" };
const prefs: Preferences = { depth: "quick", language: "python", alsoKnows: [], level: "mid", codeStyle: "idiomatic", hintsFirst: false, includeComplexity: true, includeTests: true };

function msg(role: "user" | "assistant", content: string, extra: Partial<ChatMessage["meta"]> = {}): ChatMessage {
  return { id: Math.random().toString(36), conversationId: "c", role, content, createdAt: 0, references: [], meta: extra };
}
/** System prompt text and message history the fake Anthropic backend received. */
function requestOf(call: { body: Record<string, unknown> }) {
  const system = (call.body.system as { text: string }[]).map((b) => b.text).join("\n");
  const messages = call.body.messages as { role: string; content: unknown }[];
  return { system, messages };
}

describe("turn resolution", () => {
  it("treats a first message as new and resolves follow-ups to the same problem", () => {
    expect(resolveTurn("How do I reverse a linked list?", null, { hasScreen: false }).relation).toBe("new");
    const r = resolveTurn("What about the iterative approach?", tree, { hasScreen: false });
    expect(r.relation).toBe("follow_up");
    expect(r.anchor?.question).toBe(tree.question);
    expect(r.retrievalQuery).toContain("binary tree");
  });

  it("recognizes elaborate, simplify, correction and code-revision requests", () => {
    expect(resolveTurn("Can you elaborate?", tree, { hasScreen: false }).relation).toBe("elaborate");
    expect(resolveTurn("Explain it in simpler terms", tree, { hasScreen: false }).relation).toBe("simplify");
    expect(resolveTurn("Actually, the tree can have duplicate keys", tree, { hasScreen: false }).relation).toBe("correction");
    expect(resolveTurn("Rewrite it in Java", tree, { hasScreen: false }).relation).toBe("revise_code");
    expect(resolveTurn("Make the solution handle an empty tree", tree, { hasScreen: false }).relation).toBe("revise_code");
  });

  it("routes questions about the screen to captured context only when a capture exists", () => {
    expect(resolveTurn("What's wrong with this code?", null, { hasScreen: true }).relation).toBe("screen");
    expect(resolveTurn("What's wrong with this code?", null, { hasScreen: false }).relation).toBe("new");
  });

  it("flags inputs that cannot be resolved without an earlier turn", () => {
    expect(resolveTurn("why?", null, { hasScreen: false }).ambiguous).toBe(true);
    expect(resolveTurn("fix it", null, { hasScreen: false }).ambiguous).toBe(true);
    expect(resolveTurn("why?", tree, { hasScreen: false }).ambiguous).toBe(false);
    expect(resolveTurn("What is a mutex?", null, { hasScreen: false }).ambiguous).toBe(false);
  });

  it("starts a new topic when the message is unrelated", () => {
    expect(resolveTurn("How do database indexes work in PostgreSQL?", tree, { hasScreen: false }).relation).toBe("new");
  });

  it("detects explicitly requested languages, including the Java/JavaScript distinction", () => {
    expect(requestedLanguage("write it in Java")).toBe("java");
    expect(requestedLanguage("convert to JavaScript")).toBe("javascript");
    expect(requestedLanguage("in C++ please")).toBe("cpp");
    expect(requestedLanguage("explain recursion")).toBeNull();
  });
});

describe("task classification", () => {
  it.each([
    ["Find the longest substring without repeating characters", "algorithm"],
    ["Why does this throw a NullPointerException?", "debugging"],
    ["Design a URL shortener for a million users", "system_design"],
    ["Write a SQL query to get the second highest salary", "database_sql"],
    ["Write unit tests for this parser", "testing"],
    ["How should I structure my REST API endpoints?", "api_backend"],
    ["Why does my React useEffect run twice?", "frontend"],
    ["Tell me about a time you disagreed with a teammate", "behavioral"],
    ["Summarize the meeting", "meeting_summary"],
    ["What's the capital of Australia?", "general"],
  ])("%s → %s", (text, cat) => {
    expect(classifyTask(text).category).toBe(cat);
  });

  it("uses context hints to break ties and falls back to general", () => {
    expect(classifyTask("what does it do", { codeInContext: true }).category).toBe("code_explanation");
    expect(classifyTask("hmm", {}).category).toBe("general");
  });
});

describe("response strategy", () => {
  const newTurn = resolveTurn("Find two numbers in an array that sum to a target", null, { hasScreen: false });

  it("adapts structure to the task and depth", () => {
    const quick = buildStrategy(newTurn, "algorithm", prefs, { hasWorkflow: false });
    const deep = buildStrategy(newTurn, "algorithm", { ...prefs, depth: "deep" }, { hasWorkflow: false });
    expect(quick.instruction).toMatch(/Depth: quick/);
    expect(deep.instruction).toMatch(/invariant/);
    expect(deep.instruction).toMatch(/alternative approach/);
    expect(buildStrategy(newTurn, "general", prefs, { hasWorkflow: false }).instruction).not.toMatch(/Assumption:/);
  });

  it("gives hints first only for new algorithm questions that don't ask for the solution", () => {
    const hp = { ...prefs, hintsFirst: true };
    expect(buildStrategy(newTurn, "algorithm", hp, { hasWorkflow: false }).hintsOnly).toBe(true);
    const wants = resolveTurn("Show me the code for two sum", null, { hasScreen: false });
    expect(buildStrategy(wants, "algorithm", hp, { hasWorkflow: false }).hintsOnly).toBe(false);
    const follow = resolveTurn("What about the iterative approach?", tree, { hasScreen: false });
    expect(buildStrategy(follow, "algorithm", hp, { hasWorkflow: false }).hintsOnly).toBe(false);
  });

  it("never invents experience for behavioral answers", () => {
    const t = resolveTurn("Tell me about a time you led a team", null, { hasScreen: false });
    expect(buildStrategy(t, "behavioral", prefs, { hasWorkflow: false }).instruction).toMatch(/never invent/i);
  });

  it("leaves structure to mode workflows and asks for clarification when ambiguous", () => {
    const wf = buildStrategy(newTurn, "algorithm", prefs, { hasWorkflow: true });
    expect(wf.instruction).not.toMatch(/Algorithm question/);
    const vague = resolveTurn("why?", null, { hasScreen: false });
    expect(buildStrategy(vague, "general", prefs, { hasWorkflow: false }).instruction).toMatch(/clarifying question/);
  });

  it("states preferences once and labels tests as not executed", () => {
    const block = preferencesBlock({ ...prefs, alsoKnows: ["java", "python"], includeTests: false });
    expect(block).toMatch(/Default programming language: Python; also comfortable with Java\./);
    expect(block).toMatch(/omit test cases/);
    expect(block).toMatch(/not run/);
  });
});

describe("orchestrator", () => {
  it("finds the previous completed exchange, skipping stopped answers", () => {
    const h = [msg("user", "Q1"), msg("assistant", "A1 ```java\nx\n```"), msg("user", "Q2"), msg("assistant", "partial", { cancelled: true })];
    expect(priorTurn(h)).toMatchObject({ question: "Q1", language: "java" });
    expect(priorTurn([])).toBeNull();
    expect(answerLanguage("```ts\nconst x = 1\n```")).toBe("typescript");
  });

  it("keeps full history for follow-ups but trims it for new topics", () => {
    const history = [msg("user", tree.question), msg("assistant", tree.answer)];
    const base = { history, settings: DEFAULT_SETTINGS, sessionType: "general", style: "quick" as const, hasScreen: false, codeInContext: false, hasWorkflow: false };
    const follow = planResponse({ ...base, question: "What about the iterative approach?" });
    expect(follow.turn.relation).toBe("follow_up");
    expect(follow.task.category).toBe("algorithm");
    expect(follow.historyMessages).toBeGreaterThan(2);
    const fresh = planResponse({ ...base, question: "How do I configure nginx as a reverse proxy?" });
    expect(fresh.turn.relation).toBe("new");
    expect(fresh.historyMessages).toBe(2);
  });

  it("maps the Detailed style to deep and honours an explicit per-request depth", () => {
    const base = { question: "Explain recursion", history: [], settings: DEFAULT_SETTINGS, sessionType: "general", hasScreen: false, codeInContext: false, hasWorkflow: false };
    expect(planResponse({ ...base, style: "detailed" }).strategy.depth).toBe("deep");
    expect(planResponse({ ...base, style: "quick", depth: "balanced" }).strategy.depth).toBe("balanced");
  });
});

describe("pipeline integration", () => {
  it("answers a follow-up about the same problem with history and the follow-up strategy", async () => {
    const h = harness({ turns: [{ text: ["Recursive answer\n```python\ndef inorder(n): ...\n```"] }, { text: ["Iterative answer with a stack."] }] });
    const first = await h.ask("How do I do an inorder traversal of a binary tree recursively?");
    const start = first.find((e) => e.type === "start")!;
    expect(start.type === "start" && start.intent.relation).toBe("new");
    const conversationId = start.type === "start" ? start.conversationId : null;
    const second = await h.ask("What about the iterative approach?", { conversationId });
    const s2 = second.find((e) => e.type === "start")!;
    expect(s2.type === "start" && s2.intent).toMatchObject({ relation: "follow_up", category: "algorithm" });
    const { system, messages } = requestOf(h.calls.at(-1)!);
    expect(system).toMatch(/follow-up to the previous question/);
    expect(system).toMatch(/User preferences/);
    expect(JSON.stringify(messages)).toContain("inorder traversal");
    const stored = h.store.listMessages(conversationId!).at(-1)!;
    expect(stored.meta.intent?.relation).toBe("follow_up");
  });

  it("never treats another session's conversation as the previous turn", async () => {
    const h = harness({ turns: [{ text: ["Answer A"] }, { text: ["Answer B"] }] });
    const a = await h.ask("How do I balance a binary search tree?");
    const convA = a.find((e) => e.type === "start")!;
    h.core.createSession({ title: "Other", type: "general" });
    const b = await h.ask("What about the iterative approach?", { conversationId: convA.type === "start" ? convA.conversationId : null });
    const sb = b.find((e) => e.type === "start")!;
    expect(sb.type === "start" && sb.conversationId).not.toBe(convA.type === "start" ? convA.conversationId : "");
    expect(sb.type === "start" && sb.intent.relation).toBe("new");
    expect(JSON.stringify(requestOf(h.calls.at(-1)!).messages)).not.toContain("binary search tree");
  });

  it("asks for clarification on an unresolvable message instead of guessing", async () => {
    const h = harness({ turns: [{ text: ["Could you say which code you mean?"] }] });
    const ev = await h.ask("fix it");
    const s = ev.find((e) => e.type === "start")!;
    expect(s.type === "start" && s.intent.ambiguous).toBe(true);
    expect(requestOf(h.calls.at(-1)!).system).toMatch(/clarifying question/);
  });

  it("reports provider failures as errors, never as a fabricated answer", async () => {
    const h = harness({ turns: [{ status: 500, error: { type: "api_error", message: "upstream down" } }] });
    const ev = await h.ask("What is a closure in JavaScript?");
    expect(ev.some((e) => e.type === "error")).toBe(true);
    expect(ev.some((e) => e.type === "done")).toBe(false);
    expect(h.store.listConversations(h.core.activeSessionId).flatMap((c) => h.store.listMessages(c.id)).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("ignores a duplicate submission with the same request id", async () => {
    const h = harness({ turns: [{ text: ["one"] }, { text: ["two"] }] });
    const req = { requestId: "dup-1", conversationId: null, text: "What is a heap?", style: "quick" as const, tone: "neutral" as const, includeLiveTranscript: false };
    await h.core.send(req);
    await h.core.send(req);
    expect(h.calls).toHaveLength(1);
    expect(h.chat.filter((e) => e.requestId === "dup-1" && e.type === "done")).toHaveLength(1);
  });

  it("cancels a streaming answer and keeps the partial text marked as stopped", async () => {
    const h = harness({ turns: [{ text: ["part one ", "part two ", "part three"], stallAfter: 1 }] });
    const p = h.ask("Explain the CAP theorem");
    await new Promise((r) => setTimeout(r, 30));
    const reqId = h.chat.find((e) => e.type === "start")!.requestId;
    expect(h.core.chat.cancel(reqId)).toBe(true);
    const ev = await p;
    const cancelled = ev.find((e) => e.type === "cancelled");
    expect(cancelled).toBeTruthy();
    const pid = cancelled?.type === "cancelled" ? cancelled.partialMessageId : null;
    expect(pid && h.store.getMessage(pid)).toMatchObject({ content: "part one ", meta: { cancelled: true } });
  });
});

describe("settings", () => {
  it("defaults satisfy the schema", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(DEFAULT_SETTINGS.questions.policy).toBe("assisted");
    expect(DEFAULT_SETTINGS.transcription.vocabulary).toEqual([]);
  });

  it("migrates the legacy interview.autoSuggest flag to the question policy", () => {
    expect(loadSettings({ interview: { autoSuggest: false, length: "short", interviewer: "any" } }).questions.policy).toBe("manual");
    expect(loadSettings({ interview: { autoSuggest: true } }).questions.policy).toBe("assisted");
    const s = loadSettings({ interview: { autoSuggest: false } });
    expect("autoSuggest" in s.interview).toBe(false);
    // An explicit new-format value wins over a stale legacy field.
    expect(loadSettings({ interview: { autoSuggest: true }, questions: { policy: "manual" } }).questions.policy).toBe("manual");
  });

  it("repairs invalid personalization values field by field instead of failing", () => {
    const s = loadSettings({ personalization: { depth: "extreme", hintsFirst: true }, questions: { policy: "automatic" } });
    expect(s.personalization.depth).toBe(DEFAULT_SETTINGS.personalization.depth);
    expect(s.questions.policy).toBe("assisted");
  });

  it("sends transcription vocabulary to Deepgram as keyterms", () => {
    const url = new DeepgramProvider("k").buildUrl({ language: "en", diarize: true, channels: 1, vocabulary: ["Kubernetes", "useEffect"] });
    expect(new URL(url).searchParams.getAll("keyterm")).toEqual(["Kubernetes", "useEffect"]);
  });

  it("only suggests answers for detected questions under the assisted policy", () => {
    const h = harness({ settings: { questions: { policy: "manual" } } });
    h.core.createSession({ title: "Practice", type: "interview" });
    h.core.startTranscript("Practice");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("Tell me about a time you resolved a conflict on your team?", true, 0, 0);
    expect(h.core.pollQuestions(true)).toBeNull();
    expect(h.chat.some((e) => e.type === "suggestion")).toBe(false);
  });
});
