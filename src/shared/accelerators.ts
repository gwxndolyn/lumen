/** Human-readable shortcut for the given platform: ⌘↵ on macOS, Ctrl+Enter on Windows/Linux. */
export function formatAccelerator(acc: string, platform: string): string {
  if (!acc) return "Off";
  const mac = platform === "darwin";
  const map: Record<string, [string, string]> = {
    CommandOrControl: ["⌘", "Ctrl"],
    CmdOrCtrl: ["⌘", "Ctrl"],
    Command: ["⌘", "Win"],
    Control: ["⌃", "Ctrl"],
    Shift: ["⇧", "Shift"],
    Alt: ["⌥", "Alt"],
    Enter: ["↵", "Enter"],
    Up: ["↑", "Up"],
    Down: ["↓", "Down"],
    Left: ["←", "Left"],
    Right: ["→", "Right"],
    Space: ["Space", "Space"],
  };
  return acc
    .split("+")
    .map((p) => (map[p] ? map[p]![mac ? 0 : 1] : p))
    .join(mac ? "" : "+");
}
