import { describe, expect, it } from "vitest";
import { classifierTierToChannelTier } from "../src/domain/tier-mapper.js";

describe("classifierTierToChannelTier", () => {
  it("collapses architectural + multi_repo onto feature_large", () => {
    expect(classifierTierToChannelTier("architectural")).toBe("feature_large");
    expect(classifierTierToChannelTier("multi_repo")).toBe("feature_large");
    expect(classifierTierToChannelTier("feature_large")).toBe("feature_large");
  });

  it("maps feature_small → feature", () => {
    expect(classifierTierToChannelTier("feature_small")).toBe("feature");
  });

  it("maps trivial → chore", () => {
    expect(classifierTierToChannelTier("trivial")).toBe("chore");
  });

  it("preserves bugfix", () => {
    expect(classifierTierToChannelTier("bugfix")).toBe("bugfix");
  });
});
