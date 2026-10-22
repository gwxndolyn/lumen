import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../core/fsutil";
import { toUserError } from "../core/errors";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lumen-rel-"));

describe("interrupted writes", () => {
  it("keeps the previous file intact and leaves no temp file when the disk fills mid-write", () => {
    const dir = tmpDir();
    const file = path.join(dir, "export.md");
    fs.writeFileSync(file, "previous complete export");
    let calls = 0;
    const failing = {
      writeSync: (fd: number, buf: Uint8Array, off?: number, len?: number) => {
        if (++calls === 2) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        return fs.writeSync(fd, buf, off, Math.min(len ?? buf.length, 4));
      },
    } as unknown as Pick<typeof fs, "writeSync">;
    expect(() => writeFileAtomic(file, "a much longer new export that will not fit", 0o600, failing)).toThrow(/ENOSPC/);
    expect(fs.readFileSync(file, "utf8")).toBe("previous complete export");
    expect(fs.readdirSync(dir)).toEqual(["export.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles short writes and produces the complete file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "out.txt");
    const short = { writeSync: (fd: number, buf: Uint8Array, off?: number, len?: number) => fs.writeSync(fd, buf, off, Math.min(len ?? buf.length, 3)) } as unknown as Pick<typeof fs, "writeSync">;
    writeFileAtomic(file, "0123456789abcdef", 0o600, short);
    expect(fs.readFileSync(file, "utf8")).toBe("0123456789abcdef");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains a full disk to the user instead of a generic failure", () => {
    expect(toUserError(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })).message).toMatch(/disk is full/);
    expect(toUserError(Object.assign(new Error("EACCES"), { code: "EACCES" })).message).toMatch(/permission/);
  });
});
