import { describe, expect, it } from "vitest";

import { parseRebuildFlags } from "../src/cli/rebuild.js";

describe("parseRebuildFlags", () => {
  it("defaults to dist-only with installApp=true when no flags given", () => {
    const opts = parseRebuildFlags([]);
    expect(opts).toEqual({
      dist: true,
      tui: false,
      gui: false,
      skipInstall: false,
      installApp: true,
    });
  });

  it("--all enables every target and keeps installApp=true", () => {
    const opts = parseRebuildFlags(["--all"]);
    expect(opts.dist).toBe(true);
    expect(opts.tui).toBe(true);
    expect(opts.gui).toBe(true);
    expect(opts.installApp).toBe(true);
  });

  it("--no-install-app opts out of the /Applications copy", () => {
    const opts = parseRebuildFlags(["--all", "--no-install-app"]);
    expect(opts.gui).toBe(true);
    expect(opts.installApp).toBe(false);
  });

  it("explicit --gui alone doesn't auto-enable dist", () => {
    // Matches the pre-existing contract: an explicit target flag
    // means "only this target", not "this target + dist".
    const opts = parseRebuildFlags(["--gui"]);
    expect(opts.dist).toBe(false);
    expect(opts.gui).toBe(true);
  });

  it("--skip-install is independent of --no-install-app", () => {
    const opts = parseRebuildFlags(["--all", "--skip-install"]);
    expect(opts.skipInstall).toBe(true);
    expect(opts.installApp).toBe(true);
  });
});
