# Desktop UX notes

## Command palette
⌘K (macOS) / Ctrl+K (Windows) inside Lumen's main window — an in-window key, not a global
shortcut, so it never takes the combination from other apps. Commands are built from live state
each time it opens (e.g. "Pause transcript" only while recording, "Copy latest answer" only when
there is one, provider switches only for providers other than the current one). Fuzzy search,
↑/↓/Enter/Esc, focus is trapped while open and returned on close, and a per-opening guard stops
Enter + click / key-repeat from running a command twice. Also reachable from the sidebar.

## Shortcuts
Global shortcuts were already centralised in `src/core/shortcuts.ts` (one registry, conflict and
duplicate detection with alternatives, scope "visible" for arrow keys so they don't interfere with
other apps while the panel is hidden, cleanup on rebind and quit) and covered by
`src/test/shortcuts.test.ts`. No changes were needed.

## Windows
- The main window now remembers its size, position and maximised state; a saved rect on a
  disconnected display moves back on-screen, never below 860×560.
- The floating panel already persisted bounds per display and recovered from display changes.
- Below 980 px wide the sidebar collapses to icons (with accessible names) and header controls wrap.

## Sessions
Interrupted recordings (Lumen quit or crashed while recording) are closed at startup at their last
transcribed line and kept; a toast says so. Old screen/audio context is never carried into a new
session.

## Context chips
Each chip names its source and when it was added (tooltip, accessible label) and has enable,
pin and remove controls.

## Verified vs not
| | macOS 26 arm64 | Windows |
|---|---|---|
| Palette via real key events (smoke `CP_palette`) | ✅ | ⬜ not run |
| Narrow layout (smoke `UX_narrowLayout`) | ✅ | ⬜ |
| Main-window geometry restore | unit-tested geometry; ⬜ not exercised across a real restart | ⬜ |
| Maximise/restore persistence | ⬜ code path only | ⬜ |
| Screen-reader announcements | ARIA roles/labels in place; ⬜ not tested with VoiceOver/NVDA | ⬜ |
