import { describe, expect, it } from "vitest";
import { classifyQuestion, isQuestionText, QuestionDetector, similarity } from "../core/interview/questions";
import { detectLanguage, normalizeNotation, parseProblem, problemToContext } from "../core/technical/problem";
import { interviewPrompt, technicalPrompt } from "../core/workflows";
import type { TranscriptSegment } from "../shared/types";

let n = 0;
const seg = (text: string, startMs: number, opts: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: `s${n++}`,
  sessionId: "t",
  startMs,
  endMs: startMs + 1500,
  speaker: "Remote Speaker 1",
  channel: "system",
  text,
  edited: false,
  confidence: 0.9,
  ...opts,
});

describe("question detection", () => {
  it("recognizes questions and ignores filler", () => {
    expect(isQuestionText("Tell me about a time you disagreed with a teammate.")).toBe(true);
    expect(isQuestionText("How would you design a rate limiter?")).toBe(true);
    expect(isQuestionText("Does that make sense?")).toBe(false);
    expect(isQuestionText("Okay.")).toBe(false);
    expect(isQuestionText("That's a great point, thanks for sharing.")).toBe(false);
  });

  it("classifies categories", () => {
    expect(classifyQuestion("Tell me about yourself").category).toBe("introduction");
    expect(classifyQuestion("Tell me about a time you failed").category).toBe("behavioral");
    expect(classifyQuestion("How would you design a URL shortener for a million users?").category).toBe("system_design");
    expect(classifyQuestion("What's the time complexity of your algorithm on a binary tree?").category).toBe("coding");
    expect(classifyQuestion("Why did you choose Postgres instead of DynamoDB?").category).toBe("tradeoff");
    expect(classifyQuestion("What is the difference between a process and a thread?").category).toBe("technical");
  });

  it("joins a multi-sentence question, waits for the debounce, and only emits once", () => {
    let t = 0;
    const d = new QuestionDetector({ debounceMs: 1000, now: () => t });
    d.push(seg("Okay great.", 0));
    d.push(seg("So tell me about a time you had a conflict", 1600));
    d.push(seg("with a colleague, and how you resolved it?", 3200));
    t = 500;
    expect(d.poll()).toBeNull(); // still inside debounce window
    t = 2000;
    const q = d.poll()!;
    // The separate "Okay great." (100 ms gap > lead-in limit) is filler and is not part of the question.
    expect(q.text).toBe("So tell me about a time you had a conflict with a colleague, and how you resolved it?");
    expect(q.category).toBe("behavioral");
    expect(d.poll()).toBeNull();
  });

  it("suppresses repeated / rephrased questions and duplicate segment delivery", () => {
    let t = 0;
    const d = new QuestionDetector({ debounceMs: 100, now: () => t });
    const a = seg("How would you design a rate limiter for an API?", 0);
    d.push(a);
    d.push(a); // duplicate delivery
    t = 200;
    expect(d.poll()?.text).toBe("How would you design a rate limiter for an API?");
    d.push(seg("So how would you design a rate limiter for the API?", 5000));
    t = 400;
    expect(d.poll()).toBeNull();
    expect(similarity("design a rate limiter", "design rate limiter API")).toBeGreaterThan(0.5);
  });

  it("does not treat the candidate's own speech as a question", () => {
    let t = 0;
    const d = new QuestionDetector({ debounceMs: 100, now: () => t, interviewer: "remote" });
    d.push(seg("What should I say next?", 0, { channel: "mic", speaker: "You" }));
    t = 500;
    expect(d.poll()).toBeNull();
  });

  it("treats non-questions as nothing to answer", () => {
    let t = 0;
    const d = new QuestionDetector({ debounceMs: 100, now: () => t });
    d.push(seg("Thanks, I'll share the notes after the call.", 0));
    t = 500;
    expect(d.poll()).toBeNull();
  });
});

const TWO_SUM = `1. Two Sum
Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.
You may assume that each input would have exactly one solution.

Example 1:
Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: Because nums[0] + nums[1] == 9, we return [0, 1].

Constraints:
2 <= nums.length <= 10^4
-10^9 <= nums[i] <= 10^9
Only one valid answer exists.`;

describe("technical problem parsing", () => {
  it("extracts title, statement, examples and constraints, and infers a complexity target", () => {
    const p = parseProblem(TWO_SUM);
    expect(p.title).toBe("Two Sum");
    expect(p.statement).toMatch(/^Given an array of integers/);
    expect(p.examples).toEqual([{ input: "nums = [2,7,11,15], target = 9", output: "[0,1]", explanation: "Because nums[0] + nums[1] == 9, we return [0, 1]." }]);
    expect(p.constraints).toContain("2 <= nums.length <= 10^4");
    expect(p.kind).toBe("algorithm");
    expect(p.missing).toEqual([]);
    expect(p.complexityHint).toMatch(/O\(n log n\)|O\(n\)|O\(n\^2\)/);
  });

  it("repairs common OCR notation damage without inventing content", () => {
    expect(normalizeNotation("1 ≤ n ≤ 105 and k − 1")).toBe("1 <= n <= 10^5 and k - 1");
    const p = parseProblem("Find the max.\nConstraints:\n1 ≤ n ≤ 105");
    expect(p.constraints).toEqual(["1 <= n <= 10^5"]);
  });

  it("reports what is missing instead of guessing", () => {
    const p = parseProblem("Given an array, return the");
    expect(p.looksTruncated).toBe(true);
    expect(p.missing.join(" ")).toMatch(/cut off/);
    const q = parseProblem("Given an array of integers return the longest increasing subsequence length.\nExample:\nInput: [1,3,2]\nOutput: 2");
    expect(q.missing).toContain("the constraints (input sizes / value ranges)");
  });

  it("detects starter-code language and signature, preserving indentation", () => {
    const p = parseProblem("Reverse the list.\n```python\nclass Solution:\n    def reverseList(self, head: ListNode) -> ListNode:\n        pass\n```\nExample 1:\nInput: [1,2]\nOutput: [2,1]\nConstraints:\n0 <= n <= 5000");
    expect(p.detectedLanguage).toBe("python");
    expect(p.signature).toMatch(/def reverseList/);
    expect(p.starterCode).toContain("    def reverseList");
    for (const [code, lang] of [
      ["#include <vector>\nint main(){ std::vector<int> v; }", "cpp"],
      ["public class Solution { public int f(int x) { return x; } }", "java"],
      ["function f(a: number): number { return a; }", "typescript"],
      ["const f = (a) => { console.log(a) }", "javascript"],
      ["SELECT name FROM users WHERE id = 1", "sql"],
    ] as const) expect(detectLanguage(code), code).toBe(lang);
  });

  it("recognizes SQL and debugging tasks", () => {
    expect(parseProblem("Table Employees has columns id, salary. Write a SQL query to find the second highest salary. SELECT ...").kind).toBe("sql");
    expect(parseProblem("My code fails with IndexError:\n```python\ndef f(a):\n    return a[len(a)]\n```").kind).toBe("debugging");
  });

  it("renders observed structure for the model", () => {
    const ctx = problemToContext(parseProblem(TWO_SUM));
    expect(ctx).toContain("Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]");
    expect(ctx).toContain("- -10^9 <= nums[i] <= 10^9");
  });
});

describe("mode prompts", () => {
  it("interview prompt forbids invented experience and asks for a cited personal example", () => {
    const p = interviewPrompt({ text: "Tell me about a time you failed", category: "behavioral" }, "short");
    expect(p).toMatch(/STAR/);
    expect(p).toMatch(/Never invent employers, projects, dates, metrics/);
    expect(p).toMatch(/No matching example in your profile/);
  });

  it("technical prompt includes the language rules, missing-info policy and never claims execution", () => {
    const parsed = parseProblem("Given an array, return the");
    const p = technicalPrompt("solve", "cpp", parsed, "");
    expect(p).toMatch(/C\+\+17/);
    expect(p).toMatch(/```cpp/);
    expect(p).toMatch(/missing: the full problem statement/);
    expect(p).toMatch(/not executed/);
    expect(technicalPrompt("hints", "python", null, "")).toMatch(/do NOT give the solution/);
  });
});
