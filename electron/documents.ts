import fs from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_DOC_EXTENSIONS = ["txt", "md", "markdown", "csv", "json", "log", "pdf", "html", "htm", "ts", "js", "py", "java", "kt", "go", "rs", "swift", "c", "cpp", "h", "rb", "sql", "yaml", "yml"];

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Extract plain text from a user-selected file. Content is untrusted and is only ever treated as data. */
export async function extractDocumentText(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is larger than 25 MB.`);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!SUPPORTED_DOC_EXTENSIONS.includes(ext)) throw new Error(`.${ext} files are not supported.`);
  const buf = await fs.readFile(file);
  if (ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text.trim()) throw new Error(`${path.basename(file)} has no extractable text (it may be a scanned image).`);
    return text;
  }
  const text = buf.toString("utf8");
  if (ext === "html" || ext === "htm") return htmlToText(text);
  return text;
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
