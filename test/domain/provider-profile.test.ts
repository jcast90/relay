import { describe, expect, it } from "vitest";

import {
  isLikelySecretValue,
  PROVIDER_PROFILE_ID_PATTERN,
  ProviderProfileSchema,
  validateEnvOverrides,
} from "../../src/domain/provider-profile.js";

describe("provider-profile id pattern", () => {
  it("accepts lowercase ids with digits and dashes", () => {
    expect(PROVIDER_PROFILE_ID_PATTERN.test("minimax")).toBe(true);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("openrouter-01")).toBe(true);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("a")).toBe(true);
  });

  it("rejects empty, uppercase, or over-long ids", () => {
    expect(PROVIDER_PROFILE_ID_PATTERN.test("")).toBe(false);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("MiniMax")).toBe(false);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("a".repeat(33))).toBe(false);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("has space")).toBe(false);
    expect(PROVIDER_PROFILE_ID_PATTERN.test("under_score")).toBe(false);
  });
});

describe("isLikelySecretValue", () => {
  it("flags vendor prefixes", () => {
    expect(isLikelySecretValue("sk-abcdef")).toBe(true);
    expect(isLikelySecretValue("sk_ant_123")).toBe(true);
    expect(isLikelySecretValue("anthropic_live_xyz")).toBe(true);
    expect(isLikelySecretValue("sess-AB12")).toBe(true);
    expect(isLikelySecretValue("ghp_1234567890")).toBe(true);
    expect(isLikelySecretValue("github_pat_xyz")).toBe(true);
    expect(isLikelySecretValue("xoxb-abc")).toBe(true);
    expect(isLikelySecretValue("Bearer abc")).toBe(true);
  });

  it("flags long opaque base64-ish runs", () => {
    // 40 chars of base64url-ish — classic token shape.
    expect(isLikelySecretValue("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN")).toBe(true);
    // Exactly 32 chars — threshold.
    expect(isLikelySecretValue("a".repeat(32))).toBe(true);
  });

  it("does not flag ordinary base-URL values", () => {
    expect(isLikelySecretValue("https://api.minimax.io/v1")).toBe(false);
    expect(isLikelySecretValue("http://localhost:4000")).toBe(false);
    expect(isLikelySecretValue("us-east-1")).toBe(false);
    expect(isLikelySecretValue("MiniMax-M2")).toBe(false);
    expect(isLikelySecretValue("")).toBe(false);
  });
});

describe("validateEnvOverrides", () => {
  it("accepts empty / undefined overrides", () => {
    expect(validateEnvOverrides(undefined)).toEqual({ ok: true });
    expect(validateEnvOverrides({})).toEqual({ ok: true });
  });

  it("accepts regular base URLs and model names", () => {
    const result = validateEnvOverrides({
      OPENAI_BASE_URL: "https://api.minimax.io/v1",
      OPENAI_MODEL: "MiniMax-M2",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a secret-looking value and names the offending key", () => {
    const result = validateEnvOverrides({
      OPENAI_BASE_URL: "https://api.minimax.io/v1",
      OPENAI_API_KEY: "sk-abcdef1234567890",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.key).toBe("OPENAI_API_KEY");
      expect(result.reason).toMatch(/api-key-ref/);
    }
  });
});

describe("ProviderProfileSchema", () => {
  it("round-trips a valid profile", () => {
    const parsed = ProviderProfileSchema.parse({
      id: "minimax",
      displayName: "MiniMax (M2)",
      adapter: "codex",
      envOverrides: { OPENAI_BASE_URL: "https://api.minimax.io/v1" },
      apiKeyEnvRef: "MINIMAX_API_KEY",
      defaultModel: "MiniMax-M2",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z",
    });
    expect(parsed.id).toBe("minimax");
    expect(parsed.adapter).toBe("codex");
  });

  it("rejects an unknown adapter", () => {
    expect(() =>
      ProviderProfileSchema.parse({
        id: "gemini",
        displayName: "Gemini",
        adapter: "gemini",
        envOverrides: {},
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      })
    ).toThrow();
  });

  it("rejects a malformed apiKeyEnvRef", () => {
    expect(() =>
      ProviderProfileSchema.parse({
        id: "minimax",
        displayName: "MiniMax",
        adapter: "codex",
        envOverrides: {},
        apiKeyEnvRef: "not a var name",
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      })
    ).toThrow();
  });
});
