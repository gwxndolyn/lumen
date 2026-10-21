import type { RequestMetric } from "../shared/types";

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/** In-memory ring buffer of request timings and costs for this app session. No content is stored. */
export class Metrics {
  private requests: RequestMetric[] = [];
  private transcriptionLatencies: number[] = [];
  sessionCostUsd = 0;

  constructor(private readonly cap = 200) {}

  recordRequest(m: RequestMetric) {
    this.requests.push(m);
    if (this.requests.length > this.cap) this.requests.shift();
    this.sessionCostUsd += m.estimatedCostUsd;
  }

  recordTranscriptionLatency(ms: number) {
    this.transcriptionLatencies.push(ms);
    if (this.transcriptionLatencies.length > this.cap) this.transcriptionLatencies.shift();
  }

  snapshot() {
    const ok = this.requests.filter((r) => r.outcome === "ok");
    const ttft = ok.map((r) => r.ttftMs).filter((v): v is number => v !== null);
    const total = ok.map((r) => r.totalMs);
    const finished = this.requests.filter((r) => r.outcome !== "cancelled");
    return {
      requests: [...this.requests].reverse().slice(0, 50),
      p50TtftMs: percentile(ttft, 50),
      p95TtftMs: percentile(ttft, 95),
      p50TotalMs: percentile(total, 50),
      errorRate: finished.length ? finished.filter((r) => r.outcome === "error").length / finished.length : null,
      sessionCostUsd: Math.round(this.sessionCostUsd * 1e6) / 1e6,
      transcriptionP50LatencyMs: percentile(this.transcriptionLatencies, 50),
    };
  }
}
