import type { ReactNode } from "react";
import { Children, Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MentionContext } from "./channel";

type ChannelLike = MentionContext | null | undefined;

// Inline-only tokens still understood by `renderWithMentions`. Full
// markdown rendering lives in `renderMarkdown` below; this helper stays
// for surfaces where block-level output (headings, lists, code blocks)
// would look wrong — e.g. single-line decision descriptions.
const INLINE_TOKEN_RE = /(@[a-zA-Z0-9][a-zA-Z0-9_-]*)|(\*\*[^*]+\*\*)|(`[^`]+`)/g;
// Mention-only tokenizer used to re-classify `@alias` text inside the
// markdown AST. Bold/italic/code are already structural nodes by the
// time react-markdown hands us the children, so we only need mentions.
const MENTION_RE = /(@[a-zA-Z0-9][a-zA-Z0-9_-]*)/g;

function mentionNode(
  token: string,
  channel: ChannelLike,
  key: string | number,
): ReactNode {
  const alias = token.slice(1);
  const handle = alias.toLowerCase();
  const aliasSet = new Set(channel?.repos ?? []);
  const primary = channel?.primaryRepo ?? "";
  const isRepo = aliasSet.has(handle);
  const isPrimary = isRepo && primary === handle;
  const cls = isPrimary
    ? "mention mention-repo-primary"
    : isRepo
      ? "mention mention-repo-attached"
      : "mention mention-human";
  return (
    <span key={key} className={cls}>
      {token}
    </span>
  );
}

/**
 * Render a message body as React nodes, recognising mention chips and
 * lightweight inline markdown (bold + inline code). Single-line surfaces
 * (decisions, feed entries, short descriptions) use this so block-level
 * markdown can't distort layout.
 */
export function renderWithMentions(text: string, channel: ChannelLike): ReactNode[] {
  if (!text) return [];
  const nodes: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
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
      nodes.push(mentionNode(tok, channel, key++));
    }
    lastIdx = idx + tok.length;
  }
  if (lastIdx < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  }
  return nodes;
}

// Walk every string child of a rendered markdown node, splitting on
// `@alias` tokens so mention chips survive inside paragraphs, list
// items, table cells, etc. Non-string children pass through untouched.
function injectMentions(children: ReactNode, channel: ChannelLike): ReactNode {
  const out: ReactNode[] = [];
  let k = 0;
  Children.forEach(children, (child) => {
    if (typeof child !== "string") {
      out.push(<Fragment key={k++}>{child}</Fragment>);
      return;
    }
    let lastIdx = 0;
    for (const match of child.matchAll(MENTION_RE)) {
      const idx = match.index ?? 0;
      if (idx > lastIdx) out.push(<Fragment key={k++}>{child.slice(lastIdx, idx)}</Fragment>);
      out.push(mentionNode(match[0], channel, k++));
      lastIdx = idx + match[0].length;
    }
    if (lastIdx < child.length)
      out.push(<Fragment key={k++}>{child.slice(lastIdx)}</Fragment>);
  });
  return <>{out}</>;
}

/**
 * Full-fidelity markdown rendering with GFM (tables, task lists,
 * strikethrough, auto-links) and mention-chip highlighting preserved
 * inside every block. Use for assistant replies, streaming chunks, and
 * feed bodies — anywhere claude-generated markdown should render
 * faithfully. Links open via the system browser by default.
 */
export function renderMarkdown(text: string, channel: ChannelLike): ReactNode {
  if (!text) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p>{injectMentions(children, channel)}</p>,
        li: ({ children }) => <li>{injectMentions(children, channel)}</li>,
        h1: ({ children }) => <h1>{injectMentions(children, channel)}</h1>,
        h2: ({ children }) => <h2>{injectMentions(children, channel)}</h2>,
        h3: ({ children }) => <h3>{injectMentions(children, channel)}</h3>,
        h4: ({ children }) => <h4>{injectMentions(children, channel)}</h4>,
        h5: ({ children }) => <h5>{injectMentions(children, channel)}</h5>,
        h6: ({ children }) => <h6>{injectMentions(children, channel)}</h6>,
        em: ({ children }) => <em>{injectMentions(children, channel)}</em>,
        strong: ({ children }) => <strong>{injectMentions(children, channel)}</strong>,
        td: ({ children }) => <td>{injectMentions(children, channel)}</td>,
        th: ({ children }) => <th>{injectMentions(children, channel)}</th>,
        blockquote: ({ children }) => <blockquote>{children}</blockquote>,
        // Anchor tags: render but mark them to open externally. Tauri
        // intercepts `target="_blank"` via the shell plugin; bare
        // http links in-app would otherwise navigate the webview.
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {injectMentions(children, channel)}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
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
