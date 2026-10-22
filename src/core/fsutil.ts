import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Write a file atomically: temp file in the same directory, fsync, then rename over the target. */
/**
 * Write via a temp file + rename so the destination is either the old file or the complete new one.
 * On any failure (e.g. disk full mid-write) the partial temp file is removed and the error rethrown.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600, io: Pick<typeof fs, "writeSync"> = fs) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    let off = 0;
    // writeSync may write fewer bytes than requested; loop until done.
    while (off < buf.length) off += io.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
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
