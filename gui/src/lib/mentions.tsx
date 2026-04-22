import type { ReactNode } from "react";
import type { UiChannel } from "./channel";

// `@alias` | `**bold**` | `` `code` ``. No other markdown, no autolinks.
const TOKEN_RE = /(@[a-zA-Z0-9][a-zA-Z0-9_-]*)|(\*\*[^*]+\*\*)|(`[^`]+`)/g;

type ChannelLike = Pick<UiChannel, "repos" | "primaryRepo"> | null | undefined;

/**
 * Render a message body as React nodes, recognising mention chips and
 * lightweight inline markdown (bold + inline code). Matches the Tidewater
 * spec: a single render path for chat / DM / decisions bodies.
 */
export function renderWithMentions(text: string, channel: ChannelLike): ReactNode[] {
  if (!text) return [];
  const aliasSet = new Set(channel?.repos ?? []);
  const primary = channel?.primaryRepo ?? "";
  const nodes: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIdx) {
      nodes.push(<span key={key++}>{text.slice(lastIdx, idx)}</span>);
    }
    const tok = match[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      nodes.push(
        <code key={key++} className="mention-code">
          {tok.slice(1, -1)}
        </code>
      );
    } else {
      const alias = tok.slice(1);
      const handle = alias.toLowerCase();
      const isRepo = aliasSet.has(handle);
      const isPrimary = isRepo && primary === handle;
      const cls = isPrimary
        ? "mention mention-repo-primary"
        : isRepo
          ? "mention mention-repo-attached"
          : "mention mention-human";
      nodes.push(
        <span key={key++} className={cls}>
          {tok}
        </span>
      );
    }
    lastIdx = idx + tok.length;
  }
  if (lastIdx < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  }
  return nodes;
}

/**
 * Extract `@xxx` tokens from a body without classifying them as repo/human
 * (the caller knows the channel). Useful for mention routing / notification
 * derivation in the composer.
 */
export function extractMentions(text: string): Array<{ alias: string; offset: number }> {
  const out: Array<{ alias: string; offset: number }> = [];
  for (const match of text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)) {
    out.push({ alias: match[1], offset: match.index ?? 0 });
  }
  return out;
}
