import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanOcrText, TesseractOcr } from "../core/ocr";

// Runs the real on-device Tesseract engine (bundled English model, no network) on a rendered image.
describe("on-device OCR", () => {
  const ocr = new TesseractOcr({ timeoutMs: 60_000 });
  afterAll(() => ocr.dispose());

  it("recognizes text in a screenshot-like image", async () => {
    const img = fs.readFileSync(path.join(__dirname, "fixtures/invoice.png"));
    const r = await ocr.recognize(img);
    expect(r.text).toMatch(/Invoice 4471/);
    expect(r.text).toMatch(/\$1,250\.00/);
    expect(r.text).toMatch(/November 14/);
    expect(r.confidence).toBeGreaterThan(0.8);
  }, 60_000);

  it("rejects a non-image cleanly and keeps working afterwards", async () => {
    await expect(ocr.recognize(Buffer.from("not an image"))).rejects.toBeTruthy();
    const r = await ocr.recognize(fs.readFileSync(path.join(__dirname, "fixtures/invoice.png")));
    expect(r.text).toMatch(/Invoice/);
  }, 60_000);

  it("cleans OCR noise", () => {
    expect(cleanOcrText("  a  b \n|\n\n\n\nnext ")).toBe("a b\n\nnext");
    expect(cleanOcrText("one\n\n\n\ntwo")).toBe("one\n\ntwo");
  });
});
