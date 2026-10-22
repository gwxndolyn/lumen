// Small, dependency-free syntax tokenizer for code blocks. Returns plain tokens that the renderer
// wraps in <span>s, so model output is never interpreted as HTML. Coverage is deliberately
// approximate (keywords, strings, comments, numbers) — good enough to scan code quickly.

export type TokenKind = "kw" | "str" | "com" | "num" | "fn" | "plain";
export interface Token {
  kind: TokenKind;
  text: string;
}

const C_LIKE = "if else for while do switch case default break continue return try catch finally throw new delete class struct interface enum extends implements public private protected static final const let var void null true false this super import export from package namespace using typeof instanceof in of async await yield";
const KEYWORDS: Record<string, string> = {
  python: "def class if elif else for while try except finally raise return import from as with lambda yield pass break continue and or not in is None True False global nonlocal async await self",
  javascript: `${C_LIKE} function undefined`,
  typescript: `${C_LIKE} function undefined type readonly keyof as number string boolean any unknown never`,
  java: `${C_LIKE} int long double float boolean char byte short abstract synchronized throws`,
  kotlin: "fun val var class object interface if else when for while do try catch finally throw return import package null true false this super is in as data sealed override private public internal",
  cpp: `${C_LIKE} int long double float bool char auto unsigned signed template typename std vector nullptr`,
  csharp: `${C_LIKE} int long double float bool char string var foreach readonly override virtual`,
  go: "func package import var const type struct interface map chan go defer select if else for range switch case default return break continue nil true false",
  rust: "fn let mut const struct enum impl trait pub use mod match if else for while loop return break continue self Self None Some Ok Err true false as ref where",
  sql: "select from where join inner left right outer on group by order having limit offset insert into values update set delete create table index as and or not null is in distinct count sum avg min max union all case when then else end with",
};
const ALIASES: Record<string, string> = { py: "python", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", "c++": "cpp", c: "cpp", cs: "csharp", "c#": "csharp", kt: "kotlin", rs: "rust", golang: "go", postgresql: "sql", mysql: "sql" };

const kwCache = new Map<string, Set<string>>();
function keywords(lang: string): Set<string> | null {
  const id = ALIASES[lang] ?? lang;
  const src = KEYWORDS[id];
  if (!src) return null;
  let set = kwCache.get(id);
  if (!set) kwCache.set(id, (set = new Set(src.split(" "))));
  return set;
}

export function highlight(code: string, lang: string): Token[] {
  const l = lang.toLowerCase().trim();
  const kw = keywords(l);
  if (!kw || code.length > 100_000) return [{ kind: "plain", text: code }];
  const id = ALIASES[l] ?? l;
  const hashComment = id === "python";
  const sql = id === "sql";
  const re = hashComment
    ? /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(#[^\n]*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)/g
    : sql
      ? /('(?:''|[^'])*')|(--[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g
      : /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\b\d[\d_]*(?:\.\d+)?[fFlLuU]?\b)|([A-Za-z_]\w*)/g;
  const out: Token[] = [];
  let last = 0;
  const push = (kind: TokenKind, text: string) => {
    const prev = out.at(-1);
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ kind, text });
  };
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) push("plain", code.slice(last, m.index));
    if (m[1]) push("str", m[1]);
    else if (m[2]) push("com", m[2]);
    else if (m[3]) push("num", m[3]);
    else {
      const w = m[4]!;
      const isKw = sql ? kw.has(w.toLowerCase()) : kw.has(w);
      push(isKw ? "kw" : code[re.lastIndex] === "(" ? "fn" : "plain", w);
    }
    last = re.lastIndex;
  }
  if (last < code.length) push("plain", code.slice(last));
  return out;
}
