//! Shared tool-use activity rendering for the GUI (src-tauri), the TUI, and
//! any other Rust surface that needs to turn a Claude stream-json `tool_use`
//! block into a one-line skimmable description.
//!
//! The CLI has a parallel TypeScript implementation in
//! `src/domain/tool-activity.ts` — keep the two in sync when adding cases.
//! These two sources are the cross-dashboard contract for tool-use
//! visualization parity (ticket OSS-06).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Max number of activity entries to retain per stream. Matches the GUI's
/// `ACTIVITY_STACK_MAX` so cap-before-append behavior is identical across
/// surfaces.
pub const ACTIVITY_STACK_MAX: usize = 20;

/// Default number of newest activity entries to show when the stack is
/// collapsed. Matches the GUI's `ACTIVITY_TOP_N`.
pub const ACTIVITY_TOP_N: usize = 3;

/// One entry in a streaming activity stack. Matches the shape used by the
/// GUI's `ActivityEntry` and the TUI's `ActivityStack.entries`, serialized as
/// camelCase so it round-trips with the TS side if we ever persist it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivityEntry {
    /// Human-readable one-liner (e.g. "Reading foo.ts" or "$ pnpm test").
    pub text: String,
    /// Unix epoch milliseconds. The TUI stores a formatted time string; this
    /// field is the canonical numeric form used by the GUI/CLI.
    pub ts: i64,
}

/// Build a human-readable one-liner describing what a `tool_use` block from
/// Claude's stream-json output is doing. Deliberately short — the goal is a
/// skimmable feed, not a full payload dump.
///
/// Keep this mirrored with `describeToolUse` in `src/domain/tool-activity.ts`
/// (the CLI/TS side). Adding a new case? Add it there too.
pub fn describe_tool_use(name: &str, input: &Value) -> String {
    let get_str = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let basename = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();

    match name {
        "Read" => format!("Reading {}", basename(&get_str("file_path"))),
        "Edit" => format!("Editing {}", basename(&get_str("file_path"))),
        "Write" => format!("Writing {}", basename(&get_str("file_path"))),
        "Bash" => format!("$ {}", truncate_chars(&get_str("command"), 60)),
        "Grep" => format!("Searching '{}'", truncate_chars(&get_str("pattern"), 40)),
        "Glob" => format!("Finding {}", get_str("pattern")),
        "Agent" => {
            let desc = get_str("description");
            if desc.is_empty() {
                "Spawning agent".to_string()
            } else {
                format!("Agent: {}", desc)
            }
        }
        "WebSearch" => format!("Web search: {}", truncate_chars(&get_str("query"), 40)),
        "WebFetch" => format!("Fetching {}", truncate_chars(&get_str("url"), 50)),
        "LSP" => format!("LSP {}", get_str("method")),
        "Skill" => format!("/{}", get_str("skill")),
        _ => name.to_string(),
    }
}

/// Truncate a string to `n` chars (not bytes), appending `…` when clipped.
/// Unicode-safe: uses `chars().count()` / `chars().take()` so multibyte
/// sequences aren't split mid-codepoint.
fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_uses_basename() {
        let d = describe_tool_use("Read", &json!({ "file_path": "/abs/path/src/foo.ts" }));
        assert_eq!(d, "Reading foo.ts");
    }

    #[test]
    fn bash_truncates_long_commands() {
        let cmd = "a".repeat(200);
        let d = describe_tool_use("Bash", &json!({ "command": cmd }));
        // $ + 60 chars + ellipsis
        assert!(d.starts_with("$ "));
        assert!(d.ends_with('…'));
        assert_eq!(d.chars().count(), 2 + 60 + 1);
    }

    #[test]
    fn unknown_tool_falls_back_to_name() {
        let d = describe_tool_use("Mystery", &json!({}));
        assert_eq!(d, "Mystery");
    }

    #[test]
    fn skill_formats_with_slash() {
        let d = describe_tool_use("Skill", &json!({ "skill": "review-pr" }));
        assert_eq!(d, "/review-pr");
    }

    #[test]
    fn truncate_handles_multibyte() {
        // Smoke test: 100 ✓ chars, truncate to 5 — must not panic on UTF-8
        // boundary and must preserve full codepoints.
        let s = "✓".repeat(100);
        let t = truncate_chars(&s, 5);
        assert_eq!(t.chars().count(), 6); // 5 + ellipsis
    }

    #[test]
    fn activity_entry_roundtrips_camelcase() {
        let e = ToolActivityEntry {
            text: "Reading foo.ts".into(),
            ts: 1_700_000_000_000,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("\"text\""));
        assert!(s.contains("\"ts\""));
        let back: ToolActivityEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back.text, "Reading foo.ts");
    }
}
