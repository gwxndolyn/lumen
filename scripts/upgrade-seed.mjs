// Seeds a profile using an OLD build's compiled Store and settings (see scripts/smoke-upgrade.sh).
// Seed a profile with the OLD build's own Store and settings code (schema of that version).
const dir = process.argv[2],
  profile = process.argv[3];
const { Store } = await import(`${dir}/dist-electron/src/core/storage/db.js`);
const { DEFAULT_SETTINGS } = await import(`${dir}/dist-electron/src/shared/defaults.js`);
const { applySettingsPatch } = await import(`${dir}/dist-electron/src/shared/settingsSchema.js`);
const store = new Store(`${profile}/lumen.db`);
const s = store.createSession({ title: "From 0.3.0-old", type: "meeting", notes: "Old notes" });
const c = store.createConversation(s.id, "Old chat", "meeting");
store.addMessage({ conversationId: c.id, role: "user", content: "What did we decide?", references: [], meta: {} });
store.addMessage({ conversationId: c.id, role: "assistant", content: "Ship Thursday.", references: [], meta: { model: "claude-opus-5-5" } });
const t = store.createTranscriptSession(s.id, "Standup", "deepgram");
store.addSegment({ sessionId: t.id, startMs: 0, endMs: 2000, speaker: "A", channel: null, text: "Ship Thursday", confidence: 0.9 });
store.endTranscriptSession(t.id);
store.addMemory({ kind: "convention", text: "Use Kotlin coroutines", sessionId: null, expiresAt: null });
store.recordUsage("claude-opus-5-5", 1000, 100, 0.006);
const settings = applySettingsPatch(DEFAULT_SETTINGS, {
  onboardingComplete: true,
  activeSessionId: s.id,
  theme: "light",
  provider: { kind: "gemini", dailySpendLimitUsd: 2 },
  privacy: { conversationRetentionDays: 0 },
});
store.setKv("settings", JSON.stringify(settings));
console.log(JSON.stringify({ schema: store.schemaVersion(), session: s.id }));
store.close();
