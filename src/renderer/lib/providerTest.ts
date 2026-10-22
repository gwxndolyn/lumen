import type { ProviderTestResult } from "../../shared/types";

/** What the user should do next for each kind of failed connection test. */
const NEXT_STEP: Partial<Record<NonNullable<ProviderTestResult["code"]>, string>> = {
  auth: "Check the key is correct and active, then save it again.",
  missing_credentials: "Add an API key for this provider.",
  model_unavailable: "Pick a model your account can use.",
  bad_request: "Check the model name and base URL.",
  network: "Check your internet connection, VPN or proxy.",
  timeout: "The provider is slow or unreachable; try again shortly.",
  rate_limited: "Your key is rate limited; wait a minute and retry.",
  overloaded: "The provider is having an outage; try again shortly.",
};

const KIND: Partial<Record<NonNullable<ProviderTestResult["code"]>, string>> = {
  auth: "Invalid key",
  missing_credentials: "No key",
  model_unavailable: "Model unavailable",
  network: "Network problem",
  timeout: "No response",
  rate_limited: "Rate limited",
  overloaded: "Provider outage",
};

export function describeTest(r: ProviderTestResult): { title: string; detail: string; next: string | null } {
  if (r.ok) return { title: "Connected", detail: `${r.message}${r.latencyMs != null ? ` (${r.latencyMs} ms)` : ""}`, next: null };
  return { title: (r.code && KIND[r.code]) || "Connection failed", detail: r.message, next: (r.code && NEXT_STEP[r.code]) || null };
}
