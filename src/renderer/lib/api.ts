import type { LumenApi } from "../../shared/api";

declare global {
  interface Window {
    lumen: LumenApi;
  }
}

export const api: LumenApi = window.lumen;

export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

export function prettyAccelerator(acc: string, platform = api?.platform): string {
  const mac = platform === "darwin";
  return acc
    .split("+")
    .map((p) =>
      p === "CommandOrControl" || p === "CmdOrCtrl" ? (mac ? "⌘" : "Ctrl") : p === "Shift" ? (mac ? "⇧" : "Shift") : p === "Alt" ? (mac ? "⌥" : "Alt") : p,
    )
    .join(mac ? "" : "+");
}

export function usd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}
