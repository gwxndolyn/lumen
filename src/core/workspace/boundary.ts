// The project boundary. Every file operation in the workspace resolves its path here first.
//
// Rules (tested in src/test/workspace.test.ts):
// - Paths are project-relative. Absolute paths, NUL bytes, drive letters and UNC prefixes are
//   rejected; ".." may not climb above the root.
// - The real path (all symlinks resolved) of the target — or, for a file that doesn't exist yet,
//   of its nearest existing ancestor — must be inside the real path of the root. A symlink that
//   points outside the root is refused, not followed.
// - Protected files (credentials, keys, env files, VCS internals) are never read for the model,
//   never indexed, never written by the agent.
// The root itself is re-resolved on every call, so a root that was moved or replaced is detected
// at execution time rather than trusted from when the project was added.

import fs from "node:fs";
import path from "node:path";

export class BoundaryError extends Error {
  constructor(
    message: string,
    readonly code: "outside_root" | "invalid_path" | "protected" | "root_unavailable",
  ) {
    super(message);
    this.name = "BoundaryError";
  }
}

/** Files whose contents are never read for the AI, indexed or written by the agent. */
const PROTECTED_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc|ovpn)$/i,
  /^(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt))?$/i,
  /^service[-_]?account.*\.json$/i,
  /^\.?htpasswd$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
];
const PROTECTED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure", ".config/gcloud"]);

export function isProtected(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p, i) => PROTECTED_DIRS.has(p) || PROTECTED_DIRS.has(parts.slice(i, i + 2).join("/")))) return true;
  const base = parts.at(-1) ?? "";
  return PROTECTED_NAMES.some((re) => re.test(base));
}

function isInside(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

/** The real path of an approved root, or a BoundaryError if it is gone or not a directory. */
export function realRoot(root: string): string {
  try {
    const real = fs.realpathSync.native(root);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new BoundaryError(`The project folder is not available: ${path.basename(root)}. It may have been moved, renamed or deleted.`, "root_unavailable");
  }
}

export interface Resolved {
  /** Absolute path (inside the real root). */
  abs: string;
  /** Normalized project-relative path with forward slashes. */
  rel: string;
  exists: boolean;
}

/**
 * Resolve a project-relative path. `allowProtected` is only for listing names (never contents).
 */
export function resolveInRoot(root: string, input: string, opts: { allowProtected?: boolean } = {}): Resolved {
  if (typeof input !== "string" || !input.trim() || input.length > 1024 || input.includes("\0")) throw new BoundaryError("Invalid path.", "invalid_path");
  if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith("\\\\") || input.startsWith("//") || input.startsWith("~"))
    throw new BoundaryError("Use a path relative to the project folder.", "invalid_path");
  const rootReal = realRoot(root);
  const joined = path.resolve(rootReal, input);
  if (!isInside(rootReal, joined)) throw new BoundaryError("That path is outside the project folder.", "outside_root");
  // Resolve symlinks on the deepest existing ancestor; a link that leaves the root is refused.
  let probe = joined;
  while (!fs.existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
  let probeReal: string;
  try {
    probeReal = fs.realpathSync.native(probe);
  } catch {
    throw new BoundaryError("That path cannot be accessed.", "invalid_path");
  }
  if (!isInside(rootReal, probeReal)) throw new BoundaryError("That path leads outside the project folder through a link.", "outside_root");
  const abs = path.join(probeReal, path.relative(probe, joined));
  const rel = path.relative(rootReal, abs).split(path.sep).join("/");
  if (!opts.allowProtected && isProtected(rel)) throw new BoundaryError(`${rel} is a protected file (credentials or keys). Lumen does not read or change it.`, "protected");
  return { abs, rel: rel || ".", exists: fs.existsSync(abs) };
}

export type RootStatus = "available" | "missing" | "inaccessible" | "not_directory";

/** Availability of a project root, without throwing. */
export function rootStatus(root: string): RootStatus {
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return "not_directory";
    fs.accessSync(root, fs.constants.R_OK);
    return "available";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "inaccessible";
  }
}
