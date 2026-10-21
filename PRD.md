# Product Requirements — Lumen

## Vision
A fast, unobtrusive desktop assistant that grounds answers in context the user explicitly provides: screen, documents, notes, clipboard and live meeting transcripts. The user stays in full control of capture and retention.

## Users & jobs
- **Knowledge worker in meetings**: follow along, catch action items, get suggested replies and a follow-up email.
- **Job seeker**: practise interviews with STAR structure, using their résumé and the job description as knowledge.
- **Engineer / learner**: ask about code or a diagram on screen and get step-by-step explanations.

## Non-goals (explicit)
- Hiding from screen sharing, proctoring or monitoring software. No content protection, process disguise or covert capture.
- Running model-generated commands.
- Cloud sync and accounts (deferred; local-first).

## Epics, stories and acceptance criteria

| # | Epic / story | Acceptance criteria | Status |
|---|---|---|---|
| E1 | **Desktop shell** | | |
| 1.1 | Toggle a floating panel with a global shortcut | Shortcut shows/hides the panel; it opens on the cursor's display; registration failure is shown in Settings | Done |
| 1.2 | Full window with history and settings | Sidebar navigation across 11 screens; deep links via tray | Done |
| 1.3 | Preferences persist | Settings validated (zod); corrupt values repaired per section | Done |
| E2 | **Core AI** | | |
| 2.1 | Streaming answers | Tokens render as they arrive; TTFT measured | Done |
| 2.2 | Cancel and retry | Esc/Stop aborts the HTTP stream; the partial answer is kept and marked *Stopped*; Retry regenerates without duplicating the question | Done |
| 2.3 | Modes, length, tone | 5 modes (general, meeting, interview, technical, coding), short/detailed, 4 tones | Done |
| 2.4 | Errors are actionable | Missing key, auth, rate limit, network, refusal and too-large each get a specific message | Done |
| E3 | **Context** | | |
| 3.1 | Notes, clipboard, documents (txt/md/pdf/html/code) | Each added only on explicit user action; shown as chips; can be toggled or removed | Done |
| 3.2 | Screenshot / window / region capture | Only when consented and requested; in memory only; 15-min TTL unless pinned | Done |
| 3.3 | Knowledge base | Import or write docs; chunked; FTS5 retrieval; deletable | Done |
| 3.4 | Grounding and citations | Context ranked (BM25 + recency + kind); bounded budget; answers cite `[C1]` with hover excerpts | Done |
| E4 | **Audio / meetings** | | |
| 4.1 | Live transcript | Mic selection, optional system audio, interim + final segments, speaker labels, pause/resume/stop, always-visible REC state | Done (needs Deepgram key) |
| 4.2 | Reconnect | Audio buffered (≤30 s) during drops, exponential reconnect, auth failure stops cleanly | Done |
| 4.3 | Editable transcript | Edit text/speaker, delete segments, rename/delete sessions | Done |
| 4.4 | Meeting notes | Summary, key points, action items, questions, suggested responses, follow-up email; schema-validated; each section labelled Summary / Suggestion / Draft | Done |
| 4.5 | Ask about the meeting | Live transcript optionally included as context | Done |
| E5 | **Privacy** | Retention for conversations and transcripts; export JSON; delete all; no telemetry | Done |
| E6 | **Diagnostics** | Health checks, measured TTFT / latency / error rate / cost / memory / CPU, redacted report | Done |

## Definition of done
Defined in ROADMAP.md, which also tracks which items have been verified on each platform.
