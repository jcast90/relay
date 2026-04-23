import { z } from "zod";

export const PROVIDER_PROFILE_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const ProviderProfileAdapterSchema = z.enum(["claude", "codex"]);

export type ProviderProfileAdapter = z.infer<typeof ProviderProfileAdapterSchema>;

export const ProviderProfileSchema = z.object({
  id: z.string().regex(PROVIDER_PROFILE_ID_PATTERN, "id must be 1-32 chars of [a-z0-9-]"),
  displayName: z.string().min(1).max(128),
  adapter: ProviderProfileAdapterSchema,
  envOverrides: z.record(z.string(), z.string()).default({}),
  apiKeyEnvRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "apiKeyEnvRef must be an env var name (UPPER_SNAKE)")
    .optional(),
  defaultModel: z.string().min(1).max(256).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/**
 * Heuristic: does this value look like a raw API key that shouldn't be
 * persisted to disk? We flag prefixes used by known vendors (Anthropic,
 * OpenAI session tokens, GitHub, Slack, etc.) and long opaque base64-ish
 * runs. False positives are acceptable — we point the user at
 * `apiKeyEnvRef` either way.
 */
export function isLikelySecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  const lower = trimmed.toLowerCase();
  const prefixes = [
    "sk-",
    "sk_",
    "pk-",
    "anthropic_",
    "anthropic-",
    "sess-",
    "sess_",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "aws_",
    "akia",
    "bearer ",
  ];
  for (const p of prefixes) {
    if (lower.startsWith(p)) return true;
  }

  // Long opaque token: 32+ chars of base64url-ish. Env values that legitimately
  // need to be this long (URLs, JSON blobs) contain characters outside this
  // class, so the check is narrow enough to skip e.g. `https://...`.
  if (/^[A-Za-z0-9_\-+/=]{32,}$/.test(trimmed)) return true;

  return false;
}

export type EnvOverrideValidationResult = { ok: true } | { ok: false; key: string; reason: string };

/**
 * Refuse any env override whose value looks like a raw secret. Callers (CLI,
 * store) surface the returned `key` + `reason` so the user can redirect the
 * value into `apiKeyEnvRef` instead.
 */
export function validateEnvOverrides(
  overrides: Record<string, string> | undefined
): EnvOverrideValidationResult {
  if (!overrides) return { ok: true };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      return { ok: false, key, reason: "value must be a string" };
    }
    if (isLikelySecretValue(value)) {
      return {
        ok: false,
        key,
        reason:
          "value looks like a raw API key; set the secret in your shell and reference it via --api-key-ref <ENV_NAME> instead of --env",
      };
    }
  }
  return { ok: true };
}
