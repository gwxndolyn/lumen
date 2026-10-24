// Detects and masks sensitive values in context before it leaves the device.
// Used for both classification (shown to the user) and redaction (applied to the prompt).

export interface SensitiveMatch {
  kind: string;
  start: number;
  end: number;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES: { kind: string; re: RegExp; check?: (m: string) => boolean }[] = [
  { kind: "card number", re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, "")) },
  {
    kind: "API key",
    // OpenAI project/service keys contain hyphens (sk-proj-…, sk-svcacct-…); GitHub has several token prefixes.
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[bpa]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/g,
  },
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "password", re: /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S{4,}/gi },
  { kind: "US SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

export function findSensitive(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text))) {
      if (!r.check || r.check(m[0])) out.push({ kind: r.kind, start: m.index, end: m.index + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function classify(text: string): { sensitivity: "normal" | "sensitive"; kinds: string[] } {
  const kinds = [...new Set(findSensitive(text).map((m) => m.kind))];
  return { sensitivity: kinds.length ? "sensitive" : "normal", kinds };
}

export function redact(text: string): string {
  const matches = findSensitive(text);
  if (!matches.length) return text;
  let out = "";
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue; // overlapping
    out += text.slice(pos, m.start) + `[redacted ${m.kind}]`;
    pos = m.end;
  }
  return out + text.slice(pos);
}
