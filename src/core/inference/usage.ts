// Central usage accounting and budget enforcement. Costs are estimates from bundled list prices or
// a price the user entered; when neither exists the cost is recorded as unknown (basis "none"),
// never as free. Local inference has no per-request price.

import { estimateCostUsd, hasPricing } from "../providers/pricing";
import { ProviderError, type GenerateUsage } from "../providers/types";
import type { Store, UsageExtra } from "../storage/db";
import type { Settings } from "../../shared/types";

export interface BudgetStatus {
  daily: { spentUsd: number; limitUsd: number; requests: number };
  session: { spentUsd: number; limitUsd: number; requests: number; requestLimit: number };
  /** Messages for budgets at or past the warning threshold. */
  warnings: string[];
}

export interface CostEstimate {
  usd: number;
  basis: UsageExtra["costBasis"];
}

export function costFor(kind: string, model: string, usage: GenerateUsage, settings: Settings): CostEstimate {
  if (kind === "ollama") return { usd: 0, basis: "local" };
  if (kind === "mock") return { usd: 0, basis: "none" };
  if (hasPricing(model)) return { usd: estimateCostUsd(model, usage), basis: "list_price" };
  if (settings.provider.customPrice) return { usd: estimateCostUsd(model, usage, settings.provider.customPrice), basis: "user_price" };
  return { usd: 0, basis: "none" };
}

/** Conservative upper bound for a request before it is sent: full output allowance at list price. */
export function worstCaseUsd(kind: string, model: string, inputTokens: number, maxOutputTokens: number, settings: Settings): number | null {
  if (kind === "ollama" || kind === "mock") return 0;
  const usage = { inputTokens, outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (hasPricing(model)) return estimateCostUsd(model, usage);
  if (settings.provider.customPrice) return estimateCostUsd(model, usage, settings.provider.customPrice);
  return null;
}

export class UsageService {
  private inflight = 0;

  constructor(
    private readonly store: Store,
    private readonly getSettings: () => Settings,
    private readonly now: () => number = Date.now,
  ) {}

  private startOfDay() {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  status(sessionId: string | null): BudgetStatus {
    const s = this.getSettings();
    const day = this.store.spendSince(this.startOfDay());
    const sess = sessionId ? this.store.sessionUsage(sessionId) : { costUsd: 0, requests: 0 };
    const warnings: string[] = [];
    const pct = s.limits.warnAtPercent / 100;
    if (s.provider.dailySpendLimitUsd > 0 && day.costUsd >= s.provider.dailySpendLimitUsd * pct)
      warnings.push(`Today's estimated spend is $${day.costUsd.toFixed(2)} of your $${s.provider.dailySpendLimitUsd.toFixed(2)} daily limit.`);
    if (s.limits.costPerSessionUsd > 0 && sess.costUsd >= s.limits.costPerSessionUsd * pct)
      warnings.push(`This session's estimated spend is $${sess.costUsd.toFixed(2)} of its $${s.limits.costPerSessionUsd.toFixed(2)} limit.`);
    if (s.limits.requestsPerSession > 0 && sess.requests >= s.limits.requestsPerSession * pct) warnings.push(`This session has used ${sess.requests} of ${s.limits.requestsPerSession} requests.`);
    return {
      daily: { spentUsd: day.costUsd, limitUsd: s.provider.dailySpendLimitUsd, requests: day.requests },
      session: { spentUsd: sess.costUsd, limitUsd: s.limits.costPerSessionUsd, requests: sess.requests, requestLimit: s.limits.requestsPerSession },
      warnings,
    };
  }

  /**
   * Throws a spend_limit ProviderError when this request could break a limit. Cloud requests are
   * checked against their worst-case cost; an unknown price can't be checked and is allowed only
   * when no cost limit is set. Local requests count against request limits only.
   */
  check(input: { sessionId: string; kind: string; model: string; inputTokens: number; maxOutputTokens: number }) {
    const s = this.getSettings();
    if (input.kind === "mock") return;
    const st = this.status(input.sessionId);
    if (s.limits.requestsPerSession > 0 && st.session.requests >= s.limits.requestsPerSession)
      throw new ProviderError(`This session reached its limit of ${s.limits.requestsPerSession} requests. Raise it in AI provider → Usage limits, or start a new session.`, "spend_limit", false);
    if (input.kind === "ollama") return;
    const worst = worstCaseUsd(input.kind, input.model, input.inputTokens, input.maxOutputTokens, s);
    const dayLimit = s.provider.dailySpendLimitUsd;
    const sessLimit = s.limits.costPerSessionUsd;
    if (dayLimit > 0 && st.daily.spentUsd >= dayLimit) throw this.limitError("daily", st.daily.spentUsd, dayLimit);
    // No price for this model: spend can't be measured, so the cost limits can't stop it. That is
    // shown in the usage report (cost basis "none") rather than blocking every request.
    if (worst === null) return;
    const w = worst;
    if (sessLimit > 0 && st.session.spentUsd >= sessLimit) throw this.limitError("session", st.session.spentUsd, sessLimit);
    if (sessLimit > 0 && st.session.spentUsd + w > sessLimit)
      throw new ProviderError(
        `This question could cost up to $${w.toFixed(3)}, which would exceed the session limit ($${st.session.spentUsd.toFixed(2)} of $${sessLimit.toFixed(2)} used). Remove some context or raise the limit.`,
        "spend_limit",
        false,
      );
  }

  private limitError(which: "daily" | "session", spent: number, limit: number) {
    return new ProviderError(
      which === "daily"
        ? `Today's estimated AI spend ($${spent.toFixed(2)}) reached your daily limit of $${limit.toFixed(2)}. Raise or remove the limit in AI provider settings.`
        : `This session's estimated AI spend ($${spent.toFixed(2)}) reached its limit of $${limit.toFixed(2)}. Raise it in AI provider → Usage limits, or start a new session.`,
      "spend_limit",
      false,
    );
  }

  /** Concurrency gate. Returns a release function, or throws "busy". */
  acquire(): () => void {
    const max = this.getSettings().limits.maxConcurrentRequests;
    if (this.inflight >= max)
      throw new ProviderError(`Lumen is already answering ${this.inflight} question${this.inflight === 1 ? "" : "s"} (limit ${max}). Wait for one to finish or stop it.`, "busy", false);
    this.inflight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight--;
    };
  }

  record(e: {
    kind: string;
    model: string;
    usage: GenerateUsage;
    usageBasis: UsageExtra["usageBasis"];
    sessionId: string;
    category: string | null;
    outcome: UsageExtra["outcome"];
    retries: number;
    latencyMs: number | null;
  }): CostEstimate {
    const s = this.getSettings();
    const cost = costFor(e.kind, e.model, e.usage, s);
    this.store.recordUsage(e.model, e.usage.inputTokens, e.usage.outputTokens, cost.usd, this.now(), {
      provider: e.kind,
      sessionId: e.sessionId,
      category: e.category,
      cacheReadTokens: e.usage.cacheReadTokens,
      costBasis: cost.basis,
      usageBasis: e.usageBasis,
      outcome: e.outcome,
      retries: e.retries,
      latencyMs: e.latencyMs,
    });
    return cost;
  }

  report(days = 30) {
    return this.store.usageReport(this.now() - days * 86_400_000);
  }
}
