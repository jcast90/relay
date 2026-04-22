import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStreamActivityRenderer, isQuietMode } from "../src/cli/stream-activity-renderer.js";

describe("isQuietMode", () => {
  const originalQuiet = process.env.RELAY_QUIET;
  afterEach(() => {
    if (originalQuiet === undefined) delete process.env.RELAY_QUIET;
    else process.env.RELAY_QUIET = originalQuiet;
  });

  it("returns true when --quiet is in argv", () => {
    expect(isQuietMode(["run", "--quiet"])).toBe(true);
    expect(isQuietMode(["run", "--silent"])).toBe(true);
  });

  it("returns true when RELAY_QUIET=1", () => {
    process.env.RELAY_QUIET = "1";
    expect(isQuietMode([])).toBe(true);
  });

  it("returns false by default", () => {
    delete process.env.RELAY_QUIET;
    delete process.env.HARNESS_QUIET;
    expect(isQuietMode([])).toBe(false);
    expect(isQuietMode(["run", "feature-request"])).toBe(false);
  });
});

describe("createStreamActivityRenderer", () => {
  const captured: string[] = [];
  const write = (line: string) => captured.push(line);

  beforeEach(() => {
    captured.length = 0;
  });

  const claudeLine = (toolUse: { name: string; input: Record<string, unknown> }) =>
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", ...toolUse }],
      },
    });

  it("renders tool_use events through the write sink", () => {
    const r = createStreamActivityRenderer({ write, debounceMs: 0 });
    r.onLine(claudeLine({ name: "Read", input: { file_path: "src/foo.ts" } }));
    r.flush();
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("Reading foo.ts");
  });

  it("includes the label when provided", () => {
    const r = createStreamActivityRenderer({ write, debounceMs: 0, label: "pixel" });
    r.onLine(claudeLine({ name: "Bash", input: { command: "pnpm test" } }));
    r.flush();
    expect(captured[0]).toContain("[pixel]");
    expect(captured[0]).toContain("$ pnpm test");
  });

  it("skips text-only assistant events", () => {
    const r = createStreamActivityRenderer({ write, debounceMs: 0 });
    r.onLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "thinking" }] },
      })
    );
    r.flush();
    expect(captured.length).toBe(0);
  });

  it("respects enabled=false as a no-op sink", () => {
    const r = createStreamActivityRenderer({ write, debounceMs: 0, enabled: false });
    r.onLine(claudeLine({ name: "Read", input: { file_path: "a.ts" } }));
    r.flush();
    expect(captured.length).toBe(0);
  });

  it("caps retained snapshot at the shared limit without momentary overshoot", () => {
    const r = createStreamActivityRenderer({ write, debounceMs: 0 });
    // Push 30 events — 10 above the cap.
    for (let i = 0; i < 30; i++) {
      r.onLine(claudeLine({ name: "Read", input: { file_path: `f${i}.ts` } }));
    }
    r.flush();
    expect(r.snapshot().length).toBe(20);
    // Oldest retained should be f10, newest f29 (LIFO after capping).
    expect(r.snapshot()[0].text).toBe("Reading f10.ts");
    expect(r.snapshot()[19].text).toBe("Reading f29.ts");
  });
});
