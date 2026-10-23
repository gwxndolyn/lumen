// Model routing within the user's chosen provider. It never switches provider (that would send data
// to a service the user did not pick); it only chooses between models of that provider for which
// Lumen ships capability metadata. Without that metadata, or when routing is off, the user's model
// is used unchanged.

import type { TaskCategory } from "./classify";

export type RoutingMode = "off" | "economy";

export interface ModelInfo {
  id: string;
  provider: string;
  tier: "fast" | "balanced" | "strong";
  vision: boolean;
  /** Approximate context window in tokens. */
  contextTokens: number;
}

/** Only models whose capabilities and prices are bundled (see providers/pricing.ts). */
export const MODEL_CATALOG: ModelInfo[] = [
  { id: "claude-haiku-5-5", provider: "anthropic", tier: "fast", vision: true, contextTokens: 200_000 },
  { id: "claude-sonnet-5-5", provider: "anthropic", tier: "balanced", vision: true, contextTokens: 200_000 },
  { id: "claude-opus-5-5", provider: "anthropic", tier: "strong", vision: true, contextTokens: 200_000 },
  { id: "claude-fable-5-1", provider: "anthropic", tier: "strong", vision: true, contextTokens: 200_000 },
];

const RANK = { fast: 0, balanced: 1, strong: 2 } as const;

/** Tasks where a smaller model is usually enough at quick depth. */
const LIGHT: ReadonlySet<TaskCategory> = new Set(["general", "language_framework", "meeting_summary"]);

export interface RouteInput {
  mode: RoutingMode;
  providerKind: string;
  configuredModel: string;
  category: TaskCategory;
  depth: "quick" | "balanced" | "deep";
  needsVision: boolean;
  /** Rough size of the request (chars / 4). */
  estimatedInputTokens: number;
  /** The session pinned a model explicitly. */
  sessionPinned: boolean;
}

export interface RouteDecision {
  model: string;
  routed: boolean;
  reason: string;
}

export function routeModel(i: RouteInput, catalog: readonly ModelInfo[] = MODEL_CATALOG): RouteDecision {
  const keep = (reason: string): RouteDecision => ({ model: i.configuredModel, routed: false, reason });
  if (i.mode === "off") return keep("Routing is off; using your selected model.");
  if (i.sessionPinned) return keep("This session pins a model.");
  const configured = catalog.find((m) => m.id === i.configuredModel && m.provider === i.providerKind);
  if (!configured) return keep("No bundled capability data for this provider and model; using your selected model.");
  // Economy only ever routes *down* from the user's choice, and only for light, quick tasks.
  if (i.depth !== "quick" || !LIGHT.has(i.category)) return keep("This task benefits from your selected model.");
  const candidate = catalog
    .filter((m) => m.provider === configured.provider && RANK[m.tier] < RANK[configured.tier] && (!i.needsVision || m.vision) && m.contextTokens >= i.estimatedInputTokens * 1.2)
    .sort((a, b) => RANK[a.tier] - RANK[b.tier])[0];
  if (!candidate) return keep("No cheaper model in the catalog fits this request.");
  return { model: candidate.id, routed: true, reason: `Economy routing: a quick ${i.category.replace("_", " ")} question uses ${candidate.id} instead of ${configured.id}.` };
}
