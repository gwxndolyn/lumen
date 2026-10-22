import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../src/core/fsutil";

import type { SecretName } from "../src/shared/types";
export type { SecretName };

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

const ENV: Record<SecretName, string> = { anthropic: "ANTHROPIC_API_KEY", deepgram: "DEEPGRAM_API_KEY", openai_compat: "LUMEN_OPENAI_COMPAT_API_KEY" };

/**
 * API keys are encrypted with the OS credential store (Electron safeStorage: Keychain on macOS,
 * DPAPI on Windows, libsecret/kwallet on Linux) and only ever decrypted in the main process.
 * The renderer only learns whether a key is present. If OS encryption is unavailable the key is
 * kept in memory for this session only — never written to disk in plain text.
 */
export class SecretStore {
  private readonly file: string;
  private memory = new Map<SecretName, string>();
  /** Keys that exist on disk but could not be decrypted (e.g. keychain reset, profile copied). */
  readonly unreadable = new Set<SecretName>();

  constructor(
    dir: string,
    private readonly cipher: Cipher,
  ) {
    this.file = path.join(dir, "secrets.json");
  }

  private readDisk(): Partial<Record<SecretName, string>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Record<SecretName, string>>;
    } catch {
      return {};
    }
  }

  get(name: SecretName): string | null {
    const mem = this.memory.get(name);
    if (mem) return mem;
    const enc = this.readDisk()[name];
    if (enc && this.cipher.isEncryptionAvailable()) {
      try {
        const v = this.cipher.decryptString(Buffer.from(enc, "base64"));
        this.unreadable.delete(name);
        return v;
      } catch {
        this.unreadable.add(name);
        return null;
      }
    }
    // Development convenience: environment variable, never persisted.
    return process.env[ENV[name]]?.trim() || null;
  }

  has(name: SecretName): boolean {
    return !!this.get(name);
  }

  set(name: SecretName, value: string) {
    const v = value.trim();
    if (!v || v.length > 512 || /\s/.test(v)) throw new Error("That does not look like a valid API key.");
    if (!this.cipher.isEncryptionAvailable()) {
      this.memory.set(name, v);
      return;
    }
    const disk = this.readDisk();
    disk[name] = this.cipher.encryptString(v).toString("base64");
    writeFileAtomic(this.file, JSON.stringify(disk));
    this.memory.delete(name);
  }

  clear(name: SecretName) {
    this.memory.delete(name);
    const disk = this.readDisk();
    delete disk[name];
    writeFileAtomic(this.file, JSON.stringify(disk));
  }

  get encryptionAvailable() {
    return this.cipher.isEncryptionAvailable();
  }
}
