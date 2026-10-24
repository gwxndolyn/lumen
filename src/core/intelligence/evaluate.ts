// Accuracy of the deterministic turn/task rules against a labelled fixture. Used by the eval test
// (floors) and the `eval:intent` report; labels are the ground truth, never adjusted to the rules.

import { classifyTask } from "./classify";
import { resolveTurn, type PriorTurn } from "./turns";

export interface IntentFixture {
  relations: { prior: string | null; text: string; expect: string; hasScreen?: boolean }[];
  ambiguous: { text: string; expect: boolean }[];
  categories: { text: string; expect: string; needsCurrent?: boolean }[];
}

export const PRIORS: Record<string, PriorTurn> = {
  tree: { question: "How do I do an inorder traversal of a binary tree recursively?", answer: "Recurse left, visit, recurse right.\n```python\ndef inorder(root):\n    ...\n```", language: "python" },
  sql: {
    question: "Write a SQL query for the second highest salary in employees",
    answer: "```sql\nSELECT MAX(salary) FROM employees WHERE salary < (SELECT MAX(salary) FROM employees);\n```",
    language: "sql",
  },
  screen: { question: "What is this page about?", answer: "It shows a settings form.", language: null },
};

export interface ClassReport {
  total: number;
  correct: number;
  accuracy: number;
  perLabel: Record<string, { total: number; correct: number }>;
  misses: { text: string; expected: string; got: string }[];
}

function score(rows: { text: string; expected: string; got: string }[]): ClassReport {
  const perLabel: ClassReport["perLabel"] = {};
  const misses: ClassReport["misses"] = [];
  for (const r of rows) {
    const p = (perLabel[r.expected] ??= { total: 0, correct: 0 });
    p.total++;
    if (r.got === r.expected) p.correct++;
    else misses.push(r);
  }
  const correct = rows.length - misses.length;
  return { total: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0, perLabel, misses };
}

export function evaluateIntent(f: IntentFixture) {
  const relations = score(f.relations.map((r) => ({ text: r.text, expected: r.expect, got: resolveTurn(r.text, r.prior ? PRIORS[r.prior]! : null, { hasScreen: !!r.hasScreen }).relation })));
  const ambiguous = score(f.ambiguous.map((r) => ({ text: r.text, expected: String(r.expect), got: String(resolveTurn(r.text, null, { hasScreen: false }).ambiguous) })));
  const categories = score(f.categories.map((r) => ({ text: r.text, expected: r.expect, got: classifyTask(r.text).category })));
  // "Needs current information" is scored on every category item (absent label = false).
  const currentInfo = score(f.categories.map((r) => ({ text: r.text, expected: String(!!r.needsCurrent), got: String(classifyTask(r.text).needsCurrentInfo) })));
  return { relations, ambiguous, categories, currentInfo };
}
