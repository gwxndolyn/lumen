import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Write a file atomically: temp file in the same directory, fsync, then rename over the target. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Remove leftover temp files from interrupted atomic writes. */
export function cleanupTempFiles(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^\..+\.[0-9a-f-]{36}\.tmp$/.test(f)) {
        fs.rmSync(path.join(dir, f), { force: true });
        n++;
      }
    }
  } catch {
    /* directory may not exist yet */
  }
  return n;
}
