/** Convert a keydown event into an Electron accelerator string, or null if incomplete. */
export function toAccelerator(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): string | null {
  const mods: string[] = [];
  if (platform === "darwin" ? e.metaKey : e.ctrlKey) mods.push("CommandOrControl");
  if (platform === "darwin" && e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === "Space") key = "Space";
  else if (["Enter", "Tab", "Backspace", "Up", "Down", "Left", "Right"].includes(e.key.replace("Arrow", ""))) key = e.key.replace("Arrow", "");
  if (!key || (mods.length === 0 && !/^F\d/.test(key))) return null;
  return [...mods, key].join("+");
}
