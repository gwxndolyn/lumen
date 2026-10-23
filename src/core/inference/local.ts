// Local runtime state: whether Ollama answers, which models are installed, and what the chosen
// model can do. Refreshed on demand (and before a request when stale) — only loopback is contacted,
// and nothing is ever installed or downloaded by Lumen.

import { OllamaProvider, OllamaRuntime, isLoopbackUrl, type LocalModelDetails, type RuntimeStatus } from "../providers/ollama";
import type { Settings } from "../../shared/types";

const STALE_MS = 30_000;

export interface LocalState {
  status: RuntimeStatus | null;
  /** Details of the configured chat model, when installed. */
  model: LocalModelDetails | null;
  /** Why the configured local model can't be used right now (null = usable). */
  problem: string | null;
}

export class LocalInference {
  private status: RuntimeStatus | null = null;
  private details: LocalModelDetails | null = null;
  private detailsFor = "";
  private runtimeFor = "";
  private rt: OllamaRuntime | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly fetchImpl?: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  runtime(): OllamaRuntime | null {
    const url = this.getSettings().inference.local.baseUrl;
    if (!isLoopbackUrl(url)) return null;
    if (!this.rt || this.runtimeFor !== url) {
      this.rt = new OllamaRuntime(url, { fetch: this.fetchImpl });
      this.runtimeFor = url;
      this.status = null;
      this.details = null;
      this.detailsFor = "";
    }
    return this.rt;
  }

  /** Whether local inference is relevant for the current settings (avoids probing otherwise). */
  get wanted(): boolean {
    const s = this.getSettings();
    return s.provider.kind === "ollama" || s.inference.mode !== "manual" || !!s.inference.local.embeddingModel;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const rt = this.runtime();
      if (!rt) {
        this.status = { available: false, version: null, checkedAt: this.now(), error: "The local runtime address must be on this computer.", models: [] };
        return;
      }
      this.status = await rt.status(this.now());
      const model = this.getSettings().inference.local.model;
      this.details = null;
      this.detailsFor = model;
      if (this.status.available && model && this.installed(model)) {
        try {
          this.details = await rt.show(model);
        } catch {
          this.details = null;
        }
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Refresh when stale or the configured model changed; bounded so a dead runtime costs little. */
  async ensureFresh(): Promise<void> {
    if (!this.wanted) return;
    const model = this.getSettings().inference.local.model;
    const stale = !this.status || this.now() - this.status.checkedAt > STALE_MS || this.detailsFor !== model;
    if (stale) await this.refresh();
  }

  private installed(model: string) {
    return !!this.status?.models.some((m) => m.name === model || m.name === `${model}:latest`);
  }

  state(): LocalState {
    const model = this.getSettings().inference.local.model;
    return { status: this.status, model: this.details, problem: this.problem(model) };
  }

  private problem(model: string): string | null {
    if (!this.status) return "the local runtime has not been checked yet";
    if (!this.status.available) return this.status.error ?? "Ollama is not running";
    if (!model) return "no local model is selected";
    if (!this.installed(model)) return `“${model}” is not installed (run: ollama pull ${model})`;
    if (!this.details) return `could not read “${model}”'s capabilities`;
    if (!this.details.capabilities.includes("completion")) return `“${model}” is not a chat model`;
    return null;
  }

  /** A provider for the configured local model, or null with the reason in `state().problem`. */
  provider(): OllamaProvider | null {
    const s = this.getSettings();
    if (this.problem(s.inference.local.model)) return null;
    return new OllamaProvider({ baseUrl: s.inference.local.baseUrl, model: s.inference.local.model, numCtx: s.inference.local.numCtx, details: this.details, fetch: this.fetchImpl });
  }
}
