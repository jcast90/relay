import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  validateServeOptions
} from "../../src/mcp/serve-validation.js";

/**
 * OSS-03: `rly serve` must hard-stop when asked to bind non-loopback
 * without auth. The existing `test/cli/serve-command.test.ts` covers the
 * integration path (actual CLI invocation); these tests lock in the
 * decision table at the function level so future edits can't accidentally
 * demote "refuse" to "warn" without a test failure.
 */

describe("isLoopbackHost", () => {
  it("treats 127.0.0.1, ::1, and localhost as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("treats everything else as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("validateServeOptions", () => {
  it("HARD-STOPS on non-loopback + no token + no opt-in override", () => {
    const result = validateServeOptions({
      host: "0.0.0.0",
      token: undefined,
      allowUnauthenticatedRemote: false
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/Refusing to start/i);
      expect(result.message).toMatch(/--allow-unauthenticated-remote/);
    }
  });

  it("HARD-STOPS on a LAN host + no token + no opt-in override", () => {
    const result = validateServeOptions({
      host: "192.168.1.10",
      token: undefined,
      allowUnauthenticatedRemote: false
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/192\.168\.1\.10/);
    }
  });

  it("allows non-loopback + token (auth is the blessed path)", () => {
    const result = validateServeOptions({
      host: "0.0.0.0",
      token: "s3cret",
      allowUnauthenticatedRemote: false
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings).toEqual([]);
    }
  });

  it("allows non-loopback + no token when --allow-unauthenticated-remote is passed, but warns loudly", () => {
    const result = validateServeOptions({
      host: "0.0.0.0",
      token: undefined,
      allowUnauthenticatedRemote: true
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // Two warnings fire: the generic "no token" and the specific
      // "non-loopback without auth" one.
      expect(result.warnings.length).toBeGreaterThanOrEqual(2);
      const joined = result.warnings.join("\n");
      expect(joined).toMatch(/no auth token/);
      expect(joined).toMatch(/non-loopback/);
    }
  });

  it("allows loopback + no token and warns quietly (default dev workflow)", () => {
    const result = validateServeOptions({
      host: "127.0.0.1",
      token: undefined,
      allowUnauthenticatedRemote: false
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const joined = result.warnings.join("\n");
      expect(joined).toMatch(/no auth token/);
      // The scary "non-loopback" warning should NOT fire here.
      expect(joined).not.toMatch(/non-loopback/);
    }
  });

  it("allows loopback + token with zero warnings", () => {
    const result = validateServeOptions({
      host: "127.0.0.1",
      token: "s3cret",
      allowUnauthenticatedRemote: false
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings).toEqual([]);
    }
  });

  it("treats ::1 and localhost the same as 127.0.0.1", () => {
    for (const host of ["::1", "localhost"]) {
      const result = validateServeOptions({
        host,
        token: undefined,
        allowUnauthenticatedRemote: false
      });
      expect(result.kind).toBe("ok");
    }
  });
});
