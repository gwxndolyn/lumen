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
    const misses = [...report.categories.misses, ...holdout.categories.misses];
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
