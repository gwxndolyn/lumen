import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateIntent, type IntentFixture } from "../core/intelligence/evaluate";

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/intent-eval.json"), "utf8")) as IntentFixture;
const report = evaluateIntent(fixture);

describe("intent evaluation (labelled fixture)", () => {
  it("prints the report", () => {
    for (const [k, r] of Object.entries(report)) {
      console.log(`${k}: ${r.correct}/${r.total} (${Math.round(r.accuracy * 100)}%)`);
      for (const m of r.misses) console.log(`   miss: "${m.text}" expected=${m.expected} got=${m.got}`);
    }
    expect(report.relations.total).toBeGreaterThan(30);
  });
});

const holdout = evaluateIntent(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/intent-holdout.json"), "utf8")) as IntentFixture);

describe("intent evaluation (held-out)", () => {
  it("prints the held-out report", () => {
    for (const [k, r] of Object.entries(holdout)) {
      console.log(`holdout ${k}: ${r.correct}/${r.total} (${Math.round(r.accuracy * 100)}%)`);
      for (const m of r.misses) console.log(`   miss: "${m.text}" expected=${m.expected} got=${m.got}`);
    }
    expect(holdout.relations.total + holdout.categories.total).toBeGreaterThanOrEqual(30);
  });
});

// Floors catch regressions when rules change. Tuned-set floors sit just below the measured value;
// held-out floors sit at the measured value (holdout #2: relations 7/9, categories 12/24 after LUM-012).
describe("intent accuracy floors", () => {
  it("tuned set", () => {
    expect(report.relations.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(report.ambiguous.accuracy).toBe(1);
    expect(report.categories.accuracy).toBeGreaterThanOrEqual(0.95);
  });
  it("held-out set", () => {
    expect(holdout.relations.accuracy).toBeGreaterThanOrEqual(7 / 9);
    expect(holdout.ambiguous.accuracy).toBe(1);
    expect(holdout.categories.accuracy).toBeGreaterThanOrEqual(12 / 24);
  });
  it("misclassified requests mostly fall back to general rather than a wrong specialised template", () => {
    // "Summarize the plot of Hamlet" was labelled general before summarization existed; it is now
    // (correctly) a summary, so it is excluded as a taxonomy change rather than a wrong template.
    const misses = [...report.categories.misses, ...holdout.categories.misses].filter((m) => !(m.expected === "general" && m.got === "summarization"));
    const wrongTemplate = misses.filter((m) => m.got !== "general");
    // LUM-012: symptom words (leak, freeze, hang) now rank debugging above language names.
    expect(wrongTemplate).toEqual([]);
  });
  // Holdout #3 was written before the LUM-012 change. Before: categories 11/18, 5 wrong templates.
  // After: 13/18, 3 wrong templates. It was looked at while choosing the change (dropping "slow",
  // which mislabelled a frontend performance question), so treat it as seen; write #4 before tuning again.
  it("holdout #3", () => {
    const h3 = evaluateIntent(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/intent-holdout3.json"), "utf8")) as IntentFixture);
    expect(h3.relations.accuracy).toBeGreaterThanOrEqual(5 / 6);
    expect(h3.ambiguous.accuracy).toBe(1);
    expect(h3.categories.accuracy).toBeGreaterThanOrEqual(13 / 18);
    expect(h3.categories.misses.filter((m) => m.got !== "general").length).toBeLessThanOrEqual(3);
  });
});

// Prompt 16 (new task categories). #4 was written before any change: categories 6/32 before,
// 30/32 after pass 1 (its two misses then informed pass 2, so it is seen data now). #5 was written
// after pass 1: 18/28 before pass 2, 27/28 after — also seen data. The unseen measurement for the
// final rules is holdout #6 (below). Floors equal the measured values.
describe("intent accuracy floors (Prompt 16 taxonomy)", () => {
  const load = (f: string) => evaluateIntent(JSON.parse(fs.readFileSync(path.join(__dirname, `fixtures/${f}`), "utf8")) as IntentFixture);
  it("holdout #4", () => {
    const r = load("intent-holdout4.json");
    expect(r.categories.accuracy).toBeGreaterThanOrEqual(32 / 32);
    expect(r.ambiguous.accuracy).toBe(1);
    expect(r.currentInfo.accuracy).toBe(1);
  });
  it("holdout #5", () => {
    const r = load("intent-holdout5.json");
    expect(r.categories.accuracy).toBeGreaterThanOrEqual(27 / 28);
    expect(r.ambiguous.accuracy).toBe(1);
    expect(r.currentInfo.accuracy).toBe(1);
  });
  it("no older set regressed", () => {
    expect(report.categories.correct).toBeGreaterThanOrEqual(67);
    expect(holdout.categories.correct).toBeGreaterThanOrEqual(12);
    expect(report.currentInfo.accuracy).toBe(1);
  });
});

// Holdout #6: the unseen measurement for the final Prompt 16 rules (measured once, rules NOT tuned
// on it). Categories 17/23, relations 1/3, ambiguity 3/3, current-info 23/23. Write #7 before tuning again.
describe("intent accuracy floor: holdout #6 (unseen)", () => {
  it("matches the recorded measurement", () => {
    const r = evaluateIntent(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/intent-holdout6.json"), "utf8")) as IntentFixture);
    expect(r.categories.correct).toBeGreaterThanOrEqual(17);
    expect(r.relations.correct).toBeGreaterThanOrEqual(1);
    expect(r.ambiguous.accuracy).toBe(1);
    expect(r.currentInfo.accuracy).toBe(1);
    // Misses must not land on a specialised template that would mislead the model badly.
    expect(r.categories.misses.filter((m) => !["general", "frontend"].includes(m.got))).toEqual([]);
  });
});
