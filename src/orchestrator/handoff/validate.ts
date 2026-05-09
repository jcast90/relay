/**
 * Brief validation. Two modes (M2):
 *   - STRICT (used by `--to`): enforces token cap + missing-section checks
 *     + secret-pattern. Fails closed unless `--force` overrides the
 *     non-secret errors.
 *   - PERMISSIVE (used by `--save`): runs ONLY the secret-pattern check —
 *     `--save` is for archival; the cap is enforced when the brief is
 *     later resumed via `--to`. Token-cap and missing-section conditions
 *     become warnings (or are skipped) so post-resume callers see the
 *     signal.
 *
 * Secret-pattern errors are HARD in BOTH modes — no `--force` override
 * (D-09). Only the pattern name is reported; matched substrings are
 * NEVER returned (defense in depth, threat T-02-04).
 */

import { BRIEF_TOKEN_BUDGETS, type BriefSection, type HandoffBrief } from "./types.js";

export type ValidateMode = "strict" | "permissive";

export interface ValidateOptions {
  mode: ValidateMode;
  /** Hard cap override for STRICT mode. Default `BRIEF_TOKEN_BUDGETS.totalHardCap`. */
  maxTokens?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "AWS access key (AKIA…)", regex: /AKIA[A-Z0-9]{16}/ },
  { name: "OpenAI-style key (sk-…)", regex: /sk-[a-zA-Z0-9]{20,}/ },
  {
    name: "Generic key=value secret",
    regex: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*\S{8,}/i,
  },
  { name: "PEM private key block", regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
];

const REQUIRED_SECTION_KEYS = [
  "statusSnapshot",
  "mission",
  "ticketDag",
  "recentDecisions",
  "filesTouched",
  "workingMemory",
] as const;

export function validateBrief(brief: HandoffBrief, opts: ValidateOptions): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxTokens = opts.maxTokens ?? BRIEF_TOKEN_BUDGETS.totalHardCap;

  // Token-cap check.
  if (opts.mode === "strict") {
    if (brief.tokenEstimate > maxTokens) {
      errors.push(
        `Brief exceeds hard cap (${brief.tokenEstimate} > ${maxTokens}). ` +
          `Re-run with --force to override.`
      );
    }
  } else if (brief.tokenEstimate > maxTokens) {
    // PERMISSIVE: surface as warning so post-resume callers see the signal.
    warnings.push(
      `Brief exceeds the cap that would apply at --to time ` +
        `(${brief.tokenEstimate} > ${maxTokens}). ` +
        `Save accepted; --to will require --force or trimming.`
    );
  }

  // Soft-cap warning (BOTH modes).
  if (brief.tokenEstimate > BRIEF_TOKEN_BUDGETS.totalSoftCap) {
    warnings.push("Brief above soft cap; consider trimming.");
  }

  // Required-sections check.
  if (opts.mode === "strict") {
    for (const key of REQUIRED_SECTION_KEYS) {
      const section = (brief.sections as Record<string, BriefSection | undefined>)[key];
      if (!section || !section.heading || !section.body) {
        errors.push(`Required section missing or empty: ${key}`);
      }
    }
  }

  // Truncation warnings.
  for (const key of REQUIRED_SECTION_KEYS) {
    const section = (brief.sections as Record<string, BriefSection | undefined>)[key];
    if (section?.truncated) {
      warnings.push(`Section truncated to fit budget: ${key}`);
    }
  }

  // Secret-pattern check — HARD in BOTH modes (D-09).
  for (const key of REQUIRED_SECTION_KEYS) {
    const section = (brief.sections as Record<string, BriefSection | undefined>)[key];
    if (!section?.body) continue;
    for (const pat of SECRET_PATTERNS) {
      if (pat.regex.test(section.body)) {
        errors.push(`Possible secret detected in section "${key}": ${pat.name}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
