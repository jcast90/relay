import { describe, expect, it } from "vitest";
import {
  ACTIVITY_STACK_MAX,
  ACTIVITY_TOP_N,
  appendActivityCapped,
  describeToolUse,
  parseClaudeStreamLine
} from "../src/domain/tool-activity.js";

describe("describeToolUse", () => {
  it("renders Read with basename", () => {
    expect(describeToolUse("Read", { file_path: "/abs/path/src/foo.ts" })).toBe(
      "Reading foo.ts"
    );
  });

  it("renders Edit with basename", () => {
    expect(describeToolUse("Edit", { file_path: "bar.ts" })).toBe("Editing bar.ts");
  });

  it("truncates long Bash commands to 60 chars plus ellipsis", () => {
    const cmd = "a".repeat(200);
    const out = describeToolUse("Bash", { command: cmd });
    expect(out.startsWith("$ ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    // "$ " + 60 chars + "…"
    expect(Array.from(out).length).toBe(2 + 60 + 1);
  });

  it("falls back to the tool name for unknown tools", () => {
    expect(describeToolUse("Mystery", {})).toBe("Mystery");
  });

  it("handles missing input gracefully", () => {
    expect(describeToolUse("Read", null)).toBe("Reading ");
    expect(describeToolUse("Bash", undefined)).toBe("$ ");
  });

  it("handles multibyte truncation without splitting codepoints", () => {
    const s = "✓".repeat(100);
    const out = describeToolUse("Bash", { command: s });
    // $ + 60 check-marks + ellipsis
    expect(Array.from(out).length).toBe(2 + 60 + 1);
  });

  it("formats Skill as /name", () => {
    expect(describeToolUse("Skill", { skill: "review-pr" })).toBe("/review-pr");
  });
});

describe("parseClaudeStreamLine", () => {
  it("returns null for text chunks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] }
    });
    expect(parseClaudeStreamLine(line)).toBeNull();
  });

  it("extracts the first tool_use block as a description", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", name: "Read", input: { file_path: "src/foo.ts" } }
        ]
      }
    });
    expect(parseClaudeStreamLine(line)).toBe("Reading foo.ts");
  });

  it("returns null for malformed JSON", () => {
    expect(parseClaudeStreamLine("{not json")).toBeNull();
    expect(parseClaudeStreamLine("")).toBeNull();
  });

  it("ignores non-assistant types", () => {
    const line = JSON.stringify({ type: "result", result: "done" });
    expect(parseClaudeStreamLine(line)).toBeNull();
  });
});

describe("appendActivityCapped", () => {
  it("caps BEFORE appending (no momentary overshoot)", () => {
    const full = Array.from({ length: ACTIVITY_STACK_MAX }, (_, i) => ({
      text: `x${i}`,
      ts: i
    }));
    const next = appendActivityCapped(full, { text: "new", ts: 99 });
    expect(next.length).toBe(ACTIVITY_STACK_MAX);
    expect(next[next.length - 1].text).toBe("new");
    // Oldest entry got evicted.
    expect(next[0].text).toBe("x1");
  });

  it("doesn't mutate the input", () => {
    const input = [{ text: "a", ts: 1 }];
    const next = appendActivityCapped(input, { text: "b", ts: 2 });
    expect(input.length).toBe(1);
    expect(next.length).toBe(2);
  });

  it("constants match the Rust side", () => {
    expect(ACTIVITY_STACK_MAX).toBe(20);
    expect(ACTIVITY_TOP_N).toBe(3);
  });
});
