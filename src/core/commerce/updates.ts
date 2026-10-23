// Manual update check against a release feed. Lumen never downloads or runs an installer itself:
// it shows the new version and its notes, and opens the release page in the browser, where the
// OS's own signature checks (Gatekeeper / SmartScreen) apply on install.
//
// Feed format (JSON over HTTPS):
// { "latest": "0.4.0", "releasedAt": "2026-11-01", "notes": "…", "url": "https://…/download",
//   "minimumSupported": "0.3.0", "sha256": { "mac-arm64": "…", "win-x64": "…" } }

export interface UpdateFeed {
  latest: string;
  releasedAt?: string;
  notes?: string;
  url: string;
  minimumSupported?: string;
  sha256?: Record<string, string>;
}

export type UpdateCheck =
  | { status: "disabled"; message: string }
  | { status: "up_to_date"; current: string; latest: string; checkedAt: number }
  | { status: "available"; current: string; latest: string; notes: string; url: string; releasedAt: string | null; required: boolean; sha256: Record<string, string>; checkedAt: number }
  | { status: "error"; message: string; checkedAt: number };

/** Compare dotted numeric versions (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: (core ?? "").split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

const VERSION = /^v?\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?$/;

export async function checkForUpdate(opts: { feedUrl: string; current: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): Promise<UpdateCheck> {
  const now = (opts.now ?? Date.now)();
  if (!opts.feedUrl) return { status: "disabled", message: "This build has no update feed. Check the place you downloaded Lumen from for new versions." };
  let u: URL;
  try {
    u = new URL(opts.feedUrl);
  } catch {
    return { status: "error", message: "The update feed address is invalid.", checkedAt: now };
  }
  if (u.protocol !== "https:") return { status: "error", message: "The update feed must use HTTPS.", checkedAt: now };
  let feed: UpdateFeed;
  try {
    const res = await (opts.fetch ?? fetch)(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: "application/json" } });
    if (!res.ok) return { status: "error", message: `The update server answered ${res.status}. Try again later.`, checkedAt: now };
    feed = (await res.json()) as UpdateFeed;
  } catch (e) {
    return {
      status: "error",
      message:
        (e as Error)?.name === "TimeoutError" ? "The update server did not respond. Check your connection and try again." : "Couldn't reach the update server. Check your connection and try again.",
      checkedAt: now,
    };
  }
  if (!feed || typeof feed.latest !== "string" || !VERSION.test(feed.latest) || typeof feed.url !== "string")
    return { status: "error", message: "The update information was not in the expected format.", checkedAt: now };
  let dl: URL;
  try {
    dl = new URL(feed.url);
  } catch {
    return { status: "error", message: "The update information had an invalid download link.", checkedAt: now };
  }
  if (dl.protocol !== "https:") return { status: "error", message: "The download link must use HTTPS.", checkedAt: now };
  if (compareVersions(feed.latest, opts.current) <= 0) return { status: "up_to_date", current: opts.current, latest: feed.latest, checkedAt: now };
  return {
    status: "available",
    current: opts.current,
    latest: feed.latest,
    notes: String(feed.notes ?? "").slice(0, 4000),
    url: dl.toString(),
    releasedAt: feed.releasedAt ?? null,
    required: !!feed.minimumSupported && VERSION.test(feed.minimumSupported) && compareVersions(opts.current, feed.minimumSupported) < 0,
    sha256: Object.fromEntries(Object.entries(feed.sha256 ?? {}).filter(([k, v]) => /^[a-z0-9-]{2,30}$/.test(k) && /^[a-f0-9]{64}$/.test(v))),
    checkedAt: now,
  };
}
