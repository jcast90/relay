import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRACKER_CONFIG,
  diagnoseTrackerConfig,
  parseTrackerConfig,
  resolveProviderForChannel,
  TrackerConfigSchema,
} from "../../src/domain/tracker-config.js";

/**
 * Unit tests for the tracker-config schema, defaults, resolver, and
 * diagnostics. The diagnostics list drives the `rly doctor` output;
 * pinning every rule here keeps that surface stable.
 */

describe("tracker-config", () => {
  describe("DEFAULT_TRACKER_CONFIG", () => {
    it("resolves to relay_native with no external provider blocks", () => {
      expect(DEFAULT_TRACKER_CONFIG.default).toBe("relay_native");
      expect(DEFAULT_TRACKER_CONFIG.providers.relay_native.enabled).toBe(true);
      expect(DEFAULT_TRACKER_CONFIG.providers.github_issues.enabled).toBe(false);
      expect(DEFAULT_TRACKER_CONFIG.providers.github_projects).toBeUndefined();
      expect(DEFAULT_TRACKER_CONFIG.providers.linear).toBeUndefined();
    });
  });

  describe("parseTrackerConfig", () => {
    it("returns the default for undefined input (config file predating v0.2)", () => {
      expect(parseTrackerConfig(undefined)).toEqual(DEFAULT_TRACKER_CONFIG);
    });

    it("returns the default for null input (explicit absence)", () => {
      expect(parseTrackerConfig(null)).toEqual(DEFAULT_TRACKER_CONFIG);
    });

    it("returns the default for an empty object — every field has a sensible default", () => {
      expect(parseTrackerConfig({})).toEqual(DEFAULT_TRACKER_CONFIG);
    });

    it("validates and applies github_projects defaults around required owner", () => {
      const config = parseTrackerConfig({
        default: "github_projects",
        providers: { github_projects: { owner: "jcast90" } },
      });
      expect(config.default).toBe("github_projects");
      expect(config.providers.github_projects?.owner).toBe("jcast90");
      expect(config.providers.github_projects?.ownerType).toBe("user");
      expect(config.providers.github_projects?.epic_model).toBe("parent_draft_item");
      expect(config.providers.github_projects?.use_draft_items).toBe(true);
      expect(config.providers.github_projects?.sync_interval_seconds).toBe(30);
      expect(config.providers.github_projects?.min_rate_limit_budget).toBe(200);
    });

    it("rejects github_projects block without an owner", () => {
      expect(() =>
        parseTrackerConfig({
          default: "github_projects",
          providers: { github_projects: {} },
        })
      ).toThrow();
    });

    it("rejects unknown provider names in `default`", () => {
      expect(() => parseTrackerConfig({ default: "jira" })).toThrow();
    });

    it("rejects out-of-range sync_interval_seconds", () => {
      expect(() =>
        parseTrackerConfig({
          providers: { github_projects: { owner: "x", sync_interval_seconds: 1 } },
        })
      ).toThrow();
      expect(() =>
        parseTrackerConfig({
          providers: { github_projects: { owner: "x", sync_interval_seconds: 99999 } },
        })
      ).toThrow();
    });

    it("accepts the per-primary-repo and fixed project_naming shapes", () => {
      const a = parseTrackerConfig({
        providers: { github_projects: { owner: "x", project_naming: "per_primary_repo" } },
      });
      expect(a.providers.github_projects?.project_naming).toBe("per_primary_repo");

      const b = parseTrackerConfig({
        providers: { github_projects: { owner: "x", project_naming: { fixed: "Work" } } },
      });
      expect(b.providers.github_projects?.project_naming).toEqual({ fixed: "Work" });
    });
  });

  describe("resolveProviderForChannel", () => {
    it("returns the channel override when set", () => {
      expect(resolveProviderForChannel(DEFAULT_TRACKER_CONFIG, "github_projects")).toBe(
        "github_projects"
      );
    });

    it("falls back to the global default when no override is given", () => {
      expect(resolveProviderForChannel(DEFAULT_TRACKER_CONFIG)).toBe("relay_native");
    });

    it("honors the override even when the global default is something else", () => {
      const cfg = TrackerConfigSchema.parse({
        default: "github_projects",
        providers: { github_projects: { owner: "x" } },
      });
      expect(resolveProviderForChannel(cfg, "relay_native")).toBe("relay_native");
    });
  });

  describe("diagnoseTrackerConfig", () => {
    it("returns ok for the default config", () => {
      const out = diagnoseTrackerConfig(DEFAULT_TRACKER_CONFIG);
      expect(out).toHaveLength(1);
      expect(out[0].level).toBe("ok");
    });

    it("flags an error when default points at github_projects with no provider block", () => {
      const cfg = TrackerConfigSchema.parse({ default: "github_projects" });
      const out = diagnoseTrackerConfig(cfg);
      expect(
        out.some((d) => d.level === "error" && /github_projects is missing/.test(d.message))
      ).toBe(true);
    });

    it("flags an error when default points at linear with no provider block", () => {
      const cfg = TrackerConfigSchema.parse({ default: "linear" });
      const out = diagnoseTrackerConfig(cfg);
      expect(out.some((d) => d.level === "error" && /linear is missing/.test(d.message))).toBe(
        true
      );
    });

    it("flags an error when default is github_issues but the block is disabled", () => {
      const cfg = TrackerConfigSchema.parse({
        default: "github_issues",
        providers: { github_issues: { enabled: false } },
      });
      const out = diagnoseTrackerConfig(cfg);
      expect(
        out.some((d) => d.level === "error" && /github_issues.*enabled is false/.test(d.message))
      ).toBe(true);
    });

    it("warns about the custom-field epic model 50-option cap", () => {
      const cfg = TrackerConfigSchema.parse({
        default: "github_projects",
        providers: { github_projects: { owner: "x", epic_model: "custom_field" } },
      });
      const out = diagnoseTrackerConfig(cfg);
      expect(
        out.some((d) => d.level === "warn" && /50-option cap|caps single-select/.test(d.message))
      ).toBe(true);
    });

    it("warns when use_draft_items is false (real-Issue projection is a footgun)", () => {
      const cfg = TrackerConfigSchema.parse({
        default: "github_projects",
        providers: { github_projects: { owner: "x", use_draft_items: false } },
      });
      const out = diagnoseTrackerConfig(cfg);
      expect(
        out.some((d) => d.level === "warn" && /clutters the bug tracker/.test(d.message))
      ).toBe(true);
    });

    it("flags an error when relay_native is the default but disabled", () => {
      const cfg = TrackerConfigSchema.parse({
        default: "relay_native",
        providers: { relay_native: { enabled: false } },
      });
      const out = diagnoseTrackerConfig(cfg);
      expect(out.some((d) => d.level === "error" && /resolves to nothing/.test(d.message))).toBe(
        true
      );
    });
  });
});
