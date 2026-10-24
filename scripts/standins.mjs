// Local stand-ins for external services used ONLY by the smoke test:
//  - an Anthropic Messages API–compatible SSE server (answers by quoting the context it received)
//  - a Deepgram live-API–compatible WebSocket server (scripted transcript results)
// They speak the real wire formats so Lumen's real SDK/WebSocket clients are exercised.
import http from "node:http";
import { WebSocketServer } from "ws";

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * Project-agent stand-in: decides the next action from what Lumen reported back (like a model
 * would), so the smoke test drives the real loop — plan, run the failing test, read the source,
 * propose the fix, then finish. It never claims anything happened; Lumen's observations do.
 */
function agentAction(prompt) {
  const a = (thought, action) => JSON.stringify({ thought, action });
  if (/<plan>\n\(no plan yet\)/.test(prompt))
    return a("Plan the investigation", {
      type: "update_plan",
      steps: [
        { title: "Reproduce the failure", dependsOn: [] },
        { title: "Find the root cause", dependsOn: [0] },
        { title: "Fix and re-test", dependsOn: [1] },
      ],
    });
  if (!/run_command/.test(prompt)) return a("Run the tests to see the failure", { type: "run_command", argv: ["node", "test.js"], reason: "Reproduce the failing test" });
  if (!/read_file src\/math\.js/.test(prompt)) return a("Read the function under test", { type: "read_file", path: "src/math.js" });
  if (!/propose_edit/.test(prompt)) return a("add() subtracts; fix it", { type: "propose_edit", path: "src/math.js", content: "exports.add = (a, b) => a + b;\n", reason: "add() used subtraction" });
  if (/\[todo\]|\[doing\]/.test(prompt)) {
    const i = (prompt.match(/^(\d+)\. \[(todo|doing)\]/m) ?? [])[1];
    return a("Record progress", { type: "set_step", stepIndex: Number(i ?? 0), status: "done" });
  }
  return a("Fix applied; verification will confirm", { type: "finish", summary: "add() subtracted instead of adding", findings: ["src/math.js: add used `-`"] });
}

function answerFor(body) {
  if (/You are Lumen's project agent/.test(JSON.stringify(body.system))) {
    const last = body.messages.at(-1);
    return agentAction(typeof last.content === "string" ? last.content : last.content.map((p) => p.text ?? "").join("\n"));
  }
  const last = body.messages.at(-1);
  const text = typeof last.content === "string" ? last.content : last.content.map((p) => p.text ?? "").join("\n");
  const q = /<question>\n([\s\S]*?)\n<\/question>/.exec(text)?.[1] ?? "";
  if (/Reply with the single word/.test(JSON.stringify(body.system))) return "ready";
  const m = (re) => re.exec(text)?.[0];
  if (/invoice/i.test(q)) {
    const total = m(/\$\d[\d,]*\.\d\d/);
    return total ? `The total due is ${total} [C1], due ${m(/November \d+/) ?? "(date not visible)"} [C1].` : "I don't see an invoice in the provided context.";
  }
  if (/launch/i.test(q)) return /thursday/i.test(text) ? "Transcript: the team agreed to launch on Thursday [C1]." : "There is no transcript in context.";
  if (/drop the connection/i.test(q)) return "DROP:" + Array.from({ length: 40 }, (_, i) => `part${i} `).join("");
  if (/explain this code/i.test(q)) return "This function returns the unique values:\n\n```js\nconst uniq = (xs) => [...new Set(xs)];\n```\n\nIt keeps first occurrences [C1].";
  if (/slowly/i.test(q)) return Array.from({ length: 80 }, (_, i) => `word${i}${i % 8 === 7 ? "\n\n" : " "}`).join("");
  return "General knowledge: here is an answer.";
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (!req.url.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw || "{}");
    // Credential behaviour of the real API, so the app's error paths are exercised end to end.
    const key = req.headers["x-api-key"];
    if (key === "sk-ant-smoke-invalid-key-0000") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    if (key === "sk-ant-smoke-quota-key-00000") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "quota exceeded" } }));
      return;
    }
    if (body.model === "claude-does-not-exist") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model not found" } }));
      return;
    }
    const text = answerFor(body);
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_standin" });
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_s",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const slow = /word0/.test(text);
    const drop = text.startsWith("DROP:");
    let sentPieces = 0;
    for (const piece of (drop ? text.slice(5) : text).match(/.{1,12}/gs) ?? []) {
      if (res.destroyed) return;
      // Simulate a network drop mid-stream: close the socket after some text has streamed.
      if (drop && ++sentPieces > 6) {
        res.socket?.destroy();
        return;
      }
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
      await new Promise((r) => setTimeout(r, slow ? 120 : 15));
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
});

const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has("token") ? "token" : false) });
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/v1/listen")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    let bytes = 0;
    let sent = 0;
    const script = [
      ["We should launch the product on Thursday.", 0, 0],
      ["Agreed, Thursday works for marketing.", 3, 1],
    ];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      bytes += data.length;
      // After ~0.5 s of audio per line, emit an interim then a final result.
      while (sent < script.length && bytes >= (sent + 1) * 16000) {
        const [t, start, spk] = script[sent++];
        const msg = (final) => JSON.stringify({ type: "Results", is_final: final, start, duration: 2, channel: { alternatives: [{ transcript: t, confidence: 0.94, words: [{ speaker: spk }] }] } });
        ws.send(msg(false));
        ws.send(msg(true));
      }
    });
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(JSON.stringify({ anthropic: `http://127.0.0.1:${port}`, deepgram: `ws://127.0.0.1:${port}/v1/listen` }));
});
