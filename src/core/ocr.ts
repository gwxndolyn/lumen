import path from "node:path";
import { createRequire } from "node:module";

export interface OcrResult {
  text: string;
  /** 0–1 mean word confidence. */
  confidence: number;
  ms: number;
}

/** Text recognition backend. Runs fully on-device; implementations must not upload images. */
export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
  dispose(): Promise<void>;
}

type TesseractWorker = {
  recognize(img: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
};

/**
 * Tesseract (WASM) OCR with the English model shipped in node_modules — no network download.
 * A single lazily-started worker processes jobs one at a time; jobs time out so a pathological
 * image can never wedge the queue.
 */
export class TesseractOcr implements OcrEngine {
  private worker: Promise<TesseractWorker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** Captures waiting for OCR beyond this are rejected immediately instead of queueing forever. */
  static readonly MAX_PENDING = 4;

  constructor(
    private readonly opts: { langPath?: string; timeoutMs?: number; cachePath?: string } = {},
  ) {}

  private langPath(): string {
    if (this.opts.langPath) return this.opts.langPath;
    const req = createRequire(__filename);
    return path.join(path.dirname(req.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
  }

  private start(): Promise<TesseractWorker> {
    this.worker ??= (async () => {
      const { createWorker } = await import("tesseract.js");
      return (await createWorker("eng", 1, {
        langPath: this.langPath(),
        gzip: true,
        cacheMethod: this.opts.cachePath ? "write" : "none",
        cachePath: this.opts.cachePath,
        // Without a handler tesseract.js rethrows job failures as uncaught exceptions; the
        // failure is already delivered to the caller through the rejected recognize() promise.
        errorHandler: () => undefined,
      })) as unknown as TesseractWorker;
    })();
    return this.worker;
  }

  recognize(image: Buffer): Promise<OcrResult> {
    if (this.pending >= TesseractOcr.MAX_PENDING) return Promise.reject(new Error("text recognition is busy — try again in a moment"));
    this.pending++;
    const job = this.queue.then(async () => {
      const started = Date.now();
      const worker = await this.start();
      const timeout = this.opts.timeoutMs ?? 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          worker.recognize(image),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("text recognition timed out")), timeout);
          }),
        ]);
        return { text: cleanOcrText(r.data.text), confidence: Math.max(0, Math.min(1, r.data.confidence / 100)), ms: Date.now() - started };
      } catch (err) {
        // A timed-out worker may be stuck; replace it.
        await this.dispose();
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.queue = job.catch(() => undefined);
    return job.finally(() => this.pending--);
  }

  async dispose() {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w.catch(() => null))?.terminate().catch(() => undefined);
  }
}

/** Collapse OCR noise: stray single-symbol lines and runs of whitespace. */
export function cleanOcrText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    // Keep blank lines (paragraph breaks); drop lines that are a lone stray symbol.
    .filter((l) => l.length === 0 || l.length > 1 || /[\p{L}\p{N}]/u.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
