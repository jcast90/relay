// Alias derivation lives here so every attach-repo surface (new-channel
// wizard, add-repo popover, mention autocomplete, promote-dm modal, etc.)
// produces the same shape from the same repoPath — and so we can bump the
// length cap in one place.
//
// Previously each site did `basename.replace(...).slice(0, 12)` which cut
// aliases that looked like `turingon-core-ui` down to `turingon-cor`,
// colliding with `turingon-core-be` (also `turingon-cor`). That both looked
// bad in the UI and, because it blew past the Rust validator's char rules
// when pathological inputs sneaked a ':' through, sometimes broke
// channel-create entirely.

const MAX_ALIAS_LEN = 40;

/** Strip disallowed chars (keep A-Z a-z 0-9 . _ -) and cap length. */
export function deriveAlias(repoPath: string): string {
  const base = basename(repoPath);
  const cleaned = base.replace(/[^a-z0-9._-]/gi, "").toLowerCase();
  return cleaned.slice(0, MAX_ALIAS_LEN) || "repo";
}

/**
 * Given a list of { repoPath, seedAlias? } items, produce a parallel list of
 * unique aliases. Duplicates get `-2`, `-3` suffixes in input order.
 */
export function dedupeAliases<T extends { repoPath: string; seedAlias?: string }>(
  items: T[]
): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = item.seedAlias?.trim() || deriveAlias(item.repoPath);
    const hits = seen.get(base) ?? 0;
    seen.set(base, hits + 1);
    return hits === 0 ? base : `${base}-${hits + 1}`;
  });
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
