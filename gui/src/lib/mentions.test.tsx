import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { render } from "@testing-library/react";
import { renderWithMentions, renderMarkdown, extractMentions } from "./mentions";

const channel = {
  repos: ["ui", "be"],
  primaryRepo: "ui",
};

function asElement(node: unknown): ReactElement {
  if (!isValidElement(node)) throw new Error("expected a React element");
  return node;
}

function classesOf(nodes: ReturnType<typeof renderWithMentions>): string[] {
  return nodes.map((n) => {
    const el = asElement(n);
    return (el.props as { className?: string }).className ?? el.type?.toString() ?? "";
  });
}

describe("renderWithMentions", () => {
  it("returns an empty array for empty input", () => {
    expect(renderWithMentions("", channel)).toEqual([]);
  });

  it("classifies @primary alias with the primary repo chip class", () => {
    const nodes = renderWithMentions("ping @ui now", channel);
    // tokens: "ping ", "@ui", " now"
    const chip = asElement(nodes[1]);
    expect((chip.props as { className: string }).className).toBe("mention mention-repo-primary");
    expect((chip.props as { children: string }).children).toBe("@ui");
  });

  it("classifies attached (non-primary) repo aliases with the attached class", () => {
    const nodes = renderWithMentions("@be fyi", channel);
    const chip = asElement(nodes[0]);
    expect((chip.props as { className: string }).className).toBe("mention mention-repo-attached");
  });

  it("classifies unknown aliases as human mentions", () => {
    const nodes = renderWithMentions("hey @jcast", channel);
    const chip = asElement(nodes[1]);
    expect((chip.props as { className: string }).className).toBe("mention mention-human");
  });

  it("treats every @xxx as human when channel is null", () => {
    const nodes = renderWithMentions("@ui and @be", null);
    const classes = classesOf(nodes).filter((c) => c.startsWith("mention"));
    expect(classes).toEqual(["mention mention-human", "mention mention-human"]);
  });

  it("is case-insensitive against the channel repo set", () => {
    // Aliases are expected lowercase in UiChannel — the tokenizer lowercases
    // the handle on match. A channel with "ui" should still chip "@UI".
    const nodes = renderWithMentions("@UI here", channel);
    const chip = asElement(nodes[0]);
    expect((chip.props as { className: string }).className).toBe("mention mention-repo-primary");
  });

  it("renders **bold** as <strong>", () => {
    const nodes = renderWithMentions("hello **world**", channel);
    const strong = asElement(nodes[1]);
    expect(strong.type).toBe("strong");
    expect((strong.props as { children: string }).children).toBe("world");
  });

  it("renders `code` as <code> with the inline-code class", () => {
    const nodes = renderWithMentions("try `foo()` now", channel);
    const code = asElement(nodes[1]);
    expect(code.type).toBe("code");
    expect((code.props as { className: string }).className).toBe("mention-code");
  });

  it("tokenizes mixed input in one pass without mis-ordering", () => {
    const nodes = renderWithMentions("go @ui run **bold** and `cmd`", channel);
    // plain, @ui chip, plain, bold strong, plain, code
    expect(nodes).toHaveLength(6);
    const repoChip = asElement(nodes[1]);
    expect((repoChip.props as { className: string }).className).toBe(
      "mention mention-repo-primary"
    );
    expect(asElement(nodes[3]).type).toBe("strong");
    expect(asElement(nodes[5]).type).toBe("code");
  });
});

describe("renderMarkdown", () => {
  it("renders null for empty input", () => {
    expect(renderMarkdown("", channel)).toBeNull();
  });

  it("renders headings, bullet lists, and paragraphs as real block elements", () => {
    const { container } = render(
      <>{renderMarkdown("## Top picks\n\n- one\n- two\n\nEnjoy.", channel)}</>,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Top picks");
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("one");
    expect(container.querySelector("p")?.textContent).toBe("Enjoy.");
  });

  it("preserves @mention chips inside paragraphs", () => {
    const { container } = render(<>{renderMarkdown("ping @ui now", channel)}</>);
    const chip = container.querySelector(".mention");
    expect(chip?.textContent).toBe("@ui");
    expect(chip?.className).toBe("mention mention-repo-primary");
  });

  it("renders fenced code blocks with <pre><code>", () => {
    const { container } = render(<>{renderMarkdown("```\nhello()\n```\n", channel)}</>);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")?.textContent?.trim()).toBe("hello()");
  });

  it("opens links in a new tab so the webview doesn't navigate", () => {
    const { container } = render(<>{renderMarkdown("See [docs](https://example.com).", channel)}</>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });

  it("renders GFM tables (remark-gfm wired up)", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const { container } = render(<>{renderMarkdown(md, channel)}</>);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
  });
});

describe("extractMentions", () => {
  it("finds @aliases with offsets", () => {
    expect(extractMentions("hello @ui and @jcast")).toEqual([
      { alias: "ui", offset: 6 },
      { alias: "jcast", offset: 14 },
    ]);
  });

  it("returns empty for no mentions", () => {
    expect(extractMentions("plain text")).toEqual([]);
  });
});
