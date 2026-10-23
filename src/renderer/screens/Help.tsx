import { useState } from "react";
import { api, errMsg } from "../lib/api";

const go = (r: string) => (location.hash = `/main/${r}`);

const TOPICS: { q: string; a: React.ReactNode }[] = [
  {
    q: "What does Lumen do?",
    a: "Lumen is a desktop assistant. Press a shortcut to open a small panel and ask about what's on your screen, a document, your notes, or a meeting you're transcribing. It answers with the AI model you choose and shows which sources it used.",
  },
  {
    q: "Which AI can I use, and who pays for it?",
    a: (
      <>
        Your own Anthropic, OpenAI or Google Gemini API key (usage is billed by that provider to you), an OpenAI-compatible server, or a free local model through Ollama. Lumen doesn't resell AI usage.{" "}
        <button className="btn ghost sm" onClick={() => go("provider")}>
          AI provider settings
        </button>
      </>
    ),
  },
  {
    q: "“The API key was rejected” / “No API key is configured”",
    a: "Open AI provider settings, paste a new key, and press Test connection. Keys are created in your provider's console (console.anthropic.com, platform.openai.com, aistudio.google.com).",
  },
  {
    q: "“Rate limited”, “overloaded”, “timed out” or network errors",
    a: "These come from the provider or your connection. Lumen retries rate limits and outages a few times before showing the error; it doesn't resend timed-out requests automatically because they may already have been billed. Press Try again, or check the provider's status page.",
  },
  {
    q: "Screen capture is blank or blocked (macOS)",
    a: "Allow Lumen in System Settings → Privacy & Security → Screen Recording, then quit and reopen Lumen. macOS only applies the permission after a restart.",
  },
  {
    q: "Microphone or transcription doesn't work",
    a: "Allow Lumen under System Settings → Privacy & Security → Microphone (macOS) or Settings → Privacy & security → Microphone (Windows). Live transcription needs a Deepgram API key in AI provider settings.",
  },
  {
    q: "Local model: “Ollama is not running” or “model not installed”",
    a: "Install Ollama from ollama.com and start it. Install a model yourself in a terminal, e.g. `ollama pull llama3.2`; Lumen never downloads models. Then press Check in AI provider → Local model.",
  },
  {
    q: "“Privacy restriction keeps … on this device”",
    a: "You've chosen to keep screen content, transcripts or documents off cloud providers. Set up a local model, remove that context from the question, or allow it under AI provider → Privacy restriction.",
  },
  {
    q: "A spend, request or session limit was reached",
    a: "These are limits you set to protect your provider bill. Lumen never switches to another paid provider when one is reached. Raise or remove them in AI provider → Usage limits.",
  },
  {
    q: "Where is my data, and what leaves my computer?",
    a: (
      <>
        Conversations, notes, transcripts, memories and settings are stored only on this computer. A question and the context you attach go to the AI provider you chose (nowhere, with a local model);
        audio goes to Deepgram only while you record. Lumen has no account, no telemetry and no server of its own.{" "}
        <button className="btn ghost sm" onClick={() => go("privacy")}>
          Privacy &amp; data
        </button>
      </>
    ),
  },
  {
    q: "Is Lumen hidden in screen shares?",
    a: "No. Lumen is a normal visible window. Follow the rules of your meetings, interviews and exams, and tell people when you're transcribing.",
  },
  {
    q: "My license key doesn't work",
    a: (
      <>
        Paste the whole key from your purchase email, starting with LUMEN1. Licenses are checked on this computer; if one expires, Pro features turn off but nothing you saved is affected.{" "}
        <button className="btn ghost sm" onClick={() => go("plan")}>
          Plan &amp; updates
        </button>
      </>
    ),
  },
  {
    q: "Updating Lumen",
    a: "Use Plan & updates → Check for updates, then download and install the new version. Settings and data are kept because they live in Lumen's data folder, not in the app.",
  },
  {
    q: "Supported systems",
    a: "macOS 12 or newer is the supported platform. Windows 10/11 builds are available as a preview: they pass automated tests but haven't been fully tested by hand yet. Linux isn't supported.",
  },
];

export function HelpScreen() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <header className="page-header">
        <h1>Help</h1>
      </header>
      <div className="page narrow">
        <div className="card">
          <h3>Reporting a problem</h3>
          <p className="small muted">
            Save a support file and attach it to your report. It contains the app version, your OS, settings that affect behaviour, error counts and recent log lines — no questions, answers,
            documents, screenshots, transcripts or API keys. You can open it in any text editor before sending it.
          </p>
          <div className="row">
            <button
              className="btn"
              onClick={() =>
                void api
                  .saveSupportBundle()
                  .then((p) => p && setNotice(`Saved to ${p}.`))
                  .catch((e) => setError(errMsg(e)))
              }
            >
              Save support file
            </button>
            <button className="btn ghost" onClick={() => go("diagnostics")}>
              Diagnostics
            </button>
          </div>
          {notice && (
            <div className="alert info small" style={{ marginTop: 8 }}>
              {notice}
            </div>
          )}
          {error && (
            <div className="alert error small" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
        {TOPICS.map((t) => (
          <details className="card" key={t.q}>
            <summary style={{ cursor: "pointer", fontWeight: 500 }}>{t.q}</summary>
            <div className="small" style={{ marginTop: 8 }}>
              {t.a}
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
