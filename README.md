# Lumen — context-aware AI desktop assistant

Lumen is a lightweight desktop assistant with a floating overlay. It answers questions about what's on your screen, your documents and your meetings while you keep working. It's an original implementation with capabilities comparable to Cluely. It is a **visible** assistant: no stealth, no anti-detection, and nothing is captured unless you ask.

## Quick start

Requirements: Node 22.5+ (developed with Node 24.15 and Electron 44.9 on macOS arm64). For setup, permissions, privacy, troubleshooting, the pre-release checklist and platform status, see **[docs/BETA.md](docs/BETA.md)**.

```bash
npm ci
npm start              # build and launch
npm run check          # typecheck + lint + unit/integration tests
npm run release:check  # check + secret scan + shipped-code audit + build
npm run smoke          # real Electron app + UI against local Anthropic/Deepgram stand-ins and the real mic
npm run package:mac    # or package:win: unsigned app in release/
```

On first launch, onboarding asks you to choose an AI provider and add its key: Anthropic, OpenAI, Gemini, or an OpenAI-compatible endpoint. Screen, microphone and system-audio context are all **off by default**. For live transcription, add a Deepgram API key under *Settings → AI provider*.

## Default shortcuts

`Cmd` on macOS, `Ctrl` on Windows. All of them can be rebound under *Settings → Shortcuts*, which also shows conflicts with other apps.

| Action | Shortcut |
|---|---|
| Ask: submit typed text, or ask about the authorized context | ⌘/Ctrl+Enter |
| Show / hide panel (does not steal focus) | ⌘/Ctrl+\\ |
| Capture the screen under the cursor | ⌘/Ctrl+Shift+S |
| Attach copied text | ⌘/Ctrl+Shift+A |
| Stop answer | ⌘/Ctrl+Shift+Backspace (Esc inside the panel) |
| Pause / resume audio | ⌘/Ctrl+Shift+M |
| Discreet input bar | ⌘/Ctrl+Shift+Enter |
| Open main window | ⌘/Ctrl+Shift+L |
| Scroll answer / move panel (only while the panel is visible) | ⌘/Ctrl+Arrows |

## Docs
- [docs/BETA.md](docs/BETA.md): setup, permissions, privacy, diagnostics, release smoke procedure, platform status
- [PRD.md](PRD.md): product requirements, epics, stories, acceptance criteria
- [ARCHITECTURE.md](ARCHITECTURE.md): components, data flows, decisions
- [SECURITY.md](SECURITY.md): threat model and controls
- [ROADMAP.md](ROADMAP.md): status per feature, test matrix, remaining work
- [CHANGELOG.md](CHANGELOG.md)
