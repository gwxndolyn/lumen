# Lumen response engine

How a question becomes an answer, what each stage guarantees, and what has and hasn't been measured. Everything here is deterministic except the provider call itself: no stage spends an extra model call.

## 1. Pipeline

`ChatService.send` (`src/core/chatService.ts`) runs these stages for every chat request. Their durations are recorded per request (`RequestMetric.stages`) and shown in *Diagnostics → Performance*; no content is recorded.

| Stage | Code | Responsibility | On failure |
|---|---|---|---|
| **Plan** | `intelligence/orchestrator.ts` → `turns.ts`, `classify.ts`, `strategy.ts` | How the message relates to the conversation (new, follow-up, elaborate, simplify, correction, screen, revise code; ambiguity); the task category; whether it needs current information; the strategy instruction | Answer without a strategy (logged) |
| **Retrieve** | `chatService.ts` | Candidates strictly from this session: attached context, session notes, the session's live transcript, knowledge passages, saved memory, earlier exchanges | Optional sources are skipped |
| **Rank** | `context/engine.ts` `prepare`, `context/ranker.ts` | Drop superseded screen captures; dedupe; BM25 × source weight × recency × OCR reliability; relevance cut; secret redaction | — |
| **Build** | `context/promptBuilder.ts` | Trusted system blocks (policy, mode, style, preferences, strategy) separate from the untrusted `<context>` envelope; budget; provenance attributes (kind, age, stale, excerpt, confidence, injection warning) | — |
| **Route** | `inference/hybrid.ts`, `intelligence/router.ts` | Local vs cloud under the user's policy and privacy restriction; optional economy model of the same provider; context-window guard | Refuses with a reason (never silently changes provider) |
| **Generate** | `providers/*` | Streaming, cancellation, bounded retries and timeouts, reported usage | Terminal error event; partial text saved as *interrupted* |
| **Verify** | `intelligence/verify.ts`, `codeCheck.ts` | Deterministic checks on the answer text | Skipped only in evaluation experiments |

Every request ends with exactly one terminal event (`done`, `error` or `cancelled`). Duplicate request ids are ignored, and one generation per conversation runs at a time.

**Unified request representation.** The request is represented by:
- `ChatSendRequest`, validated by zod at the IPC boundary;
- `ResponsePlan` (turn relation and anchor, task category, confidence, current-info flag, strategy, history window);
- the ranked `Candidate[]`, each with kind, `sourceId`, `createdAt`, `explicit`, `retrieved`, `confidence` and `suspicious`;
- `BuiltPrompt` (references, included and dropped items, budget used);
- `GenerateRequest` (model, effort, max tokens, timeouts, retry policy) plus the request's `AbortSignal`.

The sources stay distinct: user facts are in `<question>` and user-attached items; observations are `ocr`/`screenshot`/`transcript` items with age and confidence; retrieved material is marked `retrieved`; model interpretations are not stored as context.

I did not add a new wrapper type. The existing types already have a consumer for each field, and a parallel representation would duplicate them.

## 2. Tasks and strategies

**Categories.** Classification has two passes, both pure functions. Topic words never override the user's instruction ("Write a TypeScript function…" is code generation, not a TypeScript question).

1. **Instruction pass** on the verb of the request:
   - meeting summary / action items
   - notes
   - summary
   - code review
   - refactoring
   - planning
   - writing tests
   - code generation
2. **Current information:** "latest", "still supported", "released yet", "news", and so on route to *research* with `needsCurrentInfo`, except when the time words refer to the user's own meeting ("today's standup").
3. **Topic pass** (the existing rules): debugging, testing, SQL, system design, API/backend, frontend, code explanation, algorithm, language/framework, behavioural, project.

**Ambiguity.** With no earlier turn, a bare command or reaction ("fix", "summarise", "thoughts?", "explain more") is marked ambiguous, and the strategy asks one clarifying question with 2–3 interpretations. The same words after an answer resolve as a follow-up.

**Strategies** (`strategy.ts`) are per category and depth. *Invariant rules* apply at every depth, with or without a mode workflow, because depth changes how much is written, not whether facts may be invented:

| Category | Invariant |
|---|---|
| meeting summary | owner or deadline only if stated, otherwise "owner: not stated" |
| notes | source only; inferences labelled |
| summary | supplied material only, cited; say if nothing was supplied |
| research | Lumen can't browse: only `<context>` is evidence; no invented sources or URLs; other content labelled "General knowledge:" |
| planning | no invented owners, dates or estimates ("TBD") |
| code review | only locations visible in the code; confirmed defects vs possible concerns |
| refactoring | behaviour preserved; changes stated |

Current-information questions also get a no-browsing honesty rule: answer from the sources if they cover it, otherwise say as of when and where to check.

**Not implemented:** a debugging workflow that runs code, and research with web search. The chat assistant has no tools, and the strategies say so rather than pretend. Running code against a real project is the project agent's job (`docs/WORKSPACE.md`), behind approvals.

## 3. Context selection

- **Session isolation.** Every source is scoped to the active session in SQL or in the engine; nothing crosses sessions. Covered by existing tests and a new history test.
- **Superseded observations** (new). A screen capture or OCR text that has a newer capture of the same window or display (same `sourceId`) is not sent, unless the user pinned it. Before this change both were sent, and the model had to reconcile "FAILED" with "PASSED". `PreparedContext.superseded` reports the count.
- **Earlier conversations** (changed). Before, the full-text search matched any single shared word, so a geography question received a Python answer that shared the word "list", and one exchange could arrive twice (question and answer both matched). Now:
  - one passage per earlier exchange, sent as `Q: … A: …` so the fact arrives with what it answered;
  - at least two distinctive query terms must be shared (one, for one-term queries);
  - at most 3 exchanges.
- **Budget.** The user's *Max context per question* (default 60k characters), shrunk to what the chosen model's window can hold once the answer, policy, question and history are reserved. This applies only when the target is fixed, because in local-first/cloud-first the router may still pick the larger window. Oversized sources keep their opening plus the passages that match the question, and excerpts now respect their cap exactly (an existing off-by-12 fixed).
- **Window guard** (new, all providers). A request that still won't fit is refused with `context_too_large` before any provider call. Before, only the local runtime checked this.
- **Ranking** is unchanged: BM25 over the candidates × kind weight + recency (half-life about 30 min) × OCR reliability; pinned and explicit floors; retrieved items keep a floor because their relevance was decided by the index. Freshness metadata (`age`, `stale`) reaches the model on every source.

## 4. Memory

Unchanged from Prompt 7, and verified in this audit:
- memory is saved only explicitly;
- secrets and transcripts are refused;
- items are short and have an expiry;
- retrieval is bounded (5 items, 1,500 characters);
- deletion is immediate.

The session's conversation digest (older turns as one-line Q/A) is used only for follow-ups. The response cache is in memory and tagged by session, so it is invalidated on session delete and cleared on *Delete everything*. No new store was needed.

## 5. Model routing

Unchanged policy:
- the user's provider and model are respected;
- economy routing (off by default) only moves *down* within the same provider, for quick, light tasks;
- hybrid routing never sends protected context to the cloud under privacy restriction, and never falls back from local to cloud unless the user enabled it;
- retries are bounded by `limits.maxAttempts`, and timeouts aren't retried by default.

Routing decisions are logged without content. Reported usage is shown as reported; costs from list prices are labelled estimated. New: the window guard and the window-aware budget use the provider's declared `contextTokens`: Anthropic 200k, the local runtime's `num_ctx`, or whatever an adapter declares. OpenAI and Gemini have no bundled window, so for them the guard doesn't apply and the provider's own error is shown.

## 6. Verification

All checks are deterministic, run after generation, never rewrite the answer, and nothing is ever executed.

| Check | Status values | What it really does |
|---|---|---|
| `code_syntax` (new) | per block: passed / failed / unavailable / skipped | JavaScript: compiled with `vm.Script`, never run. TypeScript: Node type-stripping, then the same compile; **types are not checked**. JSON: `JSON.parse`. JSX/TSX, `enum`, every other language: *unavailable*. Fragments with "…" placeholders: *skipped*. The UI says "Code parses (n/m)" or "Syntax error", with the method per block and "never runs code" in the tooltip. |
| `invented_owner` (new) | flag | meeting/notes: an "Owner: X" whose name is not in the sent sources |
| `fabricated_url` (new) | flag | research: a URL in the answer that isn't in the sent sources (Lumen can't browse) |
| `uncited_summary` (new) | note | summary, notes or meeting answer with sources but no citation |
| existing | flags | unclosed fence, unknown citation, claims it ran code, claims a source that wasn't sent, wrong requested language, missing code, repetition, too long for depth, truncated |

The answer footer says these are rule-based checks of the text, not proof of correctness. Agreement from a second model is not used as verification.

## 7. Untrusted context

The structural defences are unchanged:
- untrusted text appears only inside `<context>` in the user turn, escaped so it can't close the envelope;
- trusted instructions are built only by Lumen;
- the chat assistant exposes no tools to the model, so an injection can't trigger an action there (the project agent's actions are validated and approval-gated in code);
- secrets are redacted before sending;
- sessions are isolated.

New detection patterns, used for the user-visible warning and the `warning=` attribute:
- fake conversation turns inside data ("User: actually, ignore…", "Assistant: sure");
- requests to print or reveal keys, secrets, tokens or environment variables.

Classification only ever reads the user's question, so a document that says "your task is now…" doesn't change the task (tested).

## 8. Evaluation

Deterministic benchmark **v1.1.0**: 77 cases. The 64 v1.0.0 cases are unchanged (same hashes), and 13 were added:
- `task-101`…`107`: strategies, invented owners, current info, invented URLs, syntax error, no false positive on valid TS, bare-command clarification;
- `ctx-101`…`104`: superseded capture, different windows kept, unrelated history excluded, exchange sent once with its question;
- `inj-101`, `inj-102`: role-play injection, secret in captured context.

**Baseline vs final.** The v1.1.0 benchmark was run against the engine before these changes (HEAD `9468002` with only the benchmark files swapped in) and against the final engine. Runs are saved in `docs/eval-runs/`.

| | Baseline engine | Final engine |
|---|---|---|
| Cases passed | 67 / 77 | 77 / 77 |
| Comparison | — | 10 improved, 0 regressed, 67 unchanged |
| Original 64 cases | 64 / 64 | 64 / 64 (unchanged) |

Improved: task-101, 102, 103, 104, 105, 107; ctx-101, 103, 104; inj-101. (task-106, ctx-102 and inj-102 already passed: they guard against false positives and over-pruning.)

**Request size** (deterministic run, characters of system + user text): the median is unchanged across all cases (3,916 → 3,937). On the affected cases the user turn shrank:

| Case | Before (chars) | After (chars) | Why |
|---|---|---|---|
| ctx-101 | 671 | 516 | superseded capture removed |
| ctx-103 | 772 | 331 | unrelated history removed |
| ctx-104 | 771 | 634 | duplicate passage removed |

**Intent classification.** Labelled sets in `src/test/fixtures`. "Seen" means rules were changed after looking at the set.

| Set | Status | Categories before → after |
|---|---|---|
| tuned set (68) | seen | 67 → 67 |
| holdout #2 (24) | seen earlier | 12 → 12 |
| holdout #3 (18) | seen earlier | 13 → 13 |
| holdout #4 (32) | written first, then seen | **6 → 32** |
| holdout #5 (28) | written after pass 1, then seen | 18 → 27 |
| **holdout #6 (23)** | **unseen** (measured once after the final rules) | **17 / 23 (74%)**; relations 1/3, ambiguity 3/3, current-info 23/23 |

Holdout #6 is the honest number. Its misses are:
- "take a look at this PR and flag anything risky" (review)
- "Simplify this nested if-else" (refactoring)
- "break … into tickets" (planning)
- "decisions in the meeting" (meeting)
- "React app rendering twice" (frontend instead of debugging)
- "what does this awk command do?" (code explanation)

Five of the six fall back to the general strategy, which tells the model to choose the task's structure itself. All sets were written by the same author as the rules, so real user phrasing will score lower.

**Latency** (deterministic, scripted provider: measures Lumen's own work only, not model time):
- median about 1–2 ms per case;
- TypeScript checking adds about 40 ms the first time per app run (parser warm-up), then about 0.2 ms per block; task-106 is the slowest case at ~52 ms for that reason.

Real-model latency, tokens and cost: **not measured**. No API key or local model is available on this machine.

## 9. Not verified / limitations

- **No live evaluation.** Whether real models follow the new strategies (cite sources, write "owner: not stated", ask instead of guess) is unmeasured. `npm run eval:live -- --yes` runs the same cases against a real provider.
- **Keyword classification has plateaued** at about 74% on unseen text. Misses mostly degrade to the general strategy, not a wrong one. Measuring whether misclassification produces worse answers needs live runs (LUM-011).
- **Verification is syntax-only for JS, TS and JSON.** There is no type checking, no Python or SQL parsing, and no test execution. Lumen deliberately never runs generated code.
- Owner and URL checks are pattern-based and can miss unusual phrasings.
- History retrieval is still keyword-based unless local embeddings are configured.
- Window sizes are bundled only for Anthropic and declared by local or custom adapters.
