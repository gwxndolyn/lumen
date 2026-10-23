# Local and hybrid AI

Lumen can answer with a cloud provider (Anthropic, OpenAI, Gemini, an OpenAI-compatible server),
a local model running in [Ollama](https://ollama.com) on the same computer, or a mix of both.

## Setup (Ollama)

1. Install Ollama and start it (the Ollama app, or `ollama serve`). It listens on
   `http://127.0.0.1:11434`. Keep it bound to loopback — don't set `OLLAMA_HOST=0.0.0.0`.
2. Install a model **yourself**. Lumen never downloads models.
   - `ollama pull llama3.2` — ~2 GB on disk, needs ~4 GB free memory. Fast, weakest.
   - `ollama pull llama3.1:8b` / `qwen2.5:7b` — ~5 GB, needs ~8 GB free memory.
   - Vision: `ollama pull llava` (or another model whose capabilities include `vision`).
   - Embeddings (optional, for semantic knowledge search): `ollama pull nomic-embed-text` (~270 MB).
3. In Lumen: **Settings → AI provider → Local model (Ollama)** → Check → choose the model.
   Either pick *Local model* as the provider (Manual), or keep a cloud provider and choose a
   routing mode.

Expect several seconds per answer without a GPU or Apple Silicon. Larger context sizes
(`Context size`) need more memory; requests that do not fit are refused (or sent to the cloud in
*Local first*) instead of being silently truncated, because Ollama would otherwise drop the start
of the prompt — the safety policy.

## Routing modes

| Mode | Behaviour |
|---|---|
| Manual | Always the selected provider. |
| Local first | Local model, except deep coding/design tasks, images (if the model has no vision) and requests larger than its context, which go to the cloud. |
| Cloud first | Cloud provider; the local model when the cloud is unavailable or privacy rules keep content on the device. |

Every answer records where it ran (`route` in the message, `routing` in the start event).
Fallback after a failure is only to targets your settings allow: cloud → local is on by default
(data stays on the device); local → cloud is **off** by default.

## Privacy restriction

When on, screen content (captures, OCR, selected text, clipboard), transcripts and
documents/knowledge passages are never sent to a cloud provider unless you allow that kind.
It applies in every mode, including Manual and to meeting-notes generation. If no local model can
take the request, Lumen refuses with the reason and the options instead of sending it.

## Usage and limits

`usage_ledger` records provider, model, session, task category, input/output/cached tokens,
retries, latency, outcome and two bases:

- `usage_basis`: `reported` (from the provider) or `estimated`.
- `cost_basis`: `list_price` (bundled Anthropic prices), `user_price` (price you entered),
  `local` (no API cost), `none` (no price known — shown as *unknown*, not $0).

Limits: daily cost (existing), cost and requests per session, concurrent requests, context size,
attempts per request. Cloud requests are checked against their **worst-case** cost (full output
allowance) before sending. Timeouts are **not retried by default**: a timed-out request may still
have been processed and billed.

## Caching

- Response cache (off by default): identical request — provider, model, every system block, every
  message and context passage, limits — within 10 minutes. Memory only, max 100 entries / 2 MB,
  cleared on restart, session deletion, *Delete everything* and on request. Hit rate and median
  time saved are shown from actual hits.
- Local model metadata (capabilities, context length) is cached per model name.

## Semantic search

Optional. Vectors are computed locally, stored with the model name and dimensions, and never mixed
with another model's (a different model marks the index stale until you rebuild). Keyword search
is always used and is the fallback. Vectors are deleted with their documents and by
*Delete everything*.

## Evaluation

Select *Local model* as the provider and run a live evaluation in the Evaluation Lab, or
`npm run eval:live -- --local llama3.2 --yes`. Runs record OS, CPU, RAM, the Ollama version and the
models held in memory. Compare a local run with a cloud run per category; don't assume they are
equivalent without that evidence.

## Known limitations

- Only Ollama is supported as a local runtime (others can be used through the OpenAI-compatible
  provider, but are treated as leaving the device and without capability discovery).
- Token estimates for routing and budgets use ~3.5 characters per token.
- Local-first escalation uses deterministic task categories, which have known classification
  misses (see the intent evaluation).
- No local-model benchmark results are bundled: none have been run on real hardware yet.
