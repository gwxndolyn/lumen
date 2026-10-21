# Lumen — context-aware AI desktop assistant

Lumen is a lightweight desktop assistant with a floating overlay. It answers questions about what's on your screen, your documents and your meetings while you keep working. It's an original implementation with capabilities comparable to Cluely. It is a **visible** assistant: no stealth, no anti-detection, and nothing is captured unless you ask.

## Quick start

Requirements: Node 22+ (tested with Node 24.15 and Electron 44.9, on macOS arm64).

```bash
npm install
npm start            # build and launch
npm test             # 82 unit/integration tests (vitest)
npm run typecheck    # strict TypeScript, main + renderer
npm run smoke        # boots the real Electron app and drives the UI end-to-end
npm run package      # unpacked app in release/ (electron-builder)
npm run dist         # platform installer (dmg / nsis / AppImage)
```

On first launch, onboarding asks for:
1. **An Anthropic API key**, used for answers and meeting notes. Or pick *development mode*, which gives clearly labelled mock responses with no AI.
2. **Permissions.** Screen context, microphone and system audio are all **off by default**.

For live transcription, add a **Deepgram API key** under *Settings → AI provider*.

During development you can supply keys as `ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY` environment variables instead. These are never persisted.

## Default shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Show / hide assistant | ⌘⇧Space | Ctrl+Shift+Space |
| Ask about screen (captures the display under the cursor) | ⌘⇧S | Ctrl+Shift+S |
| Open full window | ⌘⇧L | Ctrl+Shift+L |
| In panel: send / newline / stop or hide / new chat / expand | ↵ / ⇧↵ / Esc / ⌘N / ⌘E | |

You can rebind all of these under *Settings → Shortcuts*. If another app already holds a shortcut, the conflict is shown there.

## Docs
- [PRD.md](PRD.md): product requirements, epics, stories, acceptance criteria
- [ARCHITECTURE.md](ARCHITECTURE.md): components, data flows, decisions
- [SECURITY.md](SECURITY.md): threat model and controls
- [ROADMAP.md](ROADMAP.md): status per feature, test matrix, remaining work
- [CHANGELOG.md](CHANGELOG.md)
