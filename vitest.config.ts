import { defineConfig } from "vitest/config";

// Root workspace vitest config. The `gui/` directory has its own
// React-focused tests (introduced in PR #105) that import `react` and
// `@testing-library/*`. Those deps are only installed inside `gui/` —
// not in the repo-root `node_modules` — so running vitest at the root
// against `gui/**/*.test.*` fails with ERR_MODULE_NOT_FOUND. GUI tests
// will get their own CI job / workspace-scoped `pnpm -C gui test`
// run; for now we exclude them from the root `pnpm test` sweep.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "gui/**",
      ".claude/worktrees/**",
    ],
  },
});
