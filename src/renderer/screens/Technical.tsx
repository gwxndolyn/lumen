import { useEffect, useRef, useState } from "react";
import type { ParsedProblemView } from "../../shared/api";
import type { Settings } from "../../shared/types";
import { api } from "../lib/api";
import { isRecordingStatus, useChat, useContextItems, type LiveTranscript } from "../lib/hooks";
import { ContextChips, Empty, MessageView, useAction } from "../components/ui";

const LANGS = [
  ["python", "Python"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["cpp", "C++"],
  ["sql", "SQL"],
  ["go", "Go"],
  ["csharp", "C#"],
  ["kotlin", "Kotlin"],
  ["rust", "Rust"],
] as const;

type Task = "solve" | "explain" | "debug" | "review" | "tests" | "complexity" | "refactor" | "hints";
const TASKS: { id: Task; label: string; needsCode?: boolean }[] = [
  { id: "solve", label: "Solve" },
  { id: "hints", label: "Hints only" },
  { id: "explain", label: "Explain code", needsCode: true },
  { id: "debug", label: "Debug", needsCode: true },
  { id: "review", label: "Review", needsCode: true },
  { id: "tests", label: "Tests" },
  { id: "complexity", label: "Complexity" },
  { id: "refactor", label: "Refactor", needsCode: true },
];

type Permission = "unknown" | "allowed" | "practice";

export function TechnicalScreen({ settings, update, live }: { settings: Settings; update: (p: unknown) => Promise<void>; live: LiveTranscript }) {
  const chat = useChat(settings, { restore: false });
  const items = useContextItems();
  const [problem, setProblem] = useState("");
  const [request, setRequest] = useState("");
  const [parsed, setParsed] = useState<ParsedProblemView | null>(null);
  const [permission, setPermission] = useState<Permission>("unknown");
  const { error } = useAction();
  const scrollRef = useRef<HTMLDivElement>(null);
  const screenText = items.some((i) => (i.source === "screenshot" || i.source === "ocr") && i.chars > 0 && i.status === "active");
  const recording = isRecordingStatus(live.status) && !live.elsewhere;

  // Re-parse locally as the user types or when a capture's text arrives.
  useEffect(() => {
    const t = setTimeout(() => void api.analyzeProblem(problem).then(setParsed), 250);
    return () => clearTimeout(t);
  }, [problem, screenText]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.messages]);

  const go = (task: Task) => {
    if (chat.busy) return;
    if (permission === "practice" && task !== "hints" && task !== "explain" && task !== "complexity") return;
    const label = TASKS.find((t) => t.id === task)!.label;
    void chat.send(request.trim() || `${label}${parsed?.title ? ` — ${parsed.title}` : ""}`, {
      includeLiveTranscript: recording,
      mode: { kind: "technical", task, language: settings.technical.language, problem: problem.trim() || undefined },
      label,
    });
    setRequest("");
  };

  return (
    <>
      <header className="page-header">
        <h1>Technical Assessment</h1>
        <span className="spacer" />
        <select className="select" style={{ width: 150 }} aria-label="Language" value={settings.technical.language} onChange={(e) => void update({ technical: { language: e.target.value } })}>
          {LANGS.map(([id, l]) => (
            <option key={id} value={id}>
              {l}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => (location.hash = "/main/capture")} disabled={!settings.consent.screen} title={settings.consent.screen ? "Capture the problem from your screen" : "Enable screen context in Permissions"}>
          ▣ Capture problem
        </button>
      </header>
      {permission === "unknown" && (
        <div className="alert info" style={{ margin: "10px 24px 0" }}>
          <strong>Is AI assistance allowed for this assessment?</strong> Many coding assessments forbid outside help. Lumen will give full solutions only when you confirm it's permitted; otherwise it stays in practice mode (hints, explanations, complexity — no solutions).
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" onClick={() => setPermission("allowed")}>
              Yes — AI help is permitted / this is my own practice
            </button>
            <button className="btn sm" onClick={() => setPermission("practice")}>
              Not permitted — practice mode only
            </button>
          </div>
        </div>
      )}
      <div className="workspace" style={{ flex: 1 }}>
        <div className="pane col" style={{ gap: 10 }}>
          <label className="col" style={{ gap: 4 }}>
            <span className="small" style={{ fontWeight: 600 }}>
              Problem or code
            </span>
            <textarea
              className="textarea mono"
              style={{ minHeight: 220, fontSize: 12 }}
              placeholder={screenText ? "Leave empty to use the text read from your screen capture, or paste here." : "Paste the problem statement, examples, constraints and any starter code (use ``` fences for code)."}
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
            />
          </label>
          {parsed && parsed.source !== "none" && (
            <div className="card" style={{ margin: 0 }}>
              <h3 style={{ marginBottom: 4 }}>
                Extracted {parsed.source === "screen" && <span className="badge">from screen (OCR)</span>}
              </h3>
              <dl className="req-list" style={{ margin: 0 }}>
                {parsed.title && (
                  <>
                    <dt>Title</dt>
                    <dd>{parsed.title}</dd>
                  </>
                )}
                <dt>Kind</dt>
                <dd>{parsed.kind.replace("_", " ")}{parsed.detectedLanguage ? ` · starter code in ${parsed.detectedLanguage}` : ""}</dd>
                <dt>Constraints</dt>
                <dd>{parsed.constraints.length ? parsed.constraints.map((c) => <div key={c}><code>{c}</code></div>) : <span className="faint">none found</span>}</dd>
                <dt>Examples</dt>
                <dd>{parsed.examples.length ? `${parsed.examples.length} found` : <span className="faint">none found</span>}</dd>
                {parsed.complexityHint && (
                  <>
                    <dt>Target</dt>
                    <dd>{parsed.complexityHint.replace("Inference from constraints: ", "")}</dd>
                  </>
                )}
              </dl>
              {parsed.missing.length > 0 && (
                <div className="alert warning small" style={{ marginTop: 8 }}>
                  Missing: {parsed.missing.join("; ")}. Add it for a reliable answer — Lumen will label any assumptions.
                </div>
              )}
            </div>
          )}
          {recording && <div className="small muted">Live transcript is on: spoken clarifications from the interviewer are combined with the written problem.</div>}
          <ContextChips items={items} />
        </div>
        <div className="pane" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
            {chat.messages.length ? (
              <div className="thread">
                {chat.messages.map((m) => (
                  <MessageView key={m.id} m={m} onCopy={(t) => void api.copyText(t)} />
                ))}
              </div>
            ) : (
              <Empty title="Work through a problem">
                Paste or capture a problem, pick a language, then choose what you need. Lumen extracts the requirements, explains the approach and complexity, and writes code — it never runs code.
              </Empty>
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--border)", padding: "10px 18px" }} className="col">
            {error && <div className="alert error small">{error}</div>}
            <div className="row" style={{ flexWrap: "wrap" }}>
              {TASKS.map((t) => {
                const blocked = permission === "practice" && !["hints", "explain", "complexity"].includes(t.id);
                return (
                  <button
                    key={t.id}
                    className={`btn sm ${t.id === (permission === "practice" ? "hints" : "solve") ? "primary" : ""}`}
                    disabled={chat.busy || permission === "unknown" || blocked || (!problem.trim() && !parsed?.statement && !request.trim())}
                    title={blocked ? "Not available in practice mode" : undefined}
                    onClick={() => go(t.id)}
                  >
                    {t.label}
                  </button>
                );
              })}
              {chat.busy && (
                <button className="btn danger sm" onClick={chat.cancel}>
                  ■ Stop
                </button>
              )}
            </div>
            <input
              className="input"
              aria-label="Follow-up"
              placeholder="Follow-up (e.g. “can it be done in O(1) space?”, “my test [1,1] fails”) — Enter to ask"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && request.trim() && !chat.busy) {
                  // In practice mode follow-ups stay hint-only too.
                  if (permission === "practice") go("hints");
                  else {
                    void chat.send(request.trim(), { includeLiveTranscript: recording, style: "technical" });
                    setRequest("");
                  }
                }
              }}
            />
            {permission === "practice" && <div className="small faint">Practice mode: solutions and code generation are off for this assessment.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
