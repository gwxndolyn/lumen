// Test helpers: a fake Anthropic HTTP backend that speaks the real SSE wire format, so the
// provider is exercised through the official SDK end-to-end (no SDK mocking).

export interface FakeTurn {
  status?: number;
  headers?: Record<string, string>;
  /** Error body for non-200 responses. */
  error?: { type: string; message: string };
  text?: string[];
  stopReason?: string;
  /** Throw a network error instead of responding. */
  networkError?: boolean;
  /** Drop the connection after emitting N deltas. */
  dropAfter?: number;
  /** Delay between deltas (ms). */
  delayMs?: number;
  usage?: { input: number; output: number };
  fallbackTo?: string;
  /** Stall: emit the first N deltas, then go silent without closing. */
  stallAfter?: number;
  /** Replace the scripted text with a function of the request body (e.g. echo context). */
  respond?: (body: Record<string, unknown>) => string[];
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function fakeFetch(turns: FakeTurn[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) });
    const turn = turns[Math.min(i++, turns.length - 1)]!;
    if (turn.networkError) throw new TypeError("fetch failed");
    if (turn.status && turn.status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: turn.error ?? { type: "api_error", message: "boom" } }), {
        status: turn.status,
        headers: { "content-type": "application/json", ...turn.headers },
      });
    }
    const signal = init?.signal;
    const model = String(calls.at(-1)!.body.model ?? "claude-opus-5-5");
    const enc = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        controller = ctrl;
        const push = (s: string) => ctrl.enqueue(enc.encode(s));
        push(
          sse("message_start", {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: turn.usage?.input ?? 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
          }),
        );
        let index = 0;
        if (turn.fallbackTo) {
          push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "fallback", from: { model }, to: { model: turn.fallbackTo }, trigger: { type: "refusal" } } }));
          push(sse("content_block_stop", { type: "content_block_stop", index }));
          index++;
        }
        push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        let n = 0;
        const texts = turn.respond ? turn.respond(calls.at(-1)!.body) : (turn.text ?? []);
        for (const t of texts) {
          if (turn.stallAfter !== undefined && n >= turn.stallAfter) {
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            return;
          }
          if (signal?.aborted) return;
          if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
          if (signal?.aborted) return;
          push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } }));
          n++;
          if (turn.dropAfter !== undefined && n >= turn.dropAfter) {
            // Let already-sent bytes reach the client before the connection drops (erroring a
            // stream synchronously discards chunks still in its queue).
            await new Promise((r) => setTimeout(r, 20));
            ctrl.error(new TypeError("network connection lost"));
            return;
          }
        }
        push(sse("content_block_stop", { type: "content_block_stop", index }));
        push(sse("message_delta", { type: "message_delta", delta: { stop_reason: turn.stopReason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: turn.usage?.output ?? 20 } }));
        push(sse("message_stop", { type: "message_stop" }));
        ctrl.close();
      },
    });
    // Like real fetch: aborting the request errors the response body.
    signal?.addEventListener("abort", () => {
      try {
        controller?.error(new DOMException("The operation was aborted.", "AbortError"));
      } catch {
        /* already closed */
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
  };
  return { fetch: fn, calls };
}

export const noSleep = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => undefined };

/** Concatenated text of every user turn sent to the provider (for asserting what context was sent). */
export function sentText(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as { content: unknown }[];
  return msgs
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((p) => p.text ?? `[${p.type}]`).join("\n")))
    .join("\n");
}
