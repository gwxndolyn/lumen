// Credential patterns shared by everything that writes operational data to disk or into a file the
// user may send to someone: the log, the support file and beta reports. One list, so a provider
// key format added in one place cannot be missed in another (LUM-018: the log missed OpenAI
// project keys and Gemini keys while the support file caught them).

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]"],
  // OpenAI: legacy sk-…, project sk-proj-…, service-account sk-svcacct-… (hyphens and underscores).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]"],
  [/\bxox[bpa]-[A-Za-z0-9-]{10,}/g, "xox-[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(token|apikey|api_key|api-key|authorization|x-api-key|x-goog-api-key|password|secret)(["'\s:=]+)[^\s"',}]{8,}/gi, "$1$2[REDACTED]"],
  // Long hex strings: Deepgram keys, session tokens, hashes of secrets.
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED]"],
];

/** Replace anything that looks like a credential. Idempotent. */
export function redactCredentials(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Replace the user's home directory (which usually contains their name) with "~", in the plain,
 * forward-slash, and JSON-escaped forms it takes in logs and serialized data.
 */
export function redactHome(text: string, home: string): string {
  if (!home || home.length <= 1) return text;
  let out = text;
  const variants = [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\"), JSON.stringify(home).slice(1, -1)];
  for (const v of new Set(variants)) out = out.split(v).join("~");
  return out;
}
