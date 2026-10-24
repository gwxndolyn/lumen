// Deterministic task classification. Keyword routing is enough to choose a response structure, so
// no model call is spent on it; ambiguous requests fall back to "general".
//
// Two passes, in order:
// 1. Task rules keyed on what the user asks Lumen to DO (write, review, refactor, summarise, plan,
//    take notes, look up something current). The instruction decides the category, not topic words
//    ("Write a TypeScript function…" is code generation, not a TypeScript question).
// 2. Topic rules (the original set) for questions without such an instruction.

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
  | "code_generation"
  | "code_review"
  | "refactoring"
  | "summarization"
  | "research"
  | "planning"
  | "notes"
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
  code_generation: "Code generation",
  code_review: "Code review",
  refactoring: "Refactoring",
  summarization: "Summary",
  research: "Research",
  planning: "Planning",
  notes: "Notes",
  general: "General",
};

/** Code artefacts a generation/review/refactor request can be about. */
const ARTEFACT =
  "(function|method|class|script|program|module|component|hook|endpoint|handler|service|cli|tool|regex|query|wrapper|helper|util(ity)?|parser|decorator|middleware|migration|dockerfile|workflow|test|api|library|snippet|code|implementation)";

/** Pass 1: the user's instruction. Order matters: the first match wins. */
const TASK_RULES: [TaskCategory, RegExp][] = [
  // Meeting artefacts first so "action items from the call" is not generic note-taking.
  [
    "meeting_summary",
    /\b(minutes (for|of|from)|write up (the )?minutes|action items|summari[sz]e (the |this |today'?s )?(meeting|call|standup|sync)|meeting (summary|notes|recap)|recap (the |this |today'?s )?(meeting|call|standup|sync)|what did (we|the team) (agree|decide|discuss)|who('?s| is) (doing|owning|on) what)\b/i,
  ],
  [
    "notes",
    /\b(take notes|make notes|study notes|lecture notes|turn (this|it|the \w+) into (study |lecture )?notes|notes on (this|the) (lecture|talk|video|transcript|chapter|paper)|cornell notes)\b/i,
  ],
  [
    "summarization",
    /\b(summari[sz]e|summary of|tl;?dr|condense|boil (this|it) down|key (points|takeaways)|(give|write) me (a |an |the )?(short |brief )?(overview|abstract|gist)|gist of)\b|\bin (one|a|two|three|five|\d+) (sentence|paragraph|bullet)s?\b/i,
  ],
  [
    "code_review",
    /\b(code review|review (this|my|the|our)\b|(audit|inspect|check) (this|my|the) [\w ]{0,30}\bfor\b|(anything|what'?s|what is) wrong with (this|my|the) (pr|pull request|diff|code|change|function|class)|look over (this|my) (code|pr|diff)|(pr|pull request|diff) review)/i,
  ],
  [
    "refactoring",
    /\b(refactor\w*|clean (up|this)|tidy (up)?|split (this|the|it) ([\w-]+ ){0,2}(into|up)|extract (a |an |the )?(function|method|class|component|hook)|extract (the )?[\w ]{1,30} into (its own|a separate|a new)|decouple|restructure|reduce duplication|make (this|it) (more )?(readable|maintainable|modular))\b/i,
  ],
  [
    "planning",
    /\b(project plan|plan (for|out)|roadmap|break (this|it|the \w+) (down )?into (tasks|steps|tickets|milestones)|milestones|work breakdown|sprint plan|estimates? (for|of)|tasks with estimates|timeline for|migration plan|rollout plan)\b/i,
  ],
  // Writing tests is its own task (cases by category), even though it "writes code".
  ["testing", /\b(write|add|create|generate)\b[^.?!]{0,30}\b(tests?|test cases|test suite|specs?)\b|\b(pytest|jest|junit|vitest) (cases|tests)\b|\bwhat test cases\b/i],
  [
    "code_generation",
    new RegExp(
      `\\b(write|create|generate|implement|build|scaffold|code up)\\b(?!\\s+(\\w+\\s+)?(tests?|test cases?|queries|query|sql|migration)\\b)[^.?!]{0,60}\\b${ARTEFACT}s?\\b|\\b(i need|give me) (a|an) [\\w -]{0,30}\\b(data class|function|class|script|component|hook|endpoint|module|struct|interface|type)\\b|\\b(boilerplate|starter code)\\b`,
      "i",
    ),
  ],
];

/**
 * Requests that depend on information newer than a model's training data. Matched separately from
 * the category so a "latest version" question about any topic is flagged.
 */
const CURRENT_INFO =
  /\b(latest|newest|current(ly)?|today'?s?|this (week|month|year)|right now|as of (now|today)|recent(ly)?|up[- ]to[- ]date|still (supported|maintained)|(been|was it|is it) released|released yet|release date|price of|stock price|news|announced|yesterday|last (week|month))\b/i;
const RESEARCH =
  /\b(find (sources|papers|articles|references|evidence)|cite sources|with (sources|citations|references)|literature (review|on|say)|what (do|does) (recent |the )?(studies|benchmarks|papers|sources|research|literature) say|look up|search (the web|online) for)\b/i;

const RULES: [TaskCategory, RegExp][] = [
  ["meeting_summary", /\b(summari[sz]e (the |this )?(meeting|call|discussion|conversation|transcript)|meeting (summary|notes|recap)|action items|what did we (agree|decide|discuss)|recap)\b/i],
  [
    "behavioral",
    /\b(tell me about a time|describe a (time|situation)|give me an example of a time|conflict with|disagree(d)? with|biggest (failure|mistake|weakness|strength)|star (method|format|answer|story)|behaviou?ral|leadership|tell me about yourself|why (do you want|this company|should we hire))\b/i,
  ],
  ["project", /\b(walk (me )?through (my|your|a|the) project|my project|project (deep dive|discussion)|on my resume|what i built|my role (in|on))\b/i],
  [
    "debugging",
    /\b(bug|debug|error|exception|traceback|stack ?trace|crash(es|ing)?|fails?|failing|doesn'?t work|not working|wrong (answer|output|result)|leak(s|ing|ed)?|freez(e|es|ing)|froze|hang(s|ing)?|hung|segfault|exits? (immediately|with (code|status))|exit (code|status) \d+|times? out|timed out|out of memory|undefined is not|npe|seg(mentation)? ?fault|off[- ]by[- ]one)\b|\w*(exception|error)\b|null ?pointer/i,
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
    /\b(explain (this|the|what this) (code|function|snippet|method|class|query)|explain what (this|the) [\w -]{0,20}(regex|script|function|code|query|command|one-liner|snippet)s? (does|do|means)|what does (this|the) (code|function|line|snippet|regex|regular expression|script|command) do|how does this (code|function) work|walk me through (this|the) code)\b/i,
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
  /** The answer may depend on information newer than the model's training data. */
  needsCurrentInfo: boolean;
}

/**
 * Classify a request. `hint` lets context break ties: code on screen or a parsed problem pushes
 * ambiguous requests toward code categories; a meeting session toward summaries.
 */
/** "Today's standup", "this week's sync": time words about the user's own meeting, not the outside world. */
const OWN_EVENT = /\b(today'?s|this (week|morning)'?s?|yesterday'?s|last week'?s)\s+(meeting|call|standup|sync|retro|lecture|session|notes)\b|\b(meeting|call|standup|sync) (today|yesterday)\b/i;

export function classifyTask(text: string, hint: { sessionType?: string; codeInContext?: boolean; problemKind?: string | null } = {}): Classification {
  const needsCurrentInfo = CURRENT_INFO.test(text) && !OWN_EVENT.test(text);
  const out = (category: TaskCategory, confidence: number): Classification => ({ category, confidence, needsCurrentInfo });
  // A question about why something fails is debugging even if it names tests ("why does my test time out").
  const symptom = /^\s*(why|how come)\b/i.test(text) && RULES.find(([c]) => c === "debugging")![1].test(text);
  if (!symptom)
    for (const [cat, re] of TASK_RULES) {
      const m = re.exec(text);
      if (m) return out(cat, Math.min(0.95, 0.65 + m[0].length / 60));
    }
  if (needsCurrentInfo || RESEARCH.test(text)) return out("research", needsCurrentInfo ? 0.7 : 0.6);
  for (const [cat, re] of RULES) {
    const m = re.exec(text);
    if (m) return out(cat, Math.min(0.95, 0.6 + m[0].length / 50));
  }
  if (hint.problemKind === "algorithm") return out("algorithm", 0.55);
  if (hint.problemKind === "sql") return out("database_sql", 0.55);
  if (hint.problemKind === "system_design") return out("system_design", 0.55);
  if (hint.problemKind === "debugging") return out("debugging", 0.55);
  if (hint.codeInContext && /\b(this|it|here)\b/i.test(text)) return out("code_explanation", 0.45);
  if (hint.sessionType === "meeting" && /\b(discussed|said|mentioned|agreed)\b/i.test(text)) return out("meeting_summary", 0.45);
  return out("general", 0.3);
}

export const CODE_CATEGORIES: ReadonlySet<TaskCategory> = new Set([
  "algorithm",
  "debugging",
  "code_explanation",
  "database_sql",
  "testing",
  "frontend",
  "api_backend",
  "language_framework",
  "code_generation",
  "code_review",
  "refactoring",
]);
