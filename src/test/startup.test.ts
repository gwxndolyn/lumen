import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempFiles, writeFileAtomic } from "../core/fsutil";
import { MIGRATIONS } from "../core/storage/db";
import { openStore } from "../core/storage/open";
import { toUserError } from "../core/errors";
import { loadSettingsJson } from "../shared/settingsSchema";
import { DEFAULT_SETTINGS } from "../shared/defaults";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-start-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("openStore", () => {
  it("opens a fresh database", () => {
    const f = path.join(tmp(), "lumen.db");
    const { store, outcome } = openStore(f);
    expect(outcome.kind).toBe("ok");
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    store.close();
  });

  it("backs up before migrating an older database and keeps the data", () => {
    const f = path.join(tmp(), "lumen.db");
    const raw = new DatabaseSync(f);
    raw.exec(MIGRATIONS[0]!);
    raw.exec("PRAGMA user_version = 1");
    raw.exec("INSERT INTO conversations VALUES ('c1','Old','general',1,1)");
    raw.close();
    const { store, outcome } = openStore(f);
    expect(outcome).toMatchObject({ kind: "migrated", from: 1, to: MIGRATIONS.length });
    if (outcome.kind !== "migrated") throw new Error();
    expect(fs.existsSync(outcome.backup)).toBe(true);
    const b = new DatabaseSync(outcome.backup);
    expect((b.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    b.close();
    expect(store.getConversation("c1")).not.toBeNull();
    store.close();
  });

  it("quarantines a corrupt file and starts fresh without deleting it", () => {
    const d = tmp();
    const f = path.join(d, "lumen.db");
    fs.writeFileSync(f, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, 7)]));
    const { store, outcome } = openStore(f);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind !== "recovered") throw new Error();
    expect(fs.existsSync(outcome.quarantined)).toBe(true);
    expect(store.listSessions()).toEqual([]);
    store.close();
  });

  it("quarantines when a migration fails, leaving a usable database", () => {
    const f = path.join(tmp(), "lumen.db");
    openStore(f).store.close();
    const broken = [...MIGRATIONS, "CREATE TABLE broken (;"];
    const { store, outcome } = openStore(f, broken);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind !== "recovered") throw new Error();
    expect(outcome.reason).toMatch(/migration/);
    store.close();
  });

  it("refuses (does not quarantine) a database from a newer version", () => {
    const f = path.join(tmp(), "lumen.db");
    const raw = new DatabaseSync(f);
    raw.exec("PRAGMA user_version = 999");
    raw.close();
    expect(() => openStore(f)).toThrow(/newer Lumen/);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe("settings & errors", () => {
  it("loads corrupt settings JSON as defaults instead of throwing", () => {
    expect(loadSettingsJson("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(loadSettingsJson(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettingsJson(JSON.stringify({ theme: "light" })).theme).toBe("light");
  });

  it("maps storage failures to actionable messages", () => {
    expect(toUserError(Object.assign(new Error("database or disk is full"), { errcode: 13 })).message).toMatch(/disk is full/);
    expect(toUserError(Object.assign(new Error("x"), { code: "ENOSPC" })).code).toBe("storage");
    expect(toUserError(new Error("database disk image is malformed")).message).toMatch(/damaged/);
    expect(toUserError(new Error("weird")).code).toBe("unknown");
  });

  it("writes files atomically and cleans up interrupted temp files", () => {
    const d = tmp();
    const f = path.join(d, "secrets.json");
    writeFileAtomic(f, '{"a":1}');
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}');
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(d, ".secrets.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"), "partial");
    expect(cleanupTempFiles(d)).toBe(1);
    expect(fs.readdirSync(d)).toEqual(["secrets.json"]);
  });
});

describe("data file permissions", () => {
  it.skipIf(process.platform === "win32")("the database and its folder are owner-only", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lumen-perm-")), "data");
    const { store } = openStore(path.join(dir, "lumen.db"));
    store.createSession({ title: "x", type: "general" });
    expect(fs.statSync(path.join(dir, "lumen.db")).mode & 0o077).toBe(0);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
    store.close();
  });
});
