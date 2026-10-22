const PUNCT: Record<string, string> = {
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Equal: "=",
  Minus: "-",
};

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
  else if (e.code in PUNCT) key = PUNCT[e.code]!;
  else if (e.code === "Enter" || e.code === "NumpadEnter") key = "Enter";
  else if (["Tab", "Backspace", "Up", "Down", "Left", "Right"].includes(e.key.replace("Arrow", ""))) key = e.key.replace("Arrow", "");
  if (!key || (mods.length === 0 && !/^F\d/.test(key))) return null;
  // Shift alone would intercept ordinary capital letters / symbols.
  if (mods.length === 1 && mods[0] === "Shift" && !/^F\d/.test(key)) return null;
  return [...mods, key].join("+");
}
