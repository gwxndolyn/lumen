import { useEffect, useState } from "react";
import type { SecretsStatus, Settings } from "../../shared/types";
import { api, errMsg, prettyAccelerator } from "../lib/api";
import { PROVIDER_INFO } from "../../shared/defaults";
import { PermissionList } from "./Permissions";

type Props = { settings: Settings; update: (p: unknown) => Promise<void>; onDone: () => void };

export function OnboardingScreen({ settings, update, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<"anthropic" | "openai" | "gemini">("anthropic");
  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    void api.secretsStatus().then(setSecrets);
    void api.appInfo().then((i) => setDevMode(i.devModeAllowed));
  }, []);

  const finish = async () => {
    await update({ onboardingComplete: true });
    onDone();
    void api.overlay("toggle");
  };

  return (
    <div className="page" style={{ display: "flex", justifyContent: "center", paddingTop: 60 }}>
      <div style={{ width: 620 }}>
        <div className="steps" aria-label={`Step ${step + 1} of 4`}>
          {[0, 1, 2, 3].map((i) => (
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
              Lumen is a visible assistant, not a stealth tool. Its panel appears in screen shares like any other window. Follow the rules of your meetings, interviews and exams, and tell people when you are transcribing.
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
              Bring your own API key. It is encrypted with your OS credential store and only used by Lumen's main process to talk to the provider you choose.
            </p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {(["anthropic", "openai", "gemini"] as const).map((k) => (
                <button key={k} className={`btn ${provider === k ? "primary" : ""}`} onClick={() => setProvider(k)}>
                  {PROVIDER_INFO[k].label}
                  {secrets?.[k] ? " ✓" : ""}
                </button>
              ))}
            </div>
            {secrets?.[provider] ? (
              <div className="alert info">✓ A {PROVIDER_INFO[provider].label} key is configured.</div>
            ) : (
              <div className="row">
                <input className="input mono" type="password" placeholder={`${PROVIDER_INFO[provider].label} API key`} aria-label={`${PROVIDER_INFO[provider].label} API key`} value={key} onChange={(e) => setKey(e.target.value)} />
                <button
                  className="btn primary"
                  disabled={!key.trim()}
                  onClick={() =>
                    void api
                      .setSecret(provider, key)
                      .then(async (sec) => {
                        setSecrets(sec);
                        setKey("");
                        setError(null);
                        await update({ provider: { kind: provider } });
                      })
                      .catch((e) => setError(errMsg(e)))
                  }
                >
                  Save key
                </button>
              </div>
            )}
            <div className="small faint">
              Get a key at {PROVIDER_INFO[provider].keyUrl.replace("https://", "")}. Local or self-hosted models (Ollama, LM Studio) can be set up later in Settings → AI provider.
            </div>
            {error && <div className="alert error small">{error}</div>}
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <span className="spacer" />
              {!secrets?.[provider] && (
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
                disabled={!secrets?.[provider]}
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
            <h2 style={{ margin: 0 }}>You're ready</h2>
            <div className="card">
              <dl className="kv">
                <dt>Show / hide assistant</dt>
                <dd>{prettyAccelerator(settings.shortcuts.toggleOverlay)}</dd>
                <dt>Ask about screen</dt>
                <dd>{prettyAccelerator(settings.shortcuts.askAboutScreen)}</dd>
                <dt>Open full window</dt>
                <dd>{prettyAccelerator(settings.shortcuts.openMainWindow)}</dd>
              </dl>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Lumen lives in your menu bar / system tray. Shortcuts can be changed in Settings → Shortcuts.
            </p>
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(2)}>
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
