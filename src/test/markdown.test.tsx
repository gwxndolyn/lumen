// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, parseBlocks } from "../renderer/lib/markdown";

const noop = () => undefined;

describe("safe markdown rendering", () => {
  it("parses common blocks including unterminated code while streaming", () => {
    const b = parseBlocks("# Title\n\n- a\n- b\n\n```ts\nconst x = 1;");
    expect(b.map((x) => x.type)).toEqual(["heading", "list", "code"]);
  });

  it("renders model HTML as inert text, never as markup", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**'} onCopy={noop} onLink={noop} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("only turns https links into buttons that route through the app (no auto-navigation)", () => {
    const onLink = vi.fn();
    const { container } = render(<Markdown text={"[ok](https://example.com) [bad](javascript:alert(1))"} onCopy={noop} onLink={onLink} />);
    expect(container.querySelector("a")).toBeNull();
    const buttons = container.querySelectorAll("button.link");
    expect(buttons).toHaveLength(1);
    (buttons[0] as HTMLButtonElement).click();
    expect(onLink).toHaveBeenCalledWith("https://example.com");
  });

  it("renders citations with source tooltips", () => {
    const { container } = render(<Markdown text={"See [C1, C2]."} refs={[{ label: "C1", kind: "note", title: "JD", excerpt: "Kotlin" }]} onCopy={noop} onLink={noop} />);
    const cites = container.querySelectorAll(".cite");
    expect(cites).toHaveLength(2);
    expect(cites[0]!.getAttribute("title")).toContain("JD");
    expect(cites[1]!.getAttribute("title")).toBe("Unknown source");
  });

  it("renders tables and code with copy buttons", () => {
    const onCopy = vi.fn();
    const { container, getByText } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```"} onCopy={onCopy} onLink={noop} />);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    getByText("Copy").click();
    expect(onCopy).toHaveBeenCalledWith("print(1)");
  });
});
