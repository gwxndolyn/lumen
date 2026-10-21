# Changelog

## 0.1.0 — 2026-10-21
Initial release.
- Electron + React + TypeScript desktop app: floating overlay, full window, tray, global shortcuts.
- Anthropic Claude provider (official SDK): streaming, cancel, retry, refusal fallback, cost tracking. Labelled development-mode mock provider.
- Context pipeline:
  - sources: notes, clipboard, documents, screenshots and regions, knowledge base, history
  - BM25 ranking, dedupe, budgets, citations, prompt-injection hardening
- Live transcription via Deepgram: mic selection, optional system audio, reconnect with buffering, editable transcripts, schema-validated meeting notes.
- SQLite storage: migrations, FTS5 search, retention, export, delete-all.
- 11 screens:
  - onboarding, permissions, overlay, assistant
  - transcript, history, knowledge, capture
  - settings (general, provider, shortcuts, privacy)
  - diagnostics
- 82 automated tests plus an Electron UI smoke test.
