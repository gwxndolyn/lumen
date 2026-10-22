// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { crashReport, ErrorBoundary } from "../renderer/components/ErrorBoundary";

let shouldThrow = true;
function Bomb(): never | JSX.Element {
  if (shouldThrow) throw new TypeError("secret user text that must not be logged");
  return <div>recovered</div>;
}

describe("renderer error boundary", () => {
  it("shows a recovery panel instead of a blank window and reports only the error type", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onCrash = vi.fn();
    shouldThrow = true;
    const { getByRole, getByText, queryByText } = render(
      <ErrorBoundary onCrash={onCrash}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(getByRole("alert").textContent).toMatch(/Something went wrong/);
    expect(onCrash).toHaveBeenCalledTimes(1);
    const report = onCrash.mock.calls[0]![0];
    expect(report.name).toBe("TypeError");
    expect(JSON.stringify(report)).not.toContain("secret user text");
    shouldThrow = false;
    fireEvent.click(getByText("Try again"));
    expect(queryByText("recovered")).not.toBeNull();
    spy.mockRestore();
  });

  it("extracts component names from a React component stack", () => {
    expect(crashReport(new RangeError("x"), { componentStack: "\n    at Bomb (file.tsx:1)\n    at div\n    at Overlay (o.tsx:2)" })).toEqual({ name: "RangeError", components: "Bomb < Overlay" });
    expect(crashReport("boom", { componentStack: null })).toEqual({ name: "string", components: "" });
  });
});
