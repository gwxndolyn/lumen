import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeDoc, KnowledgeImportResult } from "../shared/types";
import { chunkText, contentHash, normalizeText } from "./context/text";
import type { Store } from "./storage/db";

export const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "rst", "ts", "tsx", "js", "jsx", "py", "java", "kt", "go", "rs", "swift", "c", "cpp", "h", "hpp", "cs", "rb", "php", "sql", "yaml", "yml", "toml", "xml", "sh"];
export const SUPPORTED_DOC_EXTENSIONS = [...TEXT_EXTENSIONS, "pdf", "docx", "html", "htm"];

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FOLDER_FILES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "dist", "build", "target", ".venv", "__pycache__", ".idea", ".vscode"]);

export class ImportError extends Error {}

export function formatOf(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (TEXT_EXTENSIONS.includes(ext)) return ext === "txt" || ext === "log" ? "text" : "code";
  return ext || "unknown";
}

/** Extract plain text from a user-selected file. Content is untrusted and is only ever treated as data. */
export async function extractDocumentText(file: string): Promise<string> {
  const name = path.basename(file);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new ImportError(`${name} could not be read.`);
  }
  if (!stat.isFile()) throw new ImportError(`${name} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new ImportError(`${name} is larger than 25 MB.`);
  if (stat.size === 0) throw new ImportError(`${name} is empty.`);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!SUPPORTED_DOC_EXTENSIONS.includes(ext)) throw new ImportError(`.${ext || "(no extension)"} files are not supported.`);
  const buf = await fs.readFile(file);
  let text: string;
  try {
    if (ext === "pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      text = (await extractText(pdf, { mergePages: true })).text;
      if (!text.trim()) throw new ImportError(`${name} has no extractable text (it may be a scanned image — capture it as a screenshot to use OCR).`);
    } else if (ext === "docx") {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else {
      if (looksBinary(buf)) throw new ImportError(`${name} does not look like a text file.`);
      text = buf.toString("utf8");
      if (ext === "html" || ext === "htm") text = htmlToText(text);
    }
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(`${name} could not be parsed (${ext.toUpperCase()}).`);
  }
  return text;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) zeros++;
  return zeros > 0 && zeros / n > 0.01;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/** Expand user-selected folders into supported files (bounded, skipping build/VCS directories). */
export async function expandSelection(paths: string[]): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const walk = async (p: string, depth: number) => {
    if (files.length >= MAX_FOLDER_FILES) {
      skipped++;
      return;
    }
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      skipped++;
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (depth > 6 || SKIP_DIRS.has(path.basename(p)) || path.basename(p).startsWith(".")) return;
      for (const e of (await fs.readdir(p)).sort()) await walk(path.join(p, e), depth + 1);
      return;
    }
    if (SUPPORTED_DOC_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase())) files.push(p);
    else if (depth === 0) files.push(p); // explicitly chosen file: let import report why it failed
    else skipped++;
  };
  for (const p of paths) await walk(p, 0);
  return { files, skipped };
}

/** Import user-selected files/folders into the knowledge base (global, or attached to a session). */
export async function importKnowledge(store: Store, paths: string[], sessionId: string | null): Promise<KnowledgeImportResult> {
  const { files, skipped } = await expandSelection(paths);
  const imported: KnowledgeDoc[] = [];
  const failed: { file: string; reason: string }[] = [];
  for (const file of files) {
    try {
      const text = normalizeText(await extractDocumentText(file));
      if (!text) throw new ImportError(`${path.basename(file)} contains no text.`);
      const hash = contentHash(text);
      const existing = store.findDocByHash(hash, sessionId);
      if (existing) {
        failed.push({ file: path.basename(file), reason: `Already imported as “${existing.title}”.` });
        continue;
      }
      imported.push(store.addKnowledgeDoc({ title: path.basename(file), source: file, chunks: chunkText(text), sessionId, format: formatOf(file), hash }));
    } catch (err) {
      failed.push({ file: path.basename(file), reason: err instanceof ImportError ? err.message : "Unexpected error while importing." });
    }
  }
  return { imported, failed, skipped };
}

export function addKnowledgeText(store: Store, title: string, text: string, sessionId: string | null): KnowledgeDoc {
  const t = normalizeText(text);
  if (!t) throw new ImportError("The note is empty.");
  return store.addKnowledgeDoc({ title: title.trim() || "Untitled note", source: "manual", chunks: chunkText(t), sessionId, format: "note", hash: contentHash(t) });
}
