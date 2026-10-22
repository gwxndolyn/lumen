// Deterministic task classification. Keyword routing is enough to choose a response structure, so
// no model call is spent on it; ambiguous requests fall back to "general".

export type TaskCategory =
  | "algorithm"
  | "debugging"
  | "code_explanation"
  | "system_design"
  | "language_framework"
  | "database_sql"
  | "api_backend"
  | "frontend"
  | "testing"
  | "behavioral"
  | "project"
  | "meeting_summary"
  | "general";

export const TASK_LABELS: Record<TaskCategory, string> = {
  algorithm: "Algorithm",
  debugging: "Debugging",
  code_explanation: "Code explanation",
  system_design: "System design",
  language_framework: "Language / framework",
  database_sql: "Database / SQL",
  api_backend: "API / backend",
  frontend: "Frontend",
  testing: "Testing",
  behavioral: "Behavioral",
  project: "Project discussion",
  meeting_summary: "Meeting summary",
  general: "General",
};

const RULES: [TaskCategory, RegExp][] = [
  ["meeting_summary", /\b(summari[sz]e (the |this )?(meeting|call|discussion|conversation|transcript)|meeting (summary|notes|recap)|action items|what did we (agree|decide|discuss)|recap)\b/i],
  [
    "behavioral",
    /\b(tell me about a time|describe a (time|situation)|give me an example of a time|conflict with|disagree(d)? with|biggest (failure|mistake|weakness|strength)|star (method|format|answer|story)|behaviou?ral|leadership|tell me about yourself|why (do you want|this company|should we hire))\b/i,
  ],
  ["project", /\b(walk (me )?through (my|your|a|the) project|my project|project (deep dive|discussion)|on my resume|what i built|my role (in|on))\b/i],
  [
    "debugging",
    /\b(bug|debug|error|exception|traceback|stack ?trace|crash(es|ing)?|fails?|failing|doesn'?t work|not working|wrong (answer|output|result)|segfault|undefined is not|npe|seg(mentation)? ?fault|off[- ]by[- ]one)\b|\w*(exception|error)\b|null ?pointer/i,
  ],
  ["testing", /\b(unit tests?|test cases?|write tests|integration tests?|e2e|end-to-end tests?|mock(ing)?|test coverage|tdd|jest|pytest|junit|vitest|qa)\b/i],
  [
    "database_sql",
    /\b(sql|query|queries|select .* from|join|group by|index(es|ing)?|postgres(ql)?|mysql|sqlite|database|schema|normali[sz]|transaction isolation|nosql|mongodb|dynamo|group (sales|rows|records|orders|users) by|by month|per month)\b/i,
  ],
  [
    "system_design",
    /\b(design (a|an|the) (system|service|platform|url shortener|chat|feed|rate limiter|cache|notification)|system design|scal(e|ability|able) to|at (high|large|massive )?scale|distributed|shard(ing)?|load balanc|high availability|consistency model|cap theorem|million (users|requests))\b/i,
  ],
  ["api_backend", /\b(rest(ful)? api|api (design|endpoint)|endpoints?|grpc|graphql|backend|microservices?|authentication|oauth|jwt|middleware|rate limit|idempoten|webhook|http status)\b/i],
  ["frontend", /\b(react|vue|angular|svelte|css|html|dom|component|hooks?|useeffect|usestate|frontend|front-end|browser|layout|flexbox|grid layout|accessibility|a11y|jetpack compose|swiftui)\b/i],
  [
    "code_explanation",
    /\b(explain (this|the|what this) (code|function|snippet|method|class|query)|what does (this|the) (code|function|line|snippet|regex|regular expression|script|command) do|how does this (code|function) work|walk me through (this|the) code)\b/i,
  ],
  [
    "algorithm",
    /\b(algorithm|leetcode|two sum|array|linked list|binary (tree|search)|bst|graph|bfs|dfs|dynamic programming|\bdp\b|recursion|recursive|iterative|sort(ing|ed)?|heap|priority queue|hash ?map|sliding window|two pointers|backtracking|greedy|trie|substring|subarray|palindrome|time complexity|big[- ]o|o\(n|o\(1\)|o\(log|lru cache|lfu cache|data structure)/i,
  ],
  [
    "language_framework",
    /\b(python|java|javascript|typescript|kotlin|c\+\+|c#|golang|rust|spring|django|flask|express|node(\.js)?|\.net|generics|closures?|async|await|coroutines?|goroutines?|garbage collect|memory model|difference between)\b/i,
  ],
];

export interface Classification {
  category: TaskCategory;
  /** Evidence-based confidence 0–1 (keyword match strength, not a model score). */
  confidence: number;
}

/**
 * Classify a request. `hint` lets context break ties: code on screen or a parsed problem pushes
 * ambiguous requests toward code categories; a meeting session toward summaries.
 */
export function classifyTask(text: string, hint: { sessionType?: string; codeInContext?: boolean; problemKind?: string | null } = {}): Classification {
  for (const [cat, re] of RULES) {
    const m = re.exec(text);
    if (m) return { category: cat, confidence: Math.min(0.95, 0.6 + m[0].length / 50) };
  }
  if (hint.problemKind === "algorithm") return { category: "algorithm", confidence: 0.55 };
  if (hint.problemKind === "sql") return { category: "database_sql", confidence: 0.55 };
  if (hint.problemKind === "system_design") return { category: "system_design", confidence: 0.55 };
  if (hint.problemKind === "debugging") return { category: "debugging", confidence: 0.55 };
  if (hint.codeInContext && /\b(this|it|here)\b/i.test(text)) return { category: "code_explanation", confidence: 0.45 };
  if (hint.sessionType === "meeting" && /\b(discussed|said|mentioned|agreed)\b/i.test(text)) return { category: "meeting_summary", confidence: 0.45 };
  return { category: "general", confidence: 0.3 };
}

export const CODE_CATEGORIES: ReadonlySet<TaskCategory> = new Set(["algorithm", "debugging", "code_explanation", "database_sql", "testing", "frontend", "api_backend", "language_framework"]);
