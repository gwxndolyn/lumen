// Minimal, safe Markdown renderer. It produces React elements only — model output is never
// passed to innerHTML, links are never auto-navigated, and images are not rendered, so
// generated content cannot inject markup, scripts or tracking pixels.
import { Fragment, useState, type ReactNode } from "react";
import type { ContextReference } from "../../shared/types";

export type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "para"; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or EOF while streaming)
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) items.push(m[2]!);
        else if (/^\s{2,}\S/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*([-*+]|\d+[.)])\s+|\s*>)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ type: "para", text: para.join("\n") });
  }
  return blocks;
}

interface InlineOpts {
  refs: ContextReference[];
  onLink: (url: string) => void;
}

/** Inline formatting: `code`, **bold**, *italic*, [text](https://…), and [C1] citations. */
export function renderInline(text: string, opts: InlineOpts, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\[(C\d+(?:\s*,\s*C\d+)*)\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${k++}`;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{renderInline(m[2].slice(2, -2), opts, key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const url = m[6]!;
      out.push(
        <button key={key} className="link" title={url} onClick={() => opts.onLink(url)}>
          {m[5]}
        </button>,
      );
    } else if (m[7]) {
      for (const label of m[8]!.split(/\s*,\s*/)) {
        const ref = opts.refs.find((r) => r.label === label);
        out.push(
          <span key={`${key}-${label}`} className="cite" title={ref ? `${ref.title}\n\n${ref.excerpt}` : "Unknown source"} tabIndex={0}>
            {label}
          </span>,
        );
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, text, onCopy }: { lang: string; text: string; onCopy: (t: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <header>
        <span>{lang || "code"}</span>
        <button
          className="btn ghost sm"
          onClick={() => {
            onCopy(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function Markdown({
  text,
  refs = [],
  streaming = false,
  onCopy,
  onLink,
}: {
  text: string;
  refs?: ContextReference[];
  streaming?: boolean;
  onCopy: (t: string) => void;
  onLink: (url: string) => void;
}) {
  const blocks = parseBlocks(text);
  const opts = { refs, onLink };
  const lines = (t: string, key: string) =>
    t.split("\n").map((l, j, arr) => (
      <Fragment key={`${key}-${j}`}>
        {renderInline(l, opts, `${key}-${j}`)}
        {j < arr.length - 1 && <br />}
      </Fragment>
    ));
  return (
    <div className={`md${streaming ? " cursor-blink" : ""}`}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "code":
            return <CodeBlock key={key} lang={b.lang} text={b.text} onCopy={onCopy} />;
          case "heading": {
            const Tag = `h${Math.min(b.level + 1, 4)}` as "h2" | "h3" | "h4";
            return <Tag key={key}>{renderInline(b.text, opts, key)}</Tag>;
          }
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, opts, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return <blockquote key={key}>{lines(b.text, key)}</blockquote>;
          case "hr":
            return <hr key={key} />;
          case "table":
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.header.map((h, j) => (
                      <th key={j}>{renderInline(h, opts, `${key}-h${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, x) => (
                        <td key={x}>{renderInline(c, opts, `${key}-${j}-${x}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return <p key={key}>{lines(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
