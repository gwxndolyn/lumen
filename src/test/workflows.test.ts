// Required end-to-end workflows (A–H), exercised through the real AppCore, ContextEngine,
// ChatService, SQLite store, Anthropic SDK (against a wire-compatible fake HTTP backend),
// TranscriptSession and Deepgram provider (against a fake WebSocket).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../shared/types";
import { FakeOcr, harness } from "./harness";
import { sentText } from "./helpers";

const lastDone = (evts: ChatEvent[]) => evts.find((e) => e.type === "done") as Extract<ChatEvent, { type: "done" }> | undefined;
const startOf = (evts: ChatEvent[]) => evts.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;

describe("A. question → streaming answer → user cancels", () => {
  it("streams deltas in order, then cancel stops generation and keeps the partial answer", async () => {
    const h = harness({ turns: [{ text: Array.from({ length: 60 }, (_, i) => `t${i} `), delayMs: 4 }] });
    const requestId = "req-A";
    const p = h.core.send({ requestId, conversationId: null, text: "Explain streaming", style: "detailed", tone: "neutral", includeLiveTranscript: false });
    // Cancel once a few deltas have arrived.
    for (let i = 0; i < 100 && h.chat.filter((e) => e.type === "delta").length < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.core.chat.cancel(requestId)).toBe(true);
    await p;
    const types = h.chat.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("cancelled");
    expect(types.filter((t) => t === "delta").length).toBeLessThan(60);
    const cancelled = h.chat.at(-1) as Extract<ChatEvent, { type: "cancelled" }>;
    const stored = h.store.getMessage(cancelled.partialMessageId!)!;
    expect(stored.meta.cancelled).toBe(true);
    const deltas = h.chat
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(stored.content).toBe(deltas);
    expect(h.core.metrics.snapshot().requests[0]!.outcome).toBe("cancelled");
  });

  it("ignores a duplicate send with the same request id (no double generation)", async () => {
    const h = harness({ turns: [{ text: ["one"] }] });
    const req = { requestId: "dup", conversationId: null, text: "Hi", style: "quick" as const, tone: "neutral" as const, includeLiveTranscript: false };
    await Promise.all([h.core.send(req), h.core.send(req)]);
    expect(h.calls).toHaveLength(1);
    expect(h.chat.filter((e) => e.type === "start")).toHaveLength(1);
  });

  it("rejects a concurrent second question in the same conversation, preserving turn order", async () => {
    const h = harness({ turns: [{ text: ["a"] }, { text: ["b", "c", "d"], delayMs: 20 }] });
    const first = await h.ask("Q1");
    const conv = startOf(first).conversationId;
    const slow = h.core.send({ requestId: "slow", conversationId: conv, text: "Q2", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await new Promise((r) => setTimeout(r, 5));
    await h.core.send({ requestId: "fast", conversationId: conv, text: "Q3", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await slow;
    expect(h.chat.find((e) => e.requestId === "fast" && e.type === "error")).toMatchObject({ code: "busy" });
    expect(h.store.listMessages(conv).map((m) => m.content)).toEqual(["Q1", "a", "Q2", "bcd"]);
  });
});

describe("B. screenshot → OCR → question uses the capture", () => {
  it("runs OCR, keeps pending captures out of prompts until confirmed, then grounds the answer", async () => {
    const h = harness({ turns: [{ text: ["Total due is $1,250.00 [C1]"] }, { text: ["Total due is $1,250.00 [C1]"] }] });
    const { record, ocr } = h.core.addCapture(
      { title: "Invoice", sourceId: "cap-1", vision: { mediaType: "image/jpeg", data: "QUJD" }, ocrPng: Buffer.from("png"), thumbnailDataUrl: "data:," },
      { pending: true },
    );
    expect(h.core.engine.get(record.id)!.ocr).toBe("running");
    await ocr;
    const rec = h.core.engine.get(record.id)!;
    expect(rec.ocr).toBe("done");
    expect(rec.text).toContain("$1,250.00");
    expect(rec.confidence).toBeCloseTo(0.95);

    // Pending (not yet previewed/confirmed): must NOT be sent.
    await h.ask("What is the total due?");
    expect(sentText(h.calls[0]!.body)).not.toContain("1,250");
    expect(JSON.stringify(h.calls[0]!.body)).not.toContain("QUJD");

    h.core.engine.confirm(record.id);
    const evts = await h.ask("What is the total due?");
    const body = h.calls[1]!.body as { messages: { content: { type: string; source?: { data: string } }[] }[] };
    const last = body.messages.at(-1)!.content;
    expect(last.some((p) => p.type === "image" && p.source?.data === "QUJD")).toBe(true);
    expect(sentText(h.calls[1]!.body)).toContain("Invoice 4471 total due: $1,250.00");
    expect(sentText(h.calls[1]!.body)).toMatch(/confidence="95%"/);
    expect(startOf(evts).availability.screen).toBe(1);
    expect(lastDone(evts)!.citedLabels).toEqual(["C1"]);
  });

  it("waits for OCR still in progress when the user asks immediately", async () => {
    const h = harness({ turns: [{ text: ["ok"] }] });
    h.capture();
    await h.ask("What does the screen say?");
    expect(sentText(h.calls[0]!.body)).toContain("Payment deadline is November 14");
  });

  it("sends OCR text only when 'send images' is off", async () => {
    const h = harness({ settings: { screen: { requirePreview: true, sendImages: false, ocr: true, liveIntervalSec: 10 } } });
    await h.capture().ocr;
    await h.ask("Read it");
    expect(JSON.stringify(h.calls[0]!.body)).not.toContain('"type":"image"');
    expect(sentText(h.calls[0]!.body)).toContain("$1,250.00");
  });

  it("handles OCR failure gracefully and still allows the image", async () => {
    const h = harness({ ocr: new FakeOcr("", 0, true) });
    const { record, ocr } = h.capture();
    await ocr;
    expect(h.core.engine.get(record.id)!.warning).toMatch(/Text recognition failed/);
    await h.ask("What is this?");
    expect(JSON.stringify(h.calls[0]!.body)).toContain('"type":"image"');
  });

  it("masks sensitive values recognized on screen before sending", async () => {
    const h = harness({ ocr: new FakeOcr("Card 4111 1111 1111 1111 exp 09/29\npassword: hunter22", 0.9) });
    const { record, ocr } = h.capture("Checkout");
    await ocr;
    expect(h.core.engine.get(record.id)!.sensitivity).toBe("sensitive");
    await h.ask("What's on screen?");
    const sent = sentText(h.calls[0]!.body);
    expect(sent).not.toContain("4111 1111 1111 1111");
    expect(sent).not.toContain("hunter22");
    expect(sent).toContain("[redacted card number]");
  });
});

describe("C. microphone → transcription → contextual question", () => {
  it("streams segments into the session and answers with transcript context", async () => {
    const h = harness({ turns: [{ text: ["You agreed to launch on Thursday [C1]"] }] });
    const live = h.core.startTranscript("Standup");
    expect(h.app.some((e) => e.type === "audio-command" && e.command === "start")).toBe(true);
    const ws = h.sockets[0]!;
    expect(ws.protocols).toEqual(["token", "dg-test-key"]);
    h.core.pushAudio(new Uint8Array(3200));
    ws.open();
    expect(ws.sent).toHaveLength(1); // buffered audio flushed on open
    ws.result("we should launch", false, 0, 0);
    ws.result("We should launch on Thursday.", true, 0, 0);
    ws.result("Agreed, Thursday it is.", true, 2, 1);
    expect(h.transcript.some((e) => e.type === "interim")).toBe(true);
    expect(live.liveSegments().map((s) => s.text)).toEqual(["We should launch on Thursday.", "Agreed, Thursday it is."]);
    expect(h.store.listSegments(live.id)).toHaveLength(2);

    const evts = await h.ask("What did we agree about the launch?");
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("Speaker 1: We should launch on Thursday.");
    expect(sent).toContain("Speaker 2: Agreed, Thursday it is.");
    expect(startOf(evts).availability.transcript).toBe("live");
    expect(lastDone(evts)!.citedLabels).toEqual(["C1"]);
  });

  it("tells the model the transcript is NOT available when none exists (no fabrication)", async () => {
    const h = harness();
    const evts = await h.ask("Summarize the meeting", { style: "meeting_summary" });
    expect(sentText(h.calls[0]!.body)).toContain("live transcript: NOT available");
    expect(startOf(evts).availability.transcript).toBe("none");
    const system = JSON.stringify((h.calls[0]!.body as { system: unknown }).system);
    expect(system).toContain("If there is no transcript in context, say so instead of summarizing");
  });

  it("keeps mic and system audio as separate labelled channels", async () => {
    const h = harness({ settings: { transcription: { kind: "deepgram", language: "en", microphoneDeviceId: null, captureSystemAudio: true, persist: true } } });
    const live = h.core.startTranscript("Call");
    const ws = h.sockets[0]!;
    expect(ws.url).toContain("channels=2");
    expect(ws.url).toContain("multichannel=true");
    ws.open();
    ws.result("Hello from me", true, 0, 0, 0);
    ws.result("Hello from the other side", true, 0, 0, 1);
    expect(live.liveSegments().map((s) => [s.channel, s.speaker])).toEqual([
      ["mic", "You (Speaker 1)"],
      ["system", "Remote Speaker 1"],
    ]);
  });

  it("does not persist transcripts when saving is off", async () => {
    const h = harness({ settings: { transcription: { kind: "deepgram", language: "en", microphoneDeviceId: null, captureSystemAudio: false, persist: false } } });
    const live = h.core.startTranscript("Private");
    h.sockets[0]!.open();
    h.sockets[0]!.result("Confidential plan", true, 0);
    expect(live.id.startsWith("mem-")).toBe(true);
    expect(h.store.counts().transcripts).toBe(0);
    await h.ask("What was said?");
    expect(sentText(h.calls[0]!.body)).toContain("Confidential plan");
    h.core.stopTranscript();
    expect(live.liveSegments()).toEqual([]);
    expect(h.core.transcriptContext(h.core.activeSessionId)).toBeNull();
  });
});

describe("D. import document → search → grounded answer", () => {
  it("imports files and a folder, reports failures, retrieves passages and cites them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-kb-"));
    fs.writeFileSync(path.join(dir, "handbook.md"), "# Leave policy\n\nEmployees receive 25 days of annual leave. Carry-over is capped at 5 days.");
    fs.writeFileSync(path.join(dir, "notes.txt"), "Unrelated grocery list: apples, bread.");
    fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "skip.md"), "should be skipped");
    const h = harness({ turns: [{ text: ["You get 25 days [C1]."] }] });
    const res = await h.core.importKnowledge([dir], "global");
    expect(res.imported.map((d) => d.title).sort()).toEqual(["handbook.md", "notes.txt"]);
    expect(res.failed.map((f) => f.file)).toEqual(["empty.txt"]);
    expect(res.skipped).toBe(1); // image.bin (unsupported, inside folder)
    const again = await h.core.importKnowledge([path.join(dir, "handbook.md")], "global");
    expect(again.failed[0]!.reason).toMatch(/Already imported/);

    const hits = h.store.searchKnowledge("how many days of annual leave", h.core.activeSessionId);
    expect(hits[0]!.title).toBe("handbook.md");
    expect(hits.some((x) => x.title === "notes.txt")).toBe(false);

    const evts = await h.ask("How many days of annual leave do I get?");
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain('kind="knowledge base passage" title="handbook.md"');
    expect(sent).toContain("25 days of annual leave");
    expect(sent).not.toContain("grocery");
    const done = lastDone(evts)!;
    expect(done.citedLabels).toEqual(["C1"]);
    const stored = h.store.getMessage(done.messageId)!;
    expect(stored.references[0]).toMatchObject({ kind: "knowledge", title: "handbook.md" });
    fs.rmSync(dir, { recursive: true });
  });

  it("removing a document removes its chunks and index rows", async () => {
    const h = harness();
    const doc = h.core.addKnowledgeText("Glossary", "Kubernetes is a container orchestrator.", "global");
    expect(h.store.ftsCounts().chunks).toBe(1);
    h.store.deleteKnowledgeDoc(doc.id);
    expect(h.store.ftsCounts().chunks).toBe(0);
    expect(h.store.searchKnowledge("kubernetes", null)).toEqual([]);
  });
});

describe("E. switching sessions does not leak context", () => {
  it("isolates notes, captures, transcripts, knowledge and history between sessions", async () => {
    const h = harness({ turns: [{ text: ["A1"] }, { text: ["B1"] }, { text: ["A2"] }] });
    const a = h.core.activeSessionId;
    h.core.addText("note", "Secret plan", "Project Falcon launches in March.");
    await h.capture("Payroll").ocr;
    h.core.addKnowledgeText("Session doc", "Falcon budget is 2 million.", "session");
    const live = h.core.startTranscript("A meeting");
    h.sockets[0]!.open();
    h.sockets[0]!.result("Falcon is confidential.", true, 0);
    await h.ask("Tell me about Falcon");
    expect(sentText(h.calls[0]!.body)).toContain("Falcon");

    const b = h.core.createSession({ title: "Other client", type: "meeting" });
    expect(h.core.activeSessionId).toBe(b.id);
    const evts = await h.ask("Tell me about Falcon budget launch plan confidential");
    const sent = sentText(h.calls[1]!.body);
    expect(sent).not.toMatch(/Falcon is confidential|launches in March|2 million|Payroll|1,250/);
    expect(sent).toContain("(no context sources are active)");
    expect(startOf(evts).availability).toMatchObject({ transcript: "none", screen: 0, notes: 0, knowledge: 0, history: 0 });
    // B's search only ever returns B's own messages (its own question), never A's content.
    const hitsB = h.store.search("Falcon", b.id);
    expect(hitsB.every((x) => x.sessionId === b.id)).toBe(true);
    expect(hitsB.some((x) => /Falcon is confidential|launches in March/.test(x.snippet))).toBe(false);
    expect(live.workspaceSessionId).toBe(a);

    // Switching back restores A's context.
    h.core.switchSession(a);
    await h.ask("Falcon?");
    expect(sentText(h.calls[2]!.body)).toContain("Falcon is confidential");
  });

  it("sends the session's own notes as pinned context, and only in that session", async () => {
    const h = harness({ turns: [{ text: ["a"] }, { text: ["b"] }] });
    const s1 = h.core.createSession({ title: "Interview", type: "interview", notes: "Role: Staff engineer at Acme. Focus on distributed systems." });
    await h.ask("How should I introduce myself?");
    expect(sentText(h.calls[0]!.body)).toContain('title="Session notes"');
    expect(sentText(h.calls[0]!.body)).toContain("Staff engineer at Acme");
    expect(JSON.stringify((h.calls[0]!.body as { system: unknown }).system)).toContain("interview practice");
    h.core.createSession({ title: "Other", type: "general" });
    await h.ask("How should I introduce myself?");
    expect(sentText(h.calls[1]!.body)).not.toContain("Acme");
    expect(s1.id).toBeTruthy();
  });

  it("a stale conversation id from another session starts a new conversation instead", async () => {
    const h = harness({ turns: [{ text: ["x"] }, { text: ["y"] }] });
    const first = await h.ask("Q in A");
    const convA = startOf(first).conversationId;
    h.core.createSession({ title: "B", type: "general" });
    const second = await h.ask("Q in B", { conversationId: convA });
    expect(startOf(second).conversationId).not.toBe(convA);
    expect((h.calls[1]!.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("cancels in-flight answers of the previous session on switch", async () => {
    const h = harness({ turns: [{ text: Array.from({ length: 40 }, () => "z"), delayMs: 5 }] });
    const p = h.core.send({ requestId: "inflight", conversationId: null, text: "long", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await new Promise((r) => setTimeout(r, 30));
    h.core.createSession({ title: "B", type: "general" });
    await p;
    expect(h.chat.at(-1)).toMatchObject({ type: "cancelled", requestId: "inflight" });
  });
});

describe("F. revoking a permission stops the source and updates state", () => {
  it("screen: revocation deletes screen context, stops live screen and blocks new captures", async () => {
    const h = harness();
    await h.capture().ocr;
    expect(h.core.engine.list(h.core.activeSessionId)).toHaveLength(1);
    h.core.updateSettings({ consent: { screen: false } });
    expect(h.core.engine.list(h.core.activeSessionId)).toHaveLength(0);
    expect(h.app.some((e) => e.type === "permission-revoked" && e.permission === "screen")).toBe(true);
    expect(() => h.capture()).toThrow(/Permission for screen/);
    await h.ask("What was on screen?");
    expect(JSON.stringify(h.calls[0]!.body)).not.toContain("1,250");
  });

  it("screen: OCR that finishes after revocation is discarded", async () => {
    const h = harness();
    const { record, ocr } = h.capture();
    h.core.updateSettings({ consent: { screen: false } });
    await ocr;
    expect(h.core.engine.get(record.id)).toBeUndefined();
  });

  it("microphone: revocation stops recording, tells the renderer to release the device, and drops audio", () => {
    const h = harness();
    const live = h.core.startTranscript("x");
    h.sockets[0]!.open();
    h.core.updateSettings({ consent: { microphone: false } });
    expect(live.status).toBe("stopped");
    expect(h.app.some((e) => e.type === "audio-command" && e.command === "stop")).toBe(true);
    const before = h.sockets[0]!.sent.length;
    h.core.pushAudio(new Uint8Array(100));
    expect(h.sockets[0]!.sent.length).toBe(before);
    expect(() => h.core.startTranscript("again")).toThrow(/microphone/i);
  });

  it("system audio: revocation releases only the system channel", () => {
    const h = harness({ settings: { transcription: { kind: "deepgram", language: "en", microphoneDeviceId: null, captureSystemAudio: true, persist: true } } });
    h.core.startTranscript("x");
    h.core.updateSettings({ consent: { systemAudio: false } });
    expect(h.app.some((e) => e.type === "audio-command" && e.command === "system-off")).toBe(true);
    expect(h.core.live!.status).not.toBe("stopped");
    expect(h.core.settings.transcription.captureSystemAudio).toBe(false);
  });
});

describe("G. provider disconnects → error → reconnection without corrupting history", () => {
  it("surfaces a retryable network error, records health, then a retry succeeds and history stays consistent", async () => {
    const h = harness({ turns: [{ networkError: true }, { networkError: true }, { networkError: true }, { networkError: true }, { text: ["Recovered answer"] }] });
    const first = await h.ask("Hello?");
    const err = first.find((e) => e.type === "error") as Extract<ChatEvent, { type: "error" }>;
    expect(err).toMatchObject({ code: "network", retryable: true });
    expect(h.core.health.state).toBe("degraded");
    expect(h.calls).toHaveLength(4); // retried with backoff before giving up
    const conv = err.conversationId!;
    expect(h.store.listMessages(conv).map((m) => m.role)).toEqual(["user"]);

    // User retries the same question in the same conversation.
    const second = await h.ask("Hello?", { conversationId: conv });
    expect(lastDone(second)).toBeTruthy();
    expect(h.core.health.state).toBe("ok");
    const msgs = h.store.listMessages(conv);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hello?"],
      ["user", "Hello?"],
      ["assistant", "Recovered answer"],
    ]);
    // Consecutive user turns are merged so the API still receives alternating roles.
    const roles = (h.calls.at(-1)!.body as { messages: { role: string }[] }).messages.map((m) => m.role);
    expect(roles).toEqual(["user"]);
  });

  it("a mid-stream disconnect keeps the partial text flagged as interrupted, never feeds it back, and the next question works", async () => {
    const h = harness({ turns: [{ text: ["part ", "ial", "x"], dropAfter: 2 }, { text: ["fine"] }] });
    const first = await h.ask("Q1");
    expect(first.at(-1)).toMatchObject({ type: "error", code: "network" });
    const conv = startOf(first).conversationId;
    const afterDrop = h.store.listMessages(conv);
    expect(afterDrop.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(afterDrop[1]!.meta.interrupted).toBe(true);
    const second = await h.ask("Q2", { conversationId: conv });
    expect(lastDone(second)).toBeTruthy();
    expect(h.store.listMessages(conv).map((m) => m.content)).toEqual(["Q1", "part ial", "Q2", "fine"]);
    // The half-written answer is not sent to the model as if it were a real reply.
    expect(JSON.stringify((h.calls.at(-1)!.body as { messages: unknown }).messages)).not.toContain("part ial");
  });

  it("a stalled stream is aborted by the watchdog and, by default, not resent (it may have been billed)", async () => {
    const h = harness({ settings: { provider: { idleTimeoutMs: 5000 } }, turns: [{ stallAfter: 0, text: ["never"] }, { text: ["ok"] }] });
    h.core.settings = { ...h.core.settings, provider: { ...h.core.settings.provider, idleTimeoutMs: 60 } };
    const evts = await h.ask("Q");
    expect(evts.some((e) => e.type === "retrying")).toBe(false);
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "timeout", retryable: true });
    expect(h.calls).toHaveLength(1);
  });

  it("a stalled stream is retried when the user allows retrying timeouts", async () => {
    const h = harness({ settings: { provider: { idleTimeoutMs: 5000 }, limits: { retryTimeouts: true } }, turns: [{ stallAfter: 0, text: ["never"] }, { text: ["ok"] }] });
    h.core.settings = { ...h.core.settings, provider: { ...h.core.settings.provider, idleTimeoutMs: 60 } };
    const evts = await h.ask("Q");
    expect(evts.some((e) => e.type === "retrying")).toBe(true);
    expect(lastDone(evts)).toBeTruthy();
  });

  it("transcription reconnects after a network drop without duplicating replayed segments", () => {
    const h = harness();
    const live = h.core.startTranscript("x");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("First sentence.", true, 0);
    ws.drop();
    expect(live.status).toBe("reconnecting");
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const ws2 = h.sockets[1]!;
        ws2.open();
        // The recognizer re-emits the already-final sentence after the replay.
        ws2.result("First sentence.", true, 0);
        ws2.result("Second sentence.", true, 1);
        expect(live.liveSegments().map((s) => s.text)).toEqual(["First sentence.", "Second sentence."]);
        expect(live.status).toBe("recording");
        resolve();
      }, 600),
    );
  });
});

describe("H. deleting a session removes its stored and indexed data", () => {
  it("cascades to conversations, messages, transcripts, segments, insights, session documents, context and FTS rows", async () => {
    const h = harness({ turns: [{ text: ["answer one"] }] });
    const victim = h.core.activeSessionId;
    h.core.addText("note", "Persisted note", "Remember the code word pineapple.");
    h.core.addKnowledgeText("Session doc", "Pineapple protocol details.", "session");
    const global = h.core.addKnowledgeText("Global doc", "Shared pineapple facts.", "global");
    await h.ask("pineapple?");
    const live = h.core.startTranscript("t");
    h.sockets[0]!.open();
    h.sockets[0]!.result("pineapple meeting", true, 0);
    h.core.stopTranscript();
    h.store.saveInsights(live.id, { summary: "x" });
    const fts0 = h.store.ftsCounts();
    expect(h.store.counts()).toMatchObject({ conversations: 1, messages: 2, transcripts: 1, knowledgeDocs: 2, contextItems: 1 });

    const keep = h.core.createSession({ title: "Keep", type: "general" }, false);
    h.core.deleteSession(victim);

    expect(h.store.getSession(victim)).toBeNull();
    expect(h.store.counts()).toMatchObject({ conversations: 0, messages: 0, transcripts: 0, knowledgeDocs: 1, contextItems: 0 });
    expect(h.store.getInsights(live.id)).toBeNull();
    const fts1 = h.store.ftsCounts();
    expect(fts1.messages).toBe(fts0.messages - 2);
    expect(fts1.segments).toBe(fts0.segments - 1);
    expect(fts1.chunks).toBe(fts0.chunks - 1);
    expect(h.store.search("pineapple", null)).toEqual([]);
    expect(h.store.listKnowledgeDocs(null).map((d) => d.id)).toEqual([global.id]);
    expect(h.core.engine.list(victim)).toEqual([]);
    expect(h.core.activeSessionId).toBe(keep.id);
  });

  it("deleting the only session leaves a fresh empty session active", () => {
    const h = harness();
    const only = h.core.activeSessionId;
    h.core.deleteSession(only);
    expect(h.core.activeSessionId).not.toBe(only);
    expect(h.store.listSessions()).toHaveLength(1);
  });
});
