// Hybrid local/cloud routing. A pure function: given the user's policy, what the request contains
// and what is available, choose where it runs — or refuse with the reason and the alternatives.
//
// Invariants (tested):
// - Manual mode uses exactly the provider the user selected.
// - With privacy restriction on, screen, transcript and document context never reach a cloud
//   provider unless the user allowed that kind of context to.
// - A failure on the local model never sends the request to the cloud unless the user turned on
//   local→cloud fallback, and even then privacy restriction still applies.

import type { TaskCategory } from "../intelligence/classify";

export type Route = "local" | "cloud";
export type ProtectedKind = "screen" | "transcript" | "documents";

export interface HybridPolicy {
  mode: "manual" | "local_first" | "cloud_first";
  privacyRestricted: boolean;
  cloudAllowed: Record<ProtectedKind, boolean>;
  fallback: { cloudToLocal: boolean; localToCloud: boolean };
}

export interface RouteRequest {
  /** Protected context kinds present in this request. */
  protectedKinds: ProtectedKind[];
  needsVision: boolean;
  estimatedTokens: number;
  category: TaskCategory;
  depth: "quick" | "balanced" | "deep";
}

export interface Availability {
  /** The selected provider kind (`settings.provider.kind`). */
  selectedKind: string;
  /** A cloud provider is configured and can be built (key present). Never true for "ollama"/"mock". */
  cloud: { ready: boolean; vision: boolean; contextTokens: number | null; label: string };
  /** A local model is chosen and the runtime answered recently. */
  local: { ready: boolean; vision: boolean; contextTokens: number | null; label: string; reason?: string };
}

export interface RouteDecision {
  route: Route | null;
  /** Ordered fallback the router allows if the first route fails (never violates privacy). */
  fallback: Route | null;
  reason: string;
  /** Set when route is null: what the user can do. */
  alternatives: string[];
  /** Whether request content would leave the device on the chosen route. */
  leavesDevice: boolean;
}

/** Tasks where small local models are usually adequate at quick/balanced depth. */
const LOCAL_FRIENDLY: ReadonlySet<TaskCategory> = new Set(["general", "meeting_summary", "language_framework", "code_explanation", "behavioral", "project"]);

const KIND_LABEL: Record<ProtectedKind, string> = { screen: "screen content", transcript: "a transcript", documents: "documents" };

/** Why the cloud is not allowed for this request, or null when it is. */
export function cloudBlockedBy(policy: HybridPolicy, req: RouteRequest): ProtectedKind[] {
  if (!policy.privacyRestricted) return [];
  return req.protectedKinds.filter((k) => !policy.cloudAllowed[k]);
}

function fits(cap: { vision: boolean; contextTokens: number | null }, req: RouteRequest): string | null {
  if (req.needsVision && !cap.vision) return "it cannot read images";
  // Leave room for the answer.
  if (cap.contextTokens != null && req.estimatedTokens > cap.contextTokens * 0.8)
    return `the request (~${req.estimatedTokens.toLocaleString()} tokens) exceeds its ${cap.contextTokens.toLocaleString()}-token context`;
  return null;
}

export function decideRoute(policy: HybridPolicy, req: RouteRequest, av: Availability): RouteDecision {
  const blocked = cloudBlockedBy(policy, req);
  const cloudMisfit = av.cloud.ready ? fits(av.cloud, req) : "no cloud provider is configured";
  const localMisfit = av.local.ready ? fits(av.local, req) : (av.local.reason ?? "no local model is set up");
  const cloudOk = blocked.length === 0 && !cloudMisfit;
  const localOk = !localMisfit;
  const privacyNote = blocked.length ? `Privacy restriction keeps ${blocked.map((k) => KIND_LABEL[k]).join(" and ")} on this device.` : "";

  const choose = (route: Route, reason: string): RouteDecision => {
    const other: Route = route === "local" ? "cloud" : "local";
    const fallbackAllowed = route === "local" ? policy.fallback.localToCloud && cloudOk : policy.fallback.cloudToLocal && localOk;
    return { route, fallback: fallbackAllowed ? other : null, reason, alternatives: [], leavesDevice: route === "cloud" };
  };
  const refuse = (reason: string, alternatives: string[]): RouteDecision => ({ route: null, fallback: null, reason, alternatives, leavesDevice: false });

  if (policy.mode === "manual") {
    if (av.selectedKind === "ollama") {
      return localOk
        ? { ...choose("local", `Using your selected local model (${av.local.label}).`), fallback: null }
        : refuse(`Your selected local model can't take this request: ${localMisfit}.`, localAlternatives(av, cloudOk));
    }
    // A cloud provider (or development mode) chosen explicitly. Privacy restriction still applies.
    if (blocked.length) return refuse(`${privacyNote} Your selected provider (${av.cloud.label}) is a cloud service.`, privacyAlternatives(blocked, localOk));
    return { ...choose("cloud", `Using your selected provider (${av.cloud.label}).`), fallback: null };
  }

  if (policy.mode === "local_first") {
    const preferLocal = localOk && (LOCAL_FRIENDLY.has(req.category) || req.depth !== "deep" || !cloudOk);
    if (preferLocal) return choose("local", `Local first: ${av.local.label} runs on this device.`);
    if (cloudOk)
      return choose(
        "cloud",
        localOk
          ? `Local first, but this ${req.depth} ${req.category.replace("_", " ")} task needs a stronger model; using ${av.cloud.label}.`
          : `Local model unavailable (${localMisfit}); using ${av.cloud.label}.`,
      );
    if (localOk) return choose("local", `${privacyNote} Using ${av.local.label} on this device.`);
    return refuse(
      blocked.length ? `${privacyNote} The local model can't take it: ${localMisfit}.` : `Neither model can take this request: local — ${localMisfit}; cloud — ${cloudMisfit}.`,
      blocked.length ? privacyAlternatives(blocked, false) : localAlternatives(av, false),
    );
  }

  // cloud_first
  if (cloudOk) return choose("cloud", `Cloud first: ${av.cloud.label}.`);
  if (localOk)
    return choose("local", blocked.length ? `${privacyNote} Using ${av.local.label} on this device instead.` : `Cloud unavailable (${cloudMisfit}); using ${av.local.label} on this device.`);
  return refuse(
    blocked.length ? `${privacyNote} No local model can take it: ${localMisfit}.` : `No model can take this request: cloud — ${cloudMisfit}; local — ${localMisfit}.`,
    blocked.length ? privacyAlternatives(blocked, false) : localAlternatives(av, false),
  );
}

function privacyAlternatives(blocked: ProtectedKind[], localOk: boolean): string[] {
  const out = [];
  if (!localOk) out.push("Set up a local model in Settings → AI provider → Local model (Ollama).");
  out.push(`Remove the ${blocked.map((k) => KIND_LABEL[k]).join(" / ")} from this question.`);
  out.push(`Or allow sending ${blocked.map((k) => KIND_LABEL[k]).join(" and ")} to the cloud in Settings → AI provider → Privacy.`);
  return out;
}

function localAlternatives(av: Availability, cloudOk: boolean): string[] {
  const out = [];
  if (!av.local.ready) out.push("Start Ollama and choose an installed model in Settings → AI provider → Local model.");
  else out.push("Use a local model with a larger context or vision support, or remove some context.");
  if (cloudOk) out.push(`Or switch routing to Cloud first to use ${av.cloud.label}.`);
  return out;
}

/** Which protected kinds a set of context sources contains. */
export function protectedKindsOf(kinds: Iterable<string>): ProtectedKind[] {
  const out = new Set<ProtectedKind>();
  for (const k of kinds) {
    if (k === "screenshot" || k === "ocr" || k === "selected_text" || k === "clipboard") out.add("screen");
    else if (k === "transcript") out.add("transcript");
    else if (k === "document" || k === "knowledge") out.add("documents");
  }
  return [...out];
}
