import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENV_WHITELIST,
  NodeCommandInvoker,
  isSecretEnvName,
  sanitizeEnv,
} from "../src/agents/command-invoker.js";

/**
 * OSS-03: the default CommandInvoker must NOT leak the parent process's
 * secrets (API keys, auth tokens, cloud creds, ...) into spawned children.
 * These tests lock in:
 *  - the pure sanitizer's allow + strip passes
 *  - the `passEnv` / `env` opt-in paths
 *  - an end-to-end spawn via `node -e` that proves the env a real child sees
 *    actually matches the sanitizer's output.
 */

describe("isSecretEnvName", () => {
  it("matches common credential name shapes", () => {
    expect(isSecretEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isSecretEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretEnvName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSecretEnvName("DATABASE_PASSWORD")).toBe(true);
    expect(isSecretEnvName("SMTP_PASSWD")).toBe(true);
    expect(isSecretEnvName("MY_CREDENTIAL")).toBe(true);
    expect(isSecretEnvName("AWS_CREDS")).toBe(true);
    expect(isSecretEnvName("BEARER_AUTH")).toBe(true);
    expect(isSecretEnvName("TOKEN_BUCKET")).toBe(true);
    expect(isSecretEnvName("API_KEY_FOR_X")).toBe(true);
  });

  it("does not flag innocuous names", () => {
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("HOME")).toBe(false);
    expect(isSecretEnvName("LANG")).toBe(false);
    expect(isSecretEnvName("KEYBOARD_LAYOUT")).toBe(false);
    expect(isSecretEnvName("MONKEY")).toBe(false);
    expect(isSecretEnvName("AUTHOR")).toBe(false);
    // `TOKENIZER` must not match — the boundary rule requires `_` or end-of-
    // string immediately after `TOKEN`, and `TOKENIZER` has neither.
    expect(isSecretEnvName("TOKENIZER_VERSION")).toBe(false);
    expect(isSecretEnvName("AUTHOR_NAME")).toBe(false);
  });

  it("flags concatenated-word credential forms common in the wild", () => {
    // Stripe, SendGrid, Mailgun, and many other SaaS products ship with
    // `*_APIKEY` (no separator) rather than `*_API_KEY`.
    expect(isSecretEnvName("STRIPE_APIKEY")).toBe(true);
    expect(isSecretEnvName("APIKEY")).toBe(true);
    // GitHub App / TLS configs use `PRIVATEKEY` without a separator.
    expect(isSecretEnvName("GITHUB_APP_PRIVATEKEY")).toBe(true);
    // OAuth ecosystem: all of these are extremely common.
    expect(isSecretEnvName("SESSION_ACCESSTOKEN")).toBe(true);
    expect(isSecretEnvName("REFRESHTOKEN")).toBe(true);
    expect(isSecretEnvName("MY_BEARERTOKEN")).toBe(true);
    // Bare "keyword" vars that aren't suffix/prefix shapes.
    expect(isSecretEnvName("BEARER")).toBe(true);
    expect(isSecretEnvName("JWT_KEY")).toBe(true);
    expect(isSecretEnvName("OAUTH_SECRET")).toBe(true);
  });
});

describe("sanitizeEnv", () => {
  const secretHeavyEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/test",
    USER: "test",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    HARNESS_DEBUG: "1",
    RELAY_PORT: "7420",
    RELAY_HOME: "/tmp/relay",
    // Secrets that must be stripped:
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_secret",
    OPENAI_API_KEY: "sk-openai-secret",
    AWS_ACCESS_KEY_ID: "AKIA-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    LINEAR_API_KEY: "lin-secret",
    DATABASE_PASSWORD: "pw",
    // Unrelated var that isn't whitelisted: should be stripped too.
    RANDOM_VAR: "nope",
  };

  it("forwards the default whitelist and strips everything else", () => {
    const out = sanitizeEnv(secretHeavyEnv);

    // Whitelisted exact-match names pass.
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/home/test");
    expect(out.USER).toBe("test");
    expect(out.LANG).toBe("en_US.UTF-8");

    // Prefix families pass.
    expect(out.LC_ALL).toBe("en_US.UTF-8");
    expect(out.HARNESS_DEBUG).toBe("1");
    expect(out.RELAY_PORT).toBe("7420");
    expect(out.RELAY_HOME).toBe("/tmp/relay");

    // Secrets are stripped.
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.LINEAR_API_KEY).toBeUndefined();
    expect(out.DATABASE_PASSWORD).toBeUndefined();

    // Non-whitelisted innocuous vars are stripped (allowlist is exhaustive).
    expect(out.RANDOM_VAR).toBeUndefined();
  });

  it("lets passEnv opt specific secrets back in", () => {
    const out = sanitizeEnv(secretHeavyEnv, {
      passEnv: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
    });

    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(out.GITHUB_TOKEN).toBe("ghp_secret");
    // Unlisted secrets stay stripped.
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("silently skips passEnv names not present in parent env", () => {
    const out = sanitizeEnv({ PATH: "/usr/bin" }, { passEnv: ["NOT_SET", "ALSO_NOT_SET"] });

    expect(out.PATH).toBe("/usr/bin");
    expect(out.NOT_SET).toBeUndefined();
  });

  it("env overrides layer on top unfiltered", () => {
    const out = sanitizeEnv(secretHeavyEnv, {
      env: { API_KEY_FOR_TESTS: "explicit" },
    });

    expect(out.API_KEY_FOR_TESTS).toBe("explicit");
    // Secrets from parent env still stripped.
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("env value of undefined unsets the key", () => {
    const out = sanitizeEnv(secretHeavyEnv, {
      env: { PATH: undefined },
    });

    expect(out.PATH).toBeUndefined();
  });

  it("returns a fresh object (no aliasing back into parentEnv)", () => {
    const parent: NodeJS.ProcessEnv = { PATH: "/bin" };
    const out = sanitizeEnv(parent);
    out.PATH = "mutated";
    expect(parent.PATH).toBe("/bin");
  });

  it("default whitelist covers PATH + HOME at minimum", () => {
    // Sanity check so a future accidental removal from the whitelist fails.
    expect(DEFAULT_ENV_WHITELIST.has("PATH")).toBe(true);
    expect(DEFAULT_ENV_WHITELIST.has("HOME")).toBe(true);
  });
});

describe("NodeCommandInvoker — env sanitization in a real subprocess", () => {
  const invoker = new NodeCommandInvoker();

  /**
   * Seed the parent env with tripwire values, spawn `node -e` to dump its
   * own env, and return the parsed JSON. Tripwires are restored on exit so
   * parallel tests don't observe them.
   */
  async function runEnvDump(
    opts: { passEnv?: string[]; env?: Record<string, string | undefined> } = {}
  ): Promise<Record<string, string>> {
    const saved: Record<string, string | undefined> = {
      INJECTED_GITHUB_TOKEN: process.env.INJECTED_GITHUB_TOKEN,
      INJECTED_API_KEY: process.env.INJECTED_API_KEY,
      INJECTED_SAFE_VAR: process.env.INJECTED_SAFE_VAR,
      HARNESS_INJECTED: process.env.HARNESS_INJECTED,
    };
    process.env.INJECTED_GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.INJECTED_API_KEY = "sk-should-not-leak";
    process.env.INJECTED_SAFE_VAR = "not-a-secret-but-not-whitelisted";
    process.env.HARNESS_INJECTED = "should-pass-through";

    try {
      const result = await invoker.exec({
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.env))"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        passEnv: opts.passEnv,
        env: opts.env,
      });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.trim()) as Record<string, string>;
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("does NOT leak secret-shaped env vars to the child by default", async () => {
    const childEnv = await runEnvDump();

    // The headline assertion: no secret passes through.
    expect(childEnv.INJECTED_GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.INJECTED_API_KEY).toBeUndefined();

    // Non-secret but non-whitelisted vars are also stripped (conservative).
    expect(childEnv.INJECTED_SAFE_VAR).toBeUndefined();

    // HARNESS_* prefix family passes through — that's how we wire workspace
    // paths into dispatched subprocesses.
    expect(childEnv.HARNESS_INJECTED).toBe("should-pass-through");

    // PATH must survive or nothing dispatched could resolve a binary.
    expect(childEnv.PATH).toBeDefined();
  }, 15_000);

  it("passEnv opts a named secret back in", async () => {
    const childEnv = await runEnvDump({
      passEnv: ["INJECTED_GITHUB_TOKEN"],
    });

    expect(childEnv.INJECTED_GITHUB_TOKEN).toBe("ghp_should_not_leak");
    // Unlisted secret still stripped.
    expect(childEnv.INJECTED_API_KEY).toBeUndefined();
  }, 15_000);

  it("env overrides deliver explicit key/value pairs to the child", async () => {
    const childEnv = await runEnvDump({
      env: { RELAY_EXPLICIT_OVERRIDE: "deliberate" },
    });

    expect(childEnv.RELAY_EXPLICIT_OVERRIDE).toBe("deliberate");
  }, 15_000);
});
