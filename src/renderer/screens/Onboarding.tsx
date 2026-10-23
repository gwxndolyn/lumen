import { useEffect, useState } from "react";
import type { LocalState } from "../../shared/api";
import type { ProviderTestResult, SecretsStatus, Settings } from "../../shared/types";
import { describeTest } from "../lib/providerTest";
import { MessageView, Segmented } from "../components/ui";
import { useChat } from "../lib/hooks";
import { api, errMsg, prettyAccelerator } from "../lib/api";
import { PROVIDER_INFO } from "../../shared/defaults";
import { PermissionList } from "./Permissions";

type Props = { settings: Settings; update: (p: unknown) => Promise<void>; onDone: () => void };

export function OnboardingScreen({ settings, update, onDone }: Props) {
  // Resume where the user left off (persisted in settings).
  const [step, setStepState] = useState(Math.min(settings.onboardingStep ?? 0, STEPS - 1));
  const setStep = (n: number) => {
    setStepState(n);
    void update({ onboardingStep: n });
  };
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<"anthropic" | "openai" | "gemini" | "ollama">(settings.provider.kind === "ollama" ? "ollama" : "anthropic");
  const [local, setLocal] = useState<LocalState | null>(null);
  const [checkingLocal, setCheckingLocal] = useState(false);
  const checkLocal = () => {
    setCheckingLocal(true);
    void api
      .localStatus()
      .then(setLocal)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setCheckingLocal(false));
  };
  const [devMode, setDevMode] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | "running" | null>(null);
  const runTest = async () => {
    setTest("running");
    setTest(await api.testProvider());
  };
  useEffect(() => {
    void api.secretsStatus().then(setSecrets);
    void api.appInfo().then((i) => setDevMode(i.devModeAllowed));
  }, []);

  const finish = async () => {
    await update({ onboardingComplete: true, onboardingStep: 0 });
    onDone();
    void api.overlay("toggle");
  };

  return (
    <div className="page" style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}>
      <div style={{ width: 620 }}>
        <div className="steps" aria-label={`Step ${step + 1} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => i).map((i) => (
            <span key={i} className={i <= step ? "done" : ""} />
          ))}
        </div>

        {step === 0 && (
          <div className="col" style={{ gap: 16 }}>
            <div className="brand" style={{ fontSize: 22 }}>
              <span className="brand-mark" style={{ width: 22, height: 22 }} /> Welcome to Lumen
            </div>
            <p className="muted" style={{ fontSize: 15, margin: 0 }}>
              A fast desktop assistant that answers questions about what is on your screen, your documents and your meetings — without leaving what you are doing.
            </p>
            <div className="card">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>Press a shortcut to open a floating panel and ask anything.</li>
                <li>Attach a screenshot, region, clipboard text, documents or notes.</li>
                <li>Record a live transcript and get summaries, action items and suggested replies.</li>
                <li>You stay in control: nothing is captured unless you ask, and everything is stored locally.</li>
              </ul>
            </div>
            <div className="alert info small">
              Lumen is a visible assistant, not a stealth tool. Its panel appears in screen shares like any other window. Follow the rules of your meetings, interviews and exams, and tell people when
              you are transcribing.
            </div>
            <div className="row">
              <span className="spacer" />
              <button className="btn primary" onClick={() => setStep(1)}>
                Get started
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="col" style={{ gap: 16 }}>
            <h2 style={{ margin: 0 }}>Connect an AI model</h2>
            <p className="muted" style={{ margin: 0 }}>
              Use your own API key — usage is billed to your account with that provider, not by Lumen — or a free local model that runs on this computer.
            </p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {(["anthropic", "openai", "gemini"] as const).map((k) => (
                <button key={k} className={`btn ${provider === k ? "primary" : ""}`} onClick={() => setProvider(k)}>
                  {PROVIDER_INFO[k].label}
                  {secrets?.[k] ? " ✓" : ""}
                </button>
              ))}
              <button
                className={`btn ${provider === "ollama" ? "primary" : ""}`}
                onClick={() => {
                  setProvider("ollama");
                  checkLocal();
                }}
              >
                Local model (Ollama)
              </button>
            </div>
            {provider === "ollama" ? (
              <LocalSetup
                settings={settings}
                update={update}
                local={local}
                checking={checkingLocal}
                onCheck={checkLocal}
                test={test}
                onTest={() => void update({ provider: { kind: "ollama" } }).then(runTest)}
              />
            ) : secrets?.[provider] ? (
              <div className="col" style={{ gap: 8 }}>
                <div className="row">
                  <div className="alert info" style={{ flex: 1, margin: 0 }}>
                    ✓ A {PROVIDER_INFO[provider as "anthropic"].label} key is saved.
                  </div>
                  <button className="btn" disabled={test === "running"} onClick={() => void update({ provider: { kind: provider } }).then(runTest)}>
                    {test === "running" ? <span className="spinner" /> : null} Test connection
                  </button>
                </div>
                {test && test !== "running" && (
                  <div className={`alert ${test.ok ? "info" : "error"} small`} role="status" style={{ margin: 0 }}>
                    <strong>{describeTest(test).title}:</strong> {describeTest(test).detail}
                    {describeTest(test).next && <div>{describeTest(test).next}</div>}
                  </div>
                )}
                <div className="small faint">
                  The test sends one tiny request to {PROVIDER_INFO[provider as keyof typeof PROVIDER_INFO].host}. Every question you ask is billed by{" "}
                  {PROVIDER_INFO[provider as keyof typeof PROVIDER_INFO].label} to your key; set a daily limit in Settings → AI provider.
                </div>
              </div>
            ) : (
              <div className="row">
                <input
                  className="input mono"
                  type="password"
                  placeholder={`${PROVIDER_INFO[provider as "anthropic"].label} API key`}
                  aria-label={`${PROVIDER_INFO[provider as "anthropic"].label} API key`}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button
                  className="btn primary"
                  disabled={!key.trim()}
                  onClick={() =>
                    void api
                      .setSecret(provider as "anthropic", key)
                      .then(async (sec) => {
                        setSecrets(sec);
                        setKey("");
                        setError(null);
                        await update({ provider: { kind: provider } });
                        await runTest();
                      })
                      .catch((e) => setError(errMsg(e)))
                  }
                >
                  Save key
                </button>
              </div>
            )}
            {provider !== "ollama" && <div className="small faint">Get a key at {PROVIDER_INFO[provider as "anthropic"].keyUrl.replace("https://", "")}.</div>}
            {error && <div className="alert error small">{error}</div>}
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <span className="spacer" />
              {!(provider === "ollama" ? test && test !== "running" && test.ok : secrets?.[provider as "anthropic"]) && (
                <button
                  className="btn"
                  onClick={() => {
                    if (devMode) void update({ provider: { kind: "mock" } });
                    setStep(2);
                  }}
                  title={devMode ? "Answers will be clearly labelled mock responses" : "You can add a key later in Settings → AI provider"}
                >
                  {devMode ? "Skip — use development mode" : "Skip for now"}
                </button>
              )}
              <button
                className="btn primary"
                disabled={provider === "ollama" ? !(test && test !== "running" && test.ok) : !secrets?.[provider as "anthropic"]}
                onClick={() => {
                  void update({ provider: { kind: provider } });
                  setStep(2);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="col" style={{ gap: 16 }}>
            <h2 style={{ margin: 0 }}>Choose what Lumen may use</h2>
            <p className="muted" style={{ margin: 0 }}>
              All sources are off until you turn them on. You can change these at any time in Permissions.
            </p>
            <div className="card">
              <PermissionList settings={settings} update={update} />
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="col" style={{ gap: 16 }}>
            <h2 style={{ margin: 0 }}>How should answers look?</h2>
            <p className="muted" style={{ margin: 0 }}>
              You can change these any time in Settings → General → Answers, or switch depth from the panel.
            </p>
            <div className="card">
              <div className="field">
                <div>
                  <div className="label">Answer depth</div>
                  <div className="hint">Quick is best for a small floating panel.</div>
                </div>
                <Segmented
                  label="Answer depth"
                  value={settings.personalization.depth}
                  options={[
                    { value: "quick", label: "Quick" },
                    { value: "balanced", label: "Balanced" },
                    { value: "deep", label: "Deep" },
                  ]}
                  onChange={(v) => void update({ personalization: { depth: v } })}
                />
              </div>
              <div className="field">
                <label htmlFor="ob-lang">Preferred programming language</label>
                <select id="ob-lang" className="select" value={settings.technical.language} onChange={(e) => void update({ technical: { language: e.target.value } })}>
                  {[
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
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <div className="label">Experience level</div>
                <Segmented
                  label="Experience level"
                  value={settings.technical.level}
                  options={[
                    { value: "junior", label: "Junior" },
                    { value: "mid", label: "Mid" },
                    { value: "senior", label: "Senior" },
                  ]}
                  onChange={(v) => void update({ technical: { level: v } })}
                />
              </div>
            </div>
            <div className="card">
              <h3>Your data</h3>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Conversations, notes and transcripts are stored only on this computer.</li>
                <li>Questions and the context you attach are sent to the AI provider you chose; audio goes to Deepgram only while you record.</li>
                <li>Screen captures are never saved to disk and expire after {settings.privacy.screenContextTtlMinutes} minutes.</li>
                <li>
                  Conversations are deleted after {settings.privacy.conversationRetentionDays || "∞"} days and transcripts after {settings.privacy.transcriptRetentionDays || "∞"} days. Change this in
                  Privacy &amp; data.
                </li>
              </ul>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setStep(4)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 4 && <FirstQuestion settings={settings} onBack={() => setStep(3)} onNext={() => setStep(5)} />}

        {step === 5 && (
          <div className="col" style={{ gap: 16 }}>
            <h2 style={{ margin: 0 }}>You're ready</h2>
            <div className="card">
              <dl className="kv">
                <dt>Get AI help</dt>
                <dd>{prettyAccelerator(settings.shortcuts.requestAssist)}</dd>
                <dt>Stop answer</dt>
                <dd>{prettyAccelerator(settings.shortcuts.cancelResponse)}</dd>
                <dt>Show / hide assistant</dt>
                <dd>{prettyAccelerator(settings.shortcuts.toggleOverlay)}</dd>
                <dt>Ask about screen</dt>
                <dd>{prettyAccelerator(settings.shortcuts.askAboutScreen)}</dd>
                <dt>Open full window</dt>
                <dd>{prettyAccelerator(settings.shortcuts.openMainWindow)}</dd>
              </dl>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Lumen lives in your menu bar / system tray.{" "}
              <button className="btn ghost sm" onClick={() => void update({ onboardingComplete: true, onboardingStep: 0 }).then(() => (location.hash = "/main/shortcuts"))}>
                Customize shortcuts
              </button>{" "}
              Help and troubleshooting are under <strong>Help</strong> in the sidebar.
            </p>
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(4)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void finish()}>
                Open the assistant
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STEPS = 6;

function LocalSetup({
  settings,
  update,
  local,
  checking,
  onCheck,
  test,
  onTest,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  local: LocalState | null;
  checking: boolean;
  onCheck: () => void;
  test: ProviderTestResult | "running" | null;
  onTest: () => void;
}) {
  const up = !!local?.status?.available;
  const models = local?.status?.models ?? [];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="small muted">
        Runs on this computer, so nothing you ask leaves it. Install Ollama from ollama.com, then install a model yourself — for example <span className="mono">ollama pull llama3.2</span> (about 2 GB,
        needs ~4 GB free memory). Lumen never downloads models. Local models are slower and less capable than cloud models, especially for coding.
      </div>
      <div className="row">
        <button className="btn" disabled={checking} onClick={onCheck}>
          {checking ? <span className="spinner" /> : null} Check for Ollama
        </button>
        {local && (
          <span className={`small ${up ? "" : "faint"}`}>
            {up ? `Ollama is running · ${models.length} model${models.length === 1 ? "" : "s"} installed` : `Not found: ${local.status?.error ?? ""}`}
          </span>
        )}
      </div>
      {up && models.length === 0 && (
        <div className="alert warning small">
          No models installed yet. Run <span className="mono">ollama pull llama3.2</span> in a terminal, then Check again.
        </div>
      )}
      {up && models.length > 0 && (
        <div className="row">
          <select className="select" aria-label="Local model" value={settings.inference.local.model} onChange={(e) => void update({ inference: { local: { model: e.target.value } } })}>
            <option value="">Choose a model…</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!settings.inference.local.model || test === "running"} onClick={onTest}>
            {test === "running" ? <span className="spinner" /> : null} Test
          </button>
        </div>
      )}
      {test && test !== "running" && (
        <div className={`alert ${test.ok ? "info" : "error"} small`} role="status">
          {test.message}
        </div>
      )}
    </div>
  );
}

/** A real first question through the configured provider, so setup is proven end to end. */
function FirstQuestion({ settings, onBack, onNext }: { settings: Settings; onBack: () => void; onNext: () => void }) {
  const chat = useChat(settings, { restore: false });
  const [text, setText] = useState("In two sentences, what can you help me with on my desktop?");
  const answered = chat.messages.some((m) => m.role === "assistant" && m.status === "done");
  const failed = chat.messages.find((m) => m.role === "assistant" && m.status === "error");
  return (
    <div className="col" style={{ gap: 16 }}>
      <h2 style={{ margin: 0 }}>Try a first question</h2>
      <p className="muted" style={{ margin: 0 }}>
        This goes to {settings.provider.kind === "ollama" ? "your local model" : "your AI provider"} like any other question{settings.provider.kind === "ollama" ? "" : " and is billed to your key"}.
        You can skip it.
      </p>
      <div className="row">
        <input
          className="input"
          aria-label="First question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text.trim() && void chat.send(text, { includeLiveTranscript: false })}
        />
        <button className="btn primary" disabled={chat.busy || !text.trim()} onClick={() => void chat.send(text, { includeLiveTranscript: false })}>
          Ask
        </button>
      </div>
      <div className="col">
        {chat.messages.map((m) => (
          <MessageView key={m.id} m={m} onCopy={(t) => void api.copyText(t)} />
        ))}
      </div>
      {failed && <div className="small muted">Fix the problem above (Settings → AI provider has the details), or skip this step and come back later.</div>}
      <div className="row">
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <span className="spacer" />
        <button className={`btn ${answered ? "primary" : ""}`} onClick={onNext}>
          {answered ? "Continue" : "Skip"}
        </button>
      </div>
    </div>
  );
}
