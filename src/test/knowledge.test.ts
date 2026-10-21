import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expandSelection, extractDocumentText, formatOf, importKnowledge } from "../core/knowledge";
import { Store } from "../core/storage/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-docs-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Minimal valid single-page PDF with a text layer. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** Minimal .docx (zip with document.xml), built with Node's zlib-free STORE method. */
function makeDocx(text: string): Buffer {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameB = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("document extraction", () => {
  it("extracts text from PDF, DOCX, HTML, Markdown and code", async () => {
    const files: Record<string, Buffer | string> = {
      "report.pdf": makePdf("Quarterly revenue grew twelve percent"),
      "memo.docx": makeDocx("The offsite is in Lisbon"),
      "page.html": "<html><body><h1>Title</h1><script>evil()</script><p>Visible &amp; safe</p></body></html>",
      "readme.md": "# Setup\nRun npm install",
      "main.py": "def add(a, b):\n    return a + b\n",
    };
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    expect(await extractDocumentText(path.join(dir, "report.pdf"))).toContain("Quarterly revenue grew twelve percent");
    expect(await extractDocumentText(path.join(dir, "memo.docx"))).toContain("The offsite is in Lisbon");
    const html = await extractDocumentText(path.join(dir, "page.html"));
    expect(html).toContain("Visible & safe");
    expect(html).not.toContain("evil");
    expect(await extractDocumentText(path.join(dir, "readme.md"))).toContain("npm install");
    expect(formatOf("x.py")).toBe("code");
    expect(formatOf("x.docx")).toBe("docx");
  });

  it("fails clearly on unsupported, empty, binary and corrupt files", async () => {
    fs.writeFileSync(path.join(dir, "a.exe"), "MZ");
    fs.writeFileSync(path.join(dir, "empty.md"), "");
    fs.writeFileSync(path.join(dir, "bin.txt"), Buffer.from(Array.from({ length: 2000 }, (_, i) => (i % 3 ? 0 : 65))));
    fs.writeFileSync(path.join(dir, "broken.docx"), "not a zip");
    await expect(extractDocumentText(path.join(dir, "a.exe"))).rejects.toThrow(/not supported/);
    await expect(extractDocumentText(path.join(dir, "empty.md"))).rejects.toThrow(/empty/);
    await expect(extractDocumentText(path.join(dir, "bin.txt"))).rejects.toThrow(/does not look like a text file/);
    await expect(extractDocumentText(path.join(dir, "broken.docx"))).rejects.toThrow(/could not be parsed/);
    await expect(extractDocumentText(path.join(dir, "missing.md"))).rejects.toThrow(/could not be read/);
  });

  it("folder expansion only includes supported files and skips VCS/build dirs", async () => {
    const root = path.join(dir, "proj");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config.md"), "x");
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(root, "logo.png"), "png");
    const r = await expandSelection([root]);
    expect(r.files.map((f) => path.basename(f))).toEqual(["a.ts"]);
    expect(r.skipped).toBe(1);
  });

  it("imports into a session scope and isolates retrieval by session", async () => {
    const store = new Store(":memory:");
    const a = store.createSession({ title: "A", type: "general" });
    const b = store.createSession({ title: "B", type: "general" });
    fs.writeFileSync(path.join(dir, "secret.md"), "The vault code is orchid.");
    const r = await importKnowledge(store, [path.join(dir, "secret.md")], a.id);
    expect(r.imported[0]!.sessionId).toBe(a.id);
    expect(store.searchKnowledge("vault code", a.id)).toHaveLength(1);
    expect(store.searchKnowledge("vault code", b.id)).toHaveLength(0);
    expect(store.searchKnowledge("vault code", null)).toHaveLength(0);
  });
});
