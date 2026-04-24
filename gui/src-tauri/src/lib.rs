use harness_data as data;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

/// Defense-in-depth validator for IDs crossing the Tauri IPC boundary.
///
/// The shared `harness-data` crate already rejects traversal-y segments when
/// it builds paths, but a compromised renderer should hit this guard first.
/// Rules:
///   - non-empty
///   - not `.` or `..`
///   - no `/`, `\`, or null byte
///   - only ASCII alphanumerics plus `.`, `_`, `-`
///
/// These match the character class that IDs elsewhere in the codebase
/// ultimately land on (see `assertSafeSegment` in `src/storage/file-store.ts`)
/// while being a little stricter at the edge.
fn validate_id_segment<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        return Err(format!("{} must not be empty", field));
    }
    if value == "." || value == ".." {
        return Err(format!("{} must not be '.' or '..'", field));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-';
        if !ok {
            return Err(format!(
                "{} contains disallowed character '{}'; allowed: A-Z a-z 0-9 . _ -",
                field, ch
            ));
        }
    }
    Ok(value)
}

/// Filter a `repos` payload to only the assignments whose alias +
/// workspaceId can round-trip through the `--repos a:b:c` CLI encoding.
/// Returns the kept list plus a list of dropped aliases so the caller
/// can surface a "N repos skipped" hint to the UI — previously we
/// ate the drops with a bare `eprintln!`, which code review flagged
/// as a silent narrowing of the request.
fn sanitize_repos(
    repos: Vec<RepoAssignmentInput>,
) -> (Vec<RepoAssignmentInput>, Vec<String>) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for r in repos.into_iter() {
        let alias_ok = !r.alias.is_empty()
            && r.alias != "."
            && r.alias != ".."
            && r.alias
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
        let ws_ok = !r.workspace_id.is_empty()
            && r.workspace_id != "."
            && r.workspace_id != ".."
            && r.workspace_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
        if alias_ok && ws_ok {
            kept.push(r);
        } else {
            eprintln!(
                "[gui] dropping unrepresentable repo assignment alias='{}' workspaceId='{}' repoPath='{}'",
                r.alias, r.workspace_id, r.repo_path
            );
            // Surface the most-identifying non-empty field so the UI
            // can render something meaningful even when the alias is
            // the empty/invalid side.
            let label = if !r.alias.is_empty() {
                r.alias
            } else if !r.workspace_id.is_empty() {
                r.workspace_id
            } else {
                r.repo_path
            };
            dropped.push(label);
        }
    }
    (kept, dropped)
}

/// Attach a `droppedRepos` array to a JSON payload returned from the
/// CLI so the frontend can surface a warning banner. No-op when
/// nothing was dropped; preserves whatever shape the CLI returned.
fn with_dropped_repos(mut value: serde_json::Value, dropped: Vec<String>) -> serde_json::Value {
    if dropped.is_empty() {
        return value;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "droppedRepos".to_string(),
            serde_json::Value::Array(dropped.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    value
}

#[tauri::command]
fn list_workspaces() -> Vec<data::WorkspaceEntry> {
    data::load_workspaces()
}

#[tauri::command]
fn list_channels(include_archived: Option<bool>) -> Vec<data::Channel> {
    data::load_channels_with_status(include_archived.unwrap_or(false))
}

#[tauri::command]
fn get_channel(channel_id: String) -> Result<Option<data::Channel>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    // Include archived channels so the UI can resolve a channel after it's
    // been archived (needed for the unarchive round-trip and for any
    // deep-linked view).
    Ok(data::load_channels_with_status(true)
        .into_iter()
        .find(|c| c.channel_id == channel_id))
}

#[tauri::command]
fn list_feed(channel_id: String, limit: usize) -> Result<Vec<data::ChannelEntry>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_channel_feed(&channel_id, limit))
}

#[tauri::command]
fn list_sessions(channel_id: String) -> Result<Vec<data::ChatSession>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_sessions(&channel_id))
}

/// Aggregate session counts for the Sidebar's Threads row. Counts only
/// active, channel-kind entries — archived channels and DMs don't belong
/// in a "threads across channels" metric. One call instead of N.
#[tauri::command]
fn list_session_counts() -> std::collections::HashMap<String, usize> {
    let channels = data::load_channels_with_status(false);
    channels
        .into_iter()
        .filter(|c| c.kind.as_deref() != Some("dm"))
        .map(|c| {
            let count = data::load_sessions(&c.channel_id).len();
            (c.channel_id, count)
        })
        .collect()
}

#[tauri::command]
fn load_session(
    channel_id: String,
    session_id: String,
    limit: usize,
) -> Result<Vec<data::PersistedChatMessage>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    Ok(data::load_session_chat(&channel_id, &session_id, limit))
}

#[tauri::command]
fn list_channel_tickets(channel_id: String) -> Result<Vec<data::TicketLedgerEntry>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_channel_tickets(&channel_id))
}

#[tauri::command]
fn list_channel_decisions(channel_id: String) -> Result<Vec<data::Decision>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_channel_decisions(&channel_id))
}

#[tauri::command]
fn list_channel_runs(channel_id: String) -> Result<Vec<data::ChannelRunLink>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_channel_run_links(&channel_id))
}

#[tauri::command]
fn list_runs(workspace_id: String) -> Result<Vec<data::RunIndexEntry>, String> {
    validate_id_segment(&workspace_id, "workspaceId")?;
    Ok(data::load_runs_for_workspace(&workspace_id))
}

#[tauri::command]
fn list_ticket_ledger(
    workspace_id: String,
    run_id: String,
) -> Result<Vec<data::TicketLedgerEntry>, String> {
    validate_id_segment(&workspace_id, "workspaceId")?;
    validate_id_segment(&run_id, "runId")?;
    Ok(data::load_ticket_ledger(&workspace_id, &run_id))
}

#[tauri::command]
fn list_agent_names() -> Vec<data::AgentNameEntry> {
    data::load_agent_names()
}

#[tauri::command]
fn list_tracked_prs(channel_id: String) -> Result<Vec<data::TrackedPrRow>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_tracked_prs(&channel_id))
}

/// Entries returned from `list_pending_plans`. Optional `channel_id` is
/// surfaced so the GUI can filter per-channel without re-reading the runs
/// index.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPlan {
    run_id: String,
    workspace_id: String,
    feature_request: String,
    channel_id: Option<String>,
    state: String,
    updated_at: String,
}

#[tauri::command]
fn list_pending_plans() -> Vec<PendingPlan> {
    let mut out = Vec::new();
    for ws in data::load_workspaces() {
        for run in data::load_runs_for_workspace(&ws.workspace_id) {
            if data::is_awaiting_approval(&run) {
                out.push(PendingPlan {
                    run_id: run.run_id.clone(),
                    workspace_id: ws.workspace_id.clone(),
                    feature_request: run.feature_request.clone(),
                    channel_id: run.channel_id.clone(),
                    state: run.state.clone(),
                    updated_at: run.updated_at.clone(),
                });
            }
        }
    }
    out
}

/// Approve a pending plan by shelling out to `rly approve <runId>`. Surfaces
/// the CLI's JSON output directly so the GUI can render errors.
#[tauri::command]
fn approve_plan(run_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&run_id, "runId")?;
    cli_json(&["approve", &run_id])
}

#[tauri::command]
fn reject_plan(
    run_id: String,
    feedback: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&run_id, "runId")?;
    let mut args: Vec<&str> = vec!["reject", &run_id];
    if let Some(ref fb) = feedback {
        args.push("--feedback");
        args.push(fb);
    }
    cli_json(&args)
}

/// List pending approvals-queue records for a single session (no args = all
/// sessions). Reads `~/.relay/approvals/<sessionId>/queue.jsonl` directly
/// via `harness-data`; no CLI round-trip so the right-pane 5-second tick
/// stays cheap.
#[tauri::command]
fn list_pending_approvals(
    session_id: Option<String>,
) -> Result<Vec<data::ApprovalQueueRecord>, String> {
    if let Some(ref s) = session_id {
        validate_id_segment(s, "sessionId")?;
        let mut out = data::load_approval_queue(s);
        // I9: filter through the typed enum so stringly-typed status
        // comparisons can't drift out of sync with the TS source of truth.
        out.retain(|r| r.status_enum() == Some(data::ApprovalStatus::Pending));
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        return Ok(out);
    }
    Ok(data::load_all_pending_approvals())
}

/// Approve a single AL-8 queue record by id. Shells out to
/// `rly approve <id> --json` so the canonical queue mutation path lives in
/// one place (the TS writer). Returns the CLI's JSON envelope verbatim.
#[tauri::command]
fn approve_queue_entry(id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&id, "id")?;
    cli_json(&["approve", &id, "--json"])
}

/// Reject a single AL-8 queue record with optional `--feedback`. Same
/// shell-out contract as `approve_queue_entry`.
#[tauri::command]
fn reject_queue_entry(
    id: String,
    feedback: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&id, "id")?;
    let mut args: Vec<&str> = vec!["reject", &id, "--json"];
    if let Some(ref fb) = feedback {
        args.push("--feedback");
        args.push(fb);
    }
    cli_json(&args)
}

/// Approve all pending queue records (optionally scoped to one session).
/// Convenience for the "Approve all" button in the RightPane; still
/// dispatches through the CLI so the queue file mutation is authoritative.
#[tauri::command]
fn approve_queue_all(session_id: Option<String>) -> Result<serde_json::Value, String> {
    let mut args: Vec<String> = vec!["approve".into(), "all".into(), "--json".into()];
    if let Some(ref s) = session_id {
        validate_id_segment(s, "sessionId")?;
        args.push("--session".into());
        args.push(s.clone());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli_json(&refs)
}

#[derive(Serialize)]
struct CliResult {
    success: bool,
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

/// Resolve the `rly` binary to an absolute path.
///
/// When the GUI is launched from Finder/Launchpad on macOS, it inherits
/// launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — shell init
/// files never run, so per-user install dirs (pnpm global, homebrew,
/// npm-global, cargo, ~/.local/bin) aren't visible. A bare
/// `Command::new("rly")` then fails ENOENT even though `rly` is installed.
///
/// Resolution order:
///   1. `$RELAY_BIN` — explicit override, always wins.
///   2. `$PATH` — works for terminal-launched sessions.
///   3. Candidate user-local install dirs — covers Finder launches.
///
/// Resolved once per process (the CLI location doesn't change under us).
fn resolve_rly_bin() -> String {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            if let Ok(v) = std::env::var("RELAY_BIN") {
                if !v.is_empty() {
                    return v;
                }
            }
            if let Some(p) = find_on_path("rly") {
                return p;
            }
            let home = std::env::var("HOME").unwrap_or_default();
            let candidates = [
                format!("{home}/Library/pnpm/rly"),      // pnpm global, macOS
                format!("{home}/.local/share/pnpm/rly"), // pnpm global, linux
                "/opt/homebrew/bin/rly".to_string(),     // homebrew, apple silicon
                "/usr/local/bin/rly".to_string(),        // homebrew intel + /usr/local
                format!("{home}/.npm-global/bin/rly"),
                format!("{home}/.local/bin/rly"),
                format!("{home}/.cargo/bin/rly"),
            ];
            for c in &candidates {
                if std::path::Path::new(c).is_file() {
                    return c.clone();
                }
            }
            // Nothing found — return the bare name so Command::new produces
            // the ENOENT and cli_json wraps it with the full args for context.
            "rly".to_string()
        })
        .clone()
}

fn find_on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Build a PATH for child processes that augments the inherited PATH
/// with well-known node / user-bin install dirs.
///
/// `resolve_rly_bin` fixes finding the `rly` binary from a Finder-
/// launched GUI (PR #129), but the pnpm-generated shim itself then runs
/// `exec node …`. That second hop inherits the same minimal launchd
/// PATH and fails with `node: not found`. Augmenting the child's PATH
/// here fixes the whole chain — shim → node → rly.mjs — without having
/// to patch every shim on every user's machine.
///
/// Extras are **appended** in highest→lowest priority order. The
/// inherited parent PATH stays first so terminal-launched sessions keep
/// using the user's own ordering; launchd-launched GUIs get nvm, the
/// homebrew prefixes, and the usual user-local bins tacked on. Nvm
/// leads the extras so its modern node wins over a stale
/// `/usr/local/bin/node` (observed during testing — a crusty old node
/// installed at `/usr/local/bin` crashed with
/// `ERR_UNKNOWN_BUILTIN_MODULE: node:readline/promises` before being
/// shadowed by nvm).
///
/// Thin wrapper — recomputes on each call. The work is a handful of
/// `read_dir` + `is_dir` probes, dwarfed by the child-process spawn
/// that consumes the result. Previous versions cached with `OnceLock`,
/// but cargo-test runs multiple tests in the same process and a cache
/// poisoned by early test env would leak into later tests.
fn augmented_child_path() -> String {
    let home = std::env::var_os("HOME").unwrap_or_default();
    let parent = std::env::var_os("PATH").unwrap_or_default();
    compute_augmented_path(&parent, &home)
}

/// Pure helper — `augmented_child_path` reads from process env, this
/// takes the parent PATH and HOME as inputs so tests can exercise it
/// without mutating process-wide state.
fn compute_augmented_path(parent_path: &std::ffi::OsStr, home: &std::ffi::OsStr) -> String {
    let home_path = PathBuf::from(home);
    let mut parts: Vec<PathBuf> = std::env::split_paths(parent_path).collect();
    let mut seen: HashSet<PathBuf> = parts.iter().cloned().collect();

    let mut extras: Vec<PathBuf> = Vec::new();

    // nvm first (highest priority). Newest version wins.
    let nvm_root = home_path.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        versions.sort_by(|a, b| b.cmp(a)); // newest first
        for v in versions {
            extras.push(v.join("bin"));
        }
    }

    // Homebrew prefixes + misc user-local install dirs.
    extras.push(PathBuf::from("/opt/homebrew/bin"));
    extras.push(PathBuf::from("/usr/local/bin"));
    for rel in [
        "Library/pnpm",
        ".local/share/pnpm",
        ".npm-global/bin",
        ".volta/bin",
        ".asdf/shims",
        ".cargo/bin",
        ".local/bin",
    ] {
        extras.push(home_path.join(rel));
    }

    for dir in extras {
        if dir.is_dir() && seen.insert(dir.clone()) {
            parts.push(dir);
        }
    }

    std::env::join_paths(parts)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn cli_run(args: &[&str]) -> CliResult {
    let bin = resolve_rly_bin();
    match Command::new(&bin)
        .args(args)
        .env("PATH", augmented_child_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(output) => CliResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            code: output.status.code(),
        },
        Err(e) => CliResult {
            success: false,
            stdout: String::new(),
            stderr: e.to_string(),
            code: None,
        },
    }
}

fn cli_json(args: &[&str]) -> Result<serde_json::Value, String> {
    let result = cli_run(args);
    if !result.success {
        // code == None means spawn itself failed (ENOENT, EACCES) — the
        // child never ran. Augment with the resolved path and the
        // RELAY_BIN override so the user has an actionable message.
        if result.code.is_none() {
            return Err(format!(
                "rly {} failed to launch: {} (resolved binary: {}). \
                 Set RELAY_BIN or install rly on PATH.",
                args.join(" "),
                result.stderr.trim(),
                resolve_rly_bin()
            ));
        }
        return Err(format!(
            "rly {} failed: {}",
            args.join(" "),
            result.stderr.trim()
        ));
    }
    serde_json::from_str(result.stdout.trim()).map_err(|e| {
        format!(
            "invalid JSON from rly {}: {} (output: {})",
            args.join(" "),
            e,
            result.stdout
        )
    })
}

/// Subcommands the renderer is allowed to invoke through `run_cli`.
///
/// The frontend reaches the CLI through the typed wrappers
/// (`create_channel`, `post_to_channel`, etc.). `run_cli` stays for
/// escape-hatch diagnostics but is locked down to a short read-only list
/// so a compromised renderer can't trigger destructive operations. Add
/// entries here as the renderer
/// grows legitimate needs.
const RUN_CLI_ALLOWED_SUBCOMMANDS: &[&[&str]] = &[
    &["channel", "list"],
    &["channel", "show"],
    &["session", "list"],
    &["chat", "mcp-config"],
    &["chat", "system-prompt"],
    &["inspect-mcp"],
    &["version"],
    &["--version"],
    &["--help"],
];

/// Subcommand verbs that are *never* allowed through `run_cli`, regardless
/// of whether they appear in `RUN_CLI_ALLOWED_SUBCOMMANDS`. Reviewers
/// adding to the allow-list: this denylist still wins.
const RUN_CLI_DENIED_VERBS: &[&str] = &[
    "archive", "delete", "remove", "rm", "destroy", "purge", "drop", "reset",
];

fn check_run_cli_allowed(args: &[&str]) -> Result<(), String> {
    if args.is_empty() {
        return Err("run_cli requires at least one argument".into());
    }
    for part in args {
        if RUN_CLI_DENIED_VERBS.contains(part) {
            return Err(format!(
                "run_cli: destructive subcommand '{}' is not permitted from the renderer",
                part
            ));
        }
    }
    let matches_prefix = RUN_CLI_ALLOWED_SUBCOMMANDS.iter().any(|prefix| {
        prefix.len() <= args.len() && prefix.iter().zip(args.iter()).all(|(a, b)| a == b)
    });
    if !matches_prefix {
        return Err(format!(
            "run_cli: subcommand '{}' is not in the renderer allow-list",
            args.join(" ")
        ));
    }
    Ok(())
}

#[tauri::command]
fn run_cli(args: Vec<String>) -> Result<CliResult, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    check_run_cli_allowed(&refs)?;
    Ok(cli_run(&refs))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAssignmentInput {
    pub alias: String,
    pub workspace_id: String,
    pub repo_path: String,
}

fn repos_arg(repos: &[RepoAssignmentInput]) -> String {
    repos
        .iter()
        .map(|r| format!("{}:{}:{}", r.alias, r.workspace_id, r.repo_path))
        .collect::<Vec<_>>()
        .join(",")
}

#[tauri::command]
fn create_channel(
    name: String,
    description: String,
    repos: Vec<RepoAssignmentInput>,
    #[allow(non_snake_case)] primaryWorkspaceId: Option<String>,
) -> Result<serde_json::Value, String> {
    let (repos, dropped) = sanitize_repos(repos);
    if let Some(ref id) = primaryWorkspaceId {
        validate_id_segment(id, "primaryWorkspaceId")?;
    }

    // Resolve the primary workspace id (if provided) to the matching alias —
    // the CLI takes `--primary <alias>` because aliases are user-facing, but
    // the GUI works with workspace ids. When the id isn't in the repos list
    // we silently drop it; the CLI would error and that matters less than
    // the create succeeding with a sensible fallback.
    let primary_alias = primaryWorkspaceId
        .as_ref()
        .and_then(|id| repos.iter().find(|r| &r.workspace_id == id))
        .map(|r| r.alias.clone());

    let repos_str = repos_arg(&repos);
    let mut args: Vec<&str> = vec!["channel", "create", &name, &description, "--json"];
    if !repos_str.is_empty() {
        args.push("--repos");
        args.push(&repos_str);
    }
    if let Some(ref alias) = primary_alias {
        args.push("--primary");
        args.push(alias);
    }
    let result = cli_json(&args)?;

    // Stamp a heuristic tier on the newly-created channel so the header
    // pill shows a best-guess immediately. Best-effort — if the CLI
    // returned a different shape or the channel file isn't readable yet,
    // skip silently; the user can set tier manually in the About tab and
    // the real orchestrator classifier will refine it on first dispatch.
    if let Some(channel_id) = result.get("channelId").and_then(|v| v.as_str()) {
        if let Some(mut ch) = data::load_channel(channel_id) {
            if ch.tier.is_none() {
                ch.tier = Some(data::classify_tier_heuristic(&name, &description));
                let _ = data::save_channel(&ch);
            }
        }
    }
    Ok(with_dropped_repos(result, dropped))
}

/// Mint a DM channel directly from Rust (no CLI round-trip). A DM is a
/// regular Channel under the hood with `kind = "dm"` so it reuses
/// sessions / rewind / streams, but the sidebar + center pane render it
/// as a kickoff surface.
#[tauri::command]
fn create_dm(
    workspace_id: String,
    workspace_path: String,
    alias: String,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&workspace_id, "workspaceId")?;
    validate_id_segment(&alias, "alias")?;

    let now = chrono::Utc::now();
    // `dm-` prefix makes DMs self-identifying in logs/filesystem even
    // without loading the JSON. Timestamp + rand-ish ms suffix is good
    // enough for local single-user state.
    let channel_id = format!("dm-{}", now.timestamp_millis());
    let channel = data::Channel {
        channel_id: channel_id.clone(),
        name: format!("@{}", alias),
        description: String::new(),
        status: "active".to_string(),
        members: vec![],
        pinned_refs: vec![],
        repo_assignments: vec![data::RepoAssignment {
            alias: alias.clone(),
            workspace_id: workspace_id.clone(),
            repo_path: workspace_path,
        }],
        primary_workspace_id: Some(workspace_id),
        linear_project_id: None,
        tier: None,
        starred: false,
        full_access: None,
        kind: Some("dm".to_string()),
        section_id: None,
        provider_profile_id: None,
        pr: None,
        created_at: Some(now.to_rfc3339()),
        updated_at: Some(now.to_rfc3339()),
    };
    data::save_channel(&channel)?;
    Ok(serde_json::json!({ "channelId": channel_id }))
}

/// Promote a DM to a full channel. Flips `kind` → "channel", renames,
/// and extends `repo_assignments` + primary via a fresh save.
#[tauri::command]
fn promote_dm(
    channel_id: String,
    name: String,
    description: String,
    repos: Vec<RepoAssignmentInput>,
    #[allow(non_snake_case)] primaryWorkspaceId: Option<String>,
) -> Result<(), String> {
    validate_id_segment(&channel_id, "channelId")?;
    let (repos, dropped) = sanitize_repos(repos);
    if !dropped.is_empty() {
        eprintln!(
            "[gui] promote_dm dropped {} unrepresentable repo assignment(s): {}",
            dropped.len(),
            dropped.join(", ")
        );
    }
    let mut ch = data::load_channel(&channel_id)
        .ok_or_else(|| format!("channel {} not found", channel_id))?;
    ch.kind = Some("channel".to_string());
    ch.name = name;
    ch.description = description;
    ch.repo_assignments = repos
        .into_iter()
        .map(|r| data::RepoAssignment {
            alias: r.alias,
            workspace_id: r.workspace_id,
            repo_path: r.repo_path,
        })
        .collect();
    if let Some(id) = primaryWorkspaceId {
        ch.primary_workspace_id = Some(id);
    }
    data::save_channel(&ch)
}

#[tauri::command]
fn archive_channel(channel_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    cli_json(&["channel", "archive", &channel_id, "--json"])
}

// ─── Sections ────────────────────────────────────────────────────
// Sidebar grouping layer. All writes shell out to `rly section …`
// via cli_json so the CLI and GUI share a single mutation path and
// the sections.json on disk stays consistent.

#[tauri::command]
fn list_sections(include_decommissioned: Option<bool>) -> Result<serde_json::Value, String> {
    if include_decommissioned.unwrap_or(false) {
        cli_json(&["section", "list", "--include-decommissioned", "--json"])
    } else {
        cli_json(&["section", "list", "--json"])
    }
}

#[tauri::command]
fn create_section(name: String) -> Result<serde_json::Value, String> {
    if name.trim().is_empty() {
        return Err("section name must not be empty".into());
    }
    cli_json(&["section", "create", &name, "--json"])
}

#[tauri::command]
fn rename_section(section_id: String, name: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&section_id, "sectionId")?;
    if name.trim().is_empty() {
        return Err("section name must not be empty".into());
    }
    cli_json(&["section", "rename", &section_id, &name, "--json"])
}

#[tauri::command]
fn decommission_section(section_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&section_id, "sectionId")?;
    cli_json(&["section", "decommission", &section_id, "--json"])
}

#[tauri::command]
fn restore_section(section_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&section_id, "sectionId")?;
    cli_json(&["section", "restore", &section_id, "--json"])
}

#[tauri::command]
fn delete_section(section_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&section_id, "sectionId")?;
    cli_json(&["section", "delete", &section_id, "--json"])
}

#[tauri::command]
fn assign_channel_section(
    channel_id: String,
    section_id: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    let target = match section_id.as_deref() {
        None | Some("") => "--none".to_string(),
        Some(s) => {
            validate_id_segment(s, "sectionId")?;
            s.to_string()
        }
    };
    cli_json(&["channel", "assign", &channel_id, &target, "--json"])
}

#[tauri::command]
fn unarchive_channel(channel_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    cli_json(&["channel", "unarchive", &channel_id, "--json"])
}

#[tauri::command]
fn set_channel_full_access(
    channel_id: String,
    on: bool,
) -> Result<serde_json::Value, String> {
    // Mirrors `archive_channel` / `unarchive_channel`: defer to the CLI so
    // there's a single code path that writes both the flag AND the decision
    // entry (the audit trail required by AL-0). Tag the actor as "gui" so
    // decisions recorded from the desktop app are distinguishable from CLI
    // invocations in `rly decisions <channelId>`.
    validate_id_segment(&channel_id, "channelId")?;
    let state = if on { "on" } else { "off" };
    cli_json(&[
        "channel",
        "set-full-access",
        &channel_id,
        state,
        "--source",
        "gui",
        "--actor",
        "gui",
        "--json",
    ])
}

#[tauri::command]
fn update_channel_repos(
    channel_id: String,
    repos: Vec<RepoAssignmentInput>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    let (repos, dropped) = sanitize_repos(repos);
    let repos_str = repos_arg(&repos);
    let result = cli_json(&["channel", "update", &channel_id, "--repos", &repos_str, "--json"])?;
    Ok(with_dropped_repos(result, dropped))
}

#[tauri::command]
fn set_channel_starred(channel_id: String, starred: bool) -> Result<(), String> {
    validate_id_segment(&channel_id, "channelId")?;
    let mut ch = data::load_channel(&channel_id)
        .ok_or_else(|| format!("channel {} not found", channel_id))?;
    ch.starred = starred;
    data::save_channel(&ch)
}

#[tauri::command]
fn set_channel_tier(channel_id: String, tier: Option<String>) -> Result<(), String> {
    validate_id_segment(&channel_id, "channelId")?;
    let parsed = match tier.as_deref() {
        None | Some("") => None,
        Some("feature_large") => Some(data::ChannelTier::FeatureLarge),
        Some("feature") => Some(data::ChannelTier::Feature),
        Some("bugfix") => Some(data::ChannelTier::Bugfix),
        Some("chore") => Some(data::ChannelTier::Chore),
        Some("question") => Some(data::ChannelTier::Question),
        Some(other) => return Err(format!("unknown tier: {}", other)),
    };
    let mut ch = data::load_channel(&channel_id)
        .ok_or_else(|| format!("channel {} not found", channel_id))?;
    ch.tier = parsed;
    data::save_channel(&ch)
}

// ─── Provider profiles ───────────────────────────────────────────
// Added by PR 3 of the multi-provider series. All commands shell out
// to the `rly providers …` / `rly channel set-provider` CLI paths
// added by PRs 1 and 2 respectively — keeping one mutation path
// across CLI + GUI. When the underlying subcommand isn't available
// yet (PR 1/2 not merged), `cli_json` surfaces the non-zero exit
// with stderr attached so the GUI shows a clear error banner rather
// than silently succeeding.

#[tauri::command]
fn list_provider_profiles() -> Result<serde_json::Value, String> {
    // CLI emits `{ "defaultProfileId": ..., "profiles": [...] }`. The
    // renderer is typed as `Promise<ProviderProfile[]>`, so unwrap the
    // `profiles` array here — otherwise React's `.map()` on the object
    // crashes the drawer + the Providers settings tab.
    let value = cli_json(&["providers", "profiles", "list", "--json"])?;
    match value.get("profiles") {
        Some(profiles) => Ok(profiles.clone()),
        None => Ok(serde_json::json!([])),
    }
}

/// Read the globally-selected default profile id. The CLI prints
/// `{ "defaultProfileId": "<id>" | null }` in JSON mode; absence of
/// a default is normal and maps to `Ok(null)` on the renderer side.
#[tauri::command]
fn get_default_provider_profile_id() -> Result<Option<String>, String> {
    let value = cli_json(&["providers", "default", "--json"])?;
    Ok(value
        .get("defaultProfileId")
        .and_then(|v| v.as_str())
        .map(String::from))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileInput {
    pub id: String,
    pub display_name: String,
    pub adapter: String,
    #[serde(default)]
    pub env_overrides: BTreeMap<String, String>,
    #[serde(default)]
    pub api_key_env_ref: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
}

#[tauri::command]
fn upsert_provider_profile(profile: ProviderProfileInput) -> Result<serde_json::Value, String> {
    validate_id_segment(&profile.id, "profile.id")?;
    if profile.display_name.trim().is_empty() {
        return Err("profile.displayName must not be empty".into());
    }
    if profile.adapter != "claude" && profile.adapter != "codex" {
        return Err(format!(
            "profile.adapter must be 'claude' or 'codex' (got '{}')",
            profile.adapter
        ));
    }
    let mut args: Vec<String> = vec![
        "providers".into(),
        "profiles".into(),
        "add".into(),
        profile.id.clone(),
        "--adapter".into(),
        profile.adapter.clone(),
        "--display-name".into(),
        profile.display_name.clone(),
        "--json".into(),
    ];
    if let Some(ref model) = profile.default_model {
        if !model.is_empty() {
            args.push("--model".into());
            args.push(model.clone());
        }
    }
    if let Some(ref key) = profile.api_key_env_ref {
        if !key.is_empty() {
            args.push("--api-key-ref".into());
            args.push(key.clone());
        }
    }
    for (k, v) in profile.env_overrides.iter() {
        if k.is_empty() {
            continue;
        }
        args.push("--env".into());
        args.push(format!("{}={}", k, v));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli_json(&refs)
}

#[tauri::command]
fn remove_provider_profile(id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&id, "id")?;
    cli_json(&["providers", "profiles", "remove", &id, "--json"])
}

#[tauri::command]
fn set_default_provider_profile(id: Option<String>) -> Result<serde_json::Value, String> {
    let target = match id.as_deref() {
        None | Some("") => "clear".to_string(),
        Some(s) => {
            validate_id_segment(s, "id")?;
            s.to_string()
        }
    };
    cli_json(&["providers", "default", &target, "--json"])
}

#[tauri::command]
fn set_channel_provider_profile(
    channel_id: String,
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    let target = match profile_id.as_deref() {
        None | Some("") => "clear".to_string(),
        Some(s) => {
            validate_id_segment(s, "profileId")?;
            s.to_string()
        }
    };
    cli_json(&["channel", "set-provider", &channel_id, &target, "--json"])
}

#[tauri::command]
fn get_settings() -> data::GuiSettings {
    data::load_gui_settings()
}

#[tauri::command]
fn update_settings(settings: data::GuiSettings) -> Result<(), String> {
    data::save_gui_settings(&settings)
}

#[tauri::command]
fn set_primary_repo(channel_id: String, workspace_id: String) -> Result<(), String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&workspace_id, "workspaceId")?;
    let mut ch = data::load_channel(&channel_id)
        .ok_or_else(|| format!("channel {} not found", channel_id))?;
    if !ch.repo_assignments.iter().any(|r| r.workspace_id == workspace_id) {
        return Err(format!(
            "workspace {} is not attached to channel {}",
            workspace_id, channel_id
        ));
    }
    ch.primary_workspace_id = Some(workspace_id);
    data::save_channel(&ch)
}

#[tauri::command]
fn post_to_channel(
    channel_id: String,
    content: String,
    from: Option<String>,
    entry_type: Option<String>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    let from = from.unwrap_or_else(|| "GUI".to_string());
    let entry_type = entry_type.unwrap_or_else(|| "message".to_string());
    cli_json(&[
        "channel", "post", &channel_id, &content, "--from", &from, "--type", &entry_type, "--json",
    ])
}

#[tauri::command]
fn create_session(
    channel_id: String,
    title: String,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    cli_json(&[
        "session", "create", "--channel", &channel_id, "--title", &title,
    ])
}

#[tauri::command]
fn delete_session(
    channel_id: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    cli_json(&[
        "session", "delete", "--channel", &channel_id, "--session", &session_id,
    ])
}

/// AL-9 — kill-switch wiring.
///
/// Shells out to `rly session stop <sessionId>`, which atomically drops
/// a `STOP` file into `~/.relay/sessions/<sessionId>/`. The autonomous
/// loop polls that path on each tick (≤20s default) and transitions
/// the lifecycle to `winding_down` with reason `"user-stop-signal"`.
///
/// No force-kill: graceful wind-down respects in-flight workers. AL-10
/// wires the actual "Kill session" button in the session-status header
/// to this command; AL-9 ships just the Tauri surface + CLI plumbing.
#[tauri::command]
fn stop_session(session_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&session_id, "sessionId")?;
    cli_json(&["session", "stop", &session_id])
}

#[tauri::command]
fn append_session_message(
    channel_id: String,
    session_id: String,
    role: String,
    content: String,
    agent_alias: Option<String>,
    metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    if let Some(ref alias) = agent_alias {
        validate_id_segment(alias, "agentAlias")?;
    }
    let metadata_json = metadata
        .as_ref()
        .map(|v| serde_json::to_string(v).map_err(|e| e.to_string()))
        .transpose()?;
    let mut args: Vec<&str> = vec![
        "session", "append", "--channel", &channel_id, "--session", &session_id, "--role", &role,
    ];
    if let Some(ref alias) = agent_alias {
        args.push("--alias");
        args.push(alias);
    }
    if let Some(ref md) = metadata_json {
        args.push("--metadata");
        args.push(md);
    }
    args.push(&content);
    cli_json(&args)
}

#[tauri::command]
fn rewind_snapshot(
    channel_id: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    cli_json(&[
        "chat",
        "rewind-snapshot",
        "--channel",
        &channel_id,
        "--session",
        &session_id,
    ])
}

#[tauri::command]
fn rewind_apply(
    channel_id: String,
    session_id: String,
    key: String,
    message_timestamp: String,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    cli_json(&[
        "chat",
        "rewind-apply",
        "--channel",
        &channel_id,
        "--session",
        &session_id,
        "--key",
        &key,
        "--message-timestamp",
        &message_timestamp,
    ])
}

// --- Chat streaming (claude-cli subprocess + Tauri events) ---

static CHAT_SEQ: AtomicU64 = AtomicU64::new(0);

// Stream ids the caller has asked us to cancel. A spawned `start_chat`
// thread checks this between stdout lines and, if present, exits the loop
// without persisting a partial assistant message. Rewind calls
// `cancel_chat_stream` before truncating the session log to avoid the race
// where the streaming thread appends AFTER truncation.
static CANCELLED_STREAMS: Mutex<Option<HashSet<u64>>> = Mutex::new(None);

fn mark_stream_cancelled(stream_id: u64) {
    let mut guard = CANCELLED_STREAMS.lock().expect("CANCELLED_STREAMS poisoned");
    guard.get_or_insert_with(HashSet::new).insert(stream_id);
}

fn is_stream_cancelled(stream_id: u64) -> bool {
    let guard = CANCELLED_STREAMS.lock().expect("CANCELLED_STREAMS poisoned");
    guard.as_ref().map_or(false, |s| s.contains(&stream_id))
}

fn clear_stream_cancelled(stream_id: u64) {
    let mut guard = CANCELLED_STREAMS.lock().expect("CANCELLED_STREAMS poisoned");
    if let Some(set) = guard.as_mut() {
        set.remove(&stream_id);
    }
}

/// Build the `--metadata` JSON blob attached to a rewind-anchored user
/// message. Isolated as a pure function so a rewind_key containing newlines,
/// quotes, backslashes, or JSON fragments round-trips through serde instead
/// of being spliced into a format string (Gap #1 from the rewind audit).
fn build_rewind_metadata_json(rewind_key: &str) -> String {
    serde_json::json!({ "rewindKey": rewind_key }).to_string()
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ChatEvent {
    Started { stream_id: u64 },
    Chunk { stream_id: u64, text: String },
    Activity { stream_id: u64, text: String },
    SessionId { stream_id: u64, claude_session_id: String },
    Done { stream_id: u64, final_text: String },
    Error { stream_id: u64, message: String },
}

// `describe_tool_use` lives in the shared `harness_data::tool_activity`
// module so the GUI, TUI, and CLI render identical one-liners. See OSS-06.

#[tauri::command]
fn start_chat(
    app: tauri::AppHandle,
    channel_id: String,
    session_id: String,
    message: String,
    alias: Option<String>,
    cwd: Option<String>,
    claude_session_id: Option<String>,
    auto_approve: bool,
    rewind_key: Option<String>,
) -> Result<u64, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&session_id, "sessionId")?;
    if let Some(ref a) = alias {
        validate_id_segment(a, "alias")?;
    }
    let stream_id = CHAT_SEQ.fetch_add(1, Ordering::SeqCst);

    // Persist user message immediately so UI reflects history on reload.
    // `rewind_key`, if supplied, is attached as `rewindKey` metadata so the
    // frontend can later offer a Rewind button that resets repos to the
    // snapshot captured before this turn.
    let alias_arg = alias.clone();
    let metadata_json = rewind_key.as_ref().map(|k| build_rewind_metadata_json(k));
    let mut append_args: Vec<&str> = vec![
        "session", "append", "--channel", &channel_id, "--session", &session_id, "--role", "user",
    ];
    if let Some(ref a) = alias_arg {
        append_args.push("--alias");
        append_args.push(a);
    }
    if let Some(ref md) = metadata_json {
        append_args.push("--metadata");
        append_args.push(md);
    }
    append_args.push(&message);
    let _ = cli_run(&append_args);

    // Resolve MCP config and system prompt up-front (off the streaming thread is fine).
    let mcp_path = {
        let mut args: Vec<&str> = vec!["chat", "mcp-config"];
        let cwd_ref = cwd.clone();
        if let Some(ref dir) = cwd_ref {
            args.push("--repo");
            args.push(dir);
        }
        cli_json(&args)
            .ok()
            .and_then(|v| v.get("path").and_then(|p| p.as_str().map(String::from)))
    };

    let system_prompt = {
        let mut args: Vec<String> = vec![
            "chat".into(),
            "system-prompt".into(),
            "--channel".into(),
            channel_id.clone(),
        ];
        if let Some(ref dir) = cwd {
            args.push("--repo".into());
            args.push(dir.clone());
        }
        if let Some(ref a) = alias {
            args.push("--alias".into());
            args.push(a.clone());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        cli_json(&refs)
            .ok()
            .and_then(|v| v.get("prompt").and_then(|p| p.as_str().map(String::from)))
    };

    let app_handle = app.clone();
    let channel_id_thread = channel_id.clone();
    let session_id_thread = session_id.clone();
    let alias_thread = alias.clone();
    let cwd_thread = cwd.clone();
    let claude_sid_thread = claude_session_id.clone();

    std::thread::spawn(move || {
        let _ = app_handle.emit("chat-event", ChatEvent::Started { stream_id });

        let claude_bin = std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ];
        if auto_approve {
            args.push("--dangerously-skip-permissions".into());
        }
        if let Some(p) = &mcp_path {
            args.push("--mcp-config".into());
            args.push(p.clone());
        }
        if let Some(p) = &system_prompt {
            args.push("--append-system-prompt".into());
            args.push(p.clone());
        }
        if let Some(sid) = &claude_sid_thread {
            args.push("--resume".into());
            args.push(sid.clone());
        }
        args.push(message);

        let mut cmd = Command::new(&claude_bin);
        cmd.args(&args)
            .env("PATH", augmented_child_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(ref dir) = cwd_thread {
            cmd.current_dir(dir);
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit(
                    "chat-event",
                    ChatEvent::Error {
                        stream_id,
                        message: format!(
                            "Failed to launch claude: {}. Set CLAUDE_BIN if claude is not on PATH.",
                            e
                        ),
                    },
                );
                return;
            }
        };

        let mut child = child;
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = app_handle.emit(
                    "chat-event",
                    ChatEvent::Error {
                        stream_id,
                        message: "claude produced no stdout".into(),
                    },
                );
                return;
            }
        };

        let reader = BufReader::new(stdout);
        let mut accum = String::new();
        let mut final_session_id: Option<String> = None;
        let mut cancelled = false;

        for line in reader.lines() {
            // Rewind (and anything else that wants to abort a live stream)
            // sets the cancellation flag via `cancel_chat_stream`. Check on
            // every iteration so we stop appending to `accum` promptly; the
            // child process is killed below to unblock the read loop.
            if is_stream_cancelled(stream_id) {
                cancelled = true;
                let _ = child.kill();
                break;
            }
            let line = match line {
                Ok(l) if l.is_empty() => continue,
                Ok(l) => l,
                Err(_) => break,
            };
            let json: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match json.get("type").and_then(|t| t.as_str()) {
                Some("assistant") => {
                    if let Some(blocks) = json
                        .pointer("/message/content")
                        .and_then(|c| c.as_array())
                    {
                        for block in blocks {
                            match block.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(text) = block.get("text").and_then(|v| v.as_str())
                                    {
                                        if !text.is_empty() {
                                            accum.push_str(text);
                                            let _ = app_handle.emit(
                                                "chat-event",
                                                ChatEvent::Chunk {
                                                    stream_id,
                                                    text: text.to_string(),
                                                },
                                            );
                                        }
                                    }
                                }
                                Some("tool_use") => {
                                    let name = block
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool");
                                    let null = serde_json::Value::Null;
                                    let input = block.get("input").unwrap_or(&null);
                                    let _ = app_handle.emit(
                                        "chat-event",
                                        ChatEvent::Activity {
                                            stream_id,
                                            text: data::tool_activity::describe_tool_use(
                                                name, input,
                                            ),
                                        },
                                    );
                                }
                                Some("thinking") => {
                                    // Claude extended-thinking content blocks —
                                    // surface a trimmed preview as activity so
                                    // the UI shows something other than "…"
                                    // while the model is reasoning.
                                    if let Some(text) = block
                                        .get("thinking")
                                        .and_then(|v| v.as_str())
                                    {
                                        let preview = text
                                            .split_whitespace()
                                            .take(16)
                                            .collect::<Vec<_>>()
                                            .join(" ");
                                        if !preview.is_empty() {
                                            let _ = app_handle.emit(
                                                "chat-event",
                                                ChatEvent::Activity {
                                                    stream_id,
                                                    text: format!("thinking: {}…", preview),
                                                },
                                            );
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        final_session_id = Some(sid.to_string());
                    }
                }
                Some("result") => {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        final_session_id = Some(sid.to_string());
                    }
                    if accum.is_empty() {
                        if let Some(text) = json.get("result").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                accum.push_str(text);
                                let _ = app_handle.emit(
                                    "chat-event",
                                    ChatEvent::Chunk {
                                        stream_id,
                                        text: text.to_string(),
                                    },
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let _ = child.wait();

        // If rewind (or anything else) cancelled this stream, DO NOT
        // persist a partial assistant message or update the claude session
        // id — that's exactly the race Gap #8 fixes. Clear the flag so the
        // next stream that happens to reuse this id (extremely unlikely
        // given the monotonic AtomicU64, but cheap insurance) starts clean.
        if cancelled {
            clear_stream_cancelled(stream_id);
            let _ = app_handle.emit(
                "chat-event",
                ChatEvent::Done {
                    stream_id,
                    final_text: String::new(),
                },
            );
            return;
        }

        // Persist the assistant message.
        if !accum.is_empty() {
            let mut append_args: Vec<&str> = vec![
                "session",
                "append",
                "--channel",
                &channel_id_thread,
                "--session",
                &session_id_thread,
                "--role",
                "assistant",
            ];
            if let Some(ref a) = alias_thread {
                append_args.push("--alias");
                append_args.push(a);
            }
            append_args.push(&accum);
            let _ = cli_run(&append_args);
        }

        // Store the new claude session id so subsequent turns can --resume.
        if let Some(ref sid) = final_session_id {
            let alias_for_sid = alias_thread.as_deref().unwrap_or("general");
            let _ = cli_run(&[
                "session",
                "update-claude-sid",
                "--channel",
                &channel_id_thread,
                "--session",
                &session_id_thread,
                "--alias",
                alias_for_sid,
                "--sid",
                sid,
            ]);
            let _ = app_handle.emit(
                "chat-event",
                ChatEvent::SessionId {
                    stream_id,
                    claude_session_id: sid.clone(),
                },
            );
        }

        let _ = app_handle.emit(
            "chat-event",
            ChatEvent::Done {
                stream_id,
                final_text: accum,
            },
        );
    });

    Ok(stream_id)
}

/// Signal a running `start_chat` thread to exit without persisting the
/// assistant message. The rewind button calls this BEFORE truncating the
/// session log so the stream can't race the truncation and re-append a
/// stale assistant turn (Gap #8). Safe to call with an unknown stream id
/// — it's a set insert; live threads check the flag on the next line read.
#[tauri::command]
fn cancel_chat_stream(stream_id: u64) -> Result<(), String> {
    mark_stream_cancelled(stream_id);
    Ok(())
}

// --- Terminal spawn/kill lifecycle ---
//
// Each channel tracks an associated-repo agent spawn in
// `~/.relay/channels/<channelId>/spawns.json`.
//
// Per platform:
//   - macOS: `osascript` opens a Terminal.app tab running `rly claude` in the
//     repo; we capture window/tab ids from the AppleScript return so we can
//     close them again later.
//   - Linux: probe a terminal-emulator chain (`$TERMINAL`, then
//     x-terminal-emulator, gnome-terminal, konsole, xterm, alacritty, kitty,
//     wezterm) and spawn `<term> -e bash -lc "cd <repo>; exec $SHELL"`. We
//     don't track window/tab ids — there's no portable equivalent. Kill
//     falls back to SIGTERM on the matching crosslink session.
//   - Windows: prefer `wt.exe` (Windows Terminal), else `powershell.exe`,
//     else `cmd.exe`. Spawn with `cd /d <repo>` and leave a live shell. Same
//     SIGTERM-on-repo fallback as Linux.
//
// If no supported terminal is detected on Linux/Windows, we return a
// descriptive error AND post a channel-feed entry so the user sees the
// guidance ("run `rly claude` in the repo manually") in the feed too.
//
// We hardcode STALE_HEARTBEAT_MS here (matching the crosslink store) instead
// of depending on the TS/crosslink side, so self-heal stays self-contained.
const STALE_HEARTBEAT_MS: u64 = 120_000;

/// Terminal emulator probe order for Linux. `$TERMINAL` is honored first.
#[cfg(any(target_os = "linux", test))]
const LINUX_TERMINAL_CHAIN: &[&str] = &[
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xterm",
    "alacritty",
    "kitty",
    "wezterm",
];

/// Windows terminal probe order.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_TERMINAL_CHAIN: &[&str] = &["wt.exe", "powershell.exe", "cmd.exe"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    pub alias: String,
    pub repo_path: String,
    pub spawned_at: String,
    pub terminal_window_id: Option<u32>,
    pub terminal_tab_id: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SpawnsFile {
    #[serde(default = "default_spawns_version")]
    version: u32,
    #[serde(default)]
    spawns: BTreeMap<String, Spawn>,
}

fn default_spawns_version() -> u32 {
    1
}

fn spawns_path(channel_id: &str) -> PathBuf {
    data::harness_root()
        .join("channels")
        .join(channel_id)
        .join("spawns.json")
}

fn load_spawns_file(channel_id: &str) -> SpawnsFile {
    let path = spawns_path(channel_id);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<SpawnsFile>(&raw).unwrap_or_else(|_| SpawnsFile {
            version: 1,
            spawns: BTreeMap::new(),
        }),
        Err(_) => SpawnsFile {
            version: 1,
            spawns: BTreeMap::new(),
        },
    }
}

fn save_spawns_file(channel_id: &str, file: &SpawnsFile) -> Result<(), String> {
    let path = spawns_path(channel_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create spawns dir: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(file)
        .map_err(|e| format!("serialize spawns.json: {}", e))?;
    fs::write(&tmp, content).map_err(|e| format!("write spawns.json tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename spawns.json: {}", e))
}

/// Run `osascript -e <script>` and return trimmed stdout, or an error string.
fn run_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("osascript failed to launch: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "osascript error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Parse the result of `do script` — Terminal returns a reference like
/// `tab 1 of window id 12345` (the exact wording varies by macOS version
/// but always includes "window id <N>" and a "tab <N>" index, both as
/// integers). Returns (window_id, tab_id). Returns None on parse miss so
/// callers can fall back to a best-effort windowId.
fn parse_terminal_tab_ref(raw: &str) -> (Option<u32>, Option<u32>) {
    let window_id = extract_int_after(raw, "window id ");
    // Terminal's textual form is usually "tab <N> of window id <M>".
    // Pull the first number after the literal word "tab " for the tab index.
    let tab_id = extract_int_after(raw, "tab ");
    (window_id, tab_id)
}

fn extract_int_after(haystack: &str, needle: &str) -> Option<u32> {
    let idx = haystack.find(needle)?;
    let rest = &haystack[idx + needle.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u32>().ok()
    }
}

/// Best-effort query of Terminal's frontmost window id. Returns None if
/// Terminal isn't running or AppleScript fails.
fn frontmost_terminal_window_id() -> Option<u32> {
    let script = r#"tell application "Terminal" to id of front window"#;
    run_osascript(script).ok().and_then(|s| s.parse::<u32>().ok())
}

/// AppleScript single-quote escaping: wrap in single quotes, any inner `'`
/// becomes `'\''`. Used for shell path interpolation inside the `do script`
/// command we hand to Terminal.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// AppleScript string literal escaping: wrap in double quotes, escape inner
/// backslashes and double quotes.
fn applescript_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// Windows cmd.exe quoting for a single argument embedded in a shell
/// command string. Wraps in double quotes and escapes inner double quotes
/// and backslashes per CommandLineToArgv rules — good enough for path
/// interpolation into `cd /d <path>`. Backslashes before a quote are
/// doubled; standalone backslashes are preserved verbatim.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn windows_quote_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let mut pending_bs: usize = 0;
    for c in s.chars() {
        match c {
            '\\' => {
                pending_bs += 1;
            }
            '"' => {
                // Double all pending backslashes, then escape the quote.
                for _ in 0..(pending_bs * 2) {
                    out.push('\\');
                }
                pending_bs = 0;
                out.push('\\');
                out.push('"');
            }
            _ => {
                for _ in 0..pending_bs {
                    out.push('\\');
                }
                pending_bs = 0;
                out.push(c);
            }
        }
    }
    // Trailing backslashes before the closing quote must be doubled.
    for _ in 0..(pending_bs * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Find `name` on PATH. Calls `which` on POSIX and `where` on Windows. Stub
/// returns `Some(path)` if found, `None` otherwise. This is separated from
/// the caller so tests can substitute a fake probe.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
#[cfg_attr(test, allow(dead_code))]
fn which_on_path(name: &str) -> Option<String> {
    let probe = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let output = Command::new(probe)
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let first = line.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// Detect the first available entry in `chain` by probing via `probe`.
/// `$TERMINAL` (when non-empty) takes precedence on Linux, and is injected
/// by the caller as the first element of `chain` if appropriate. Returns
/// the detected name (not the full path) so the caller can pass it to
/// `Command::new`.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn detect_terminal<F>(chain: &[&str], mut probe: F) -> Option<String>
where
    F: FnMut(&str) -> bool,
{
    for name in chain {
        if probe(name) {
            return Some((*name).to_string());
        }
    }
    None
}

/// Post a channel-feed entry announcing that spawn fell back to the manual
/// path (no supported terminal found). Best-effort; ignores CLI errors.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn post_spawn_fallback_entry(channel_id: &str, repo_path: &str, reason: &str) {
    let content = format!(
        "Agent spawn fell back to manual launch for {}. {} Run `rly claude` in the repo manually; crosslink will pick it up.",
        repo_path, reason,
    );
    let _ = cli_run(&[
        "channel", "post", channel_id, &content, "--from", "GUI", "--type", "system",
    ]);
}

#[cfg(target_os = "macos")]
fn spawn_agent_macos(repo_path: &str) -> Result<(Option<u32>, Option<u32>), String> {
    // Build the shell command the Terminal tab should run. We single-quote
    // the path to survive spaces and most shell metacharacters, then wrap
    // the whole shell command as an AppleScript string literal.
    let shell_cmd = format!("cd {} && rly claude", shell_single_quote(repo_path));
    let script = format!(
        r#"tell application "Terminal" to do script {}"#,
        applescript_string(&shell_cmd)
    );

    let raw = run_osascript(&script)
        .map_err(|e| format!("failed to open Terminal tab: {}", e))?;

    let (mut window_id, mut tab_id) = parse_terminal_tab_ref(&raw);

    // Fallback: if we couldn't parse window id from the `do script` return,
    // grab the frontmost Terminal window id. Tab index falls back to 0.
    if window_id.is_none() {
        window_id = frontmost_terminal_window_id();
        if tab_id.is_none() {
            tab_id = Some(0);
        }
    }
    Ok((window_id, tab_id))
}

/// Linux branch: honor `$TERMINAL`, then probe the chain. On success, spawn
/// the detected emulator with arguments that run `rly claude` in the repo
/// and leave a live shell. Fire-and-forget — we don't capture window ids
/// because there's no portable way to get them.
#[cfg(target_os = "linux")]
fn spawn_agent_linux(channel_id: &str, repo_path: &str) -> Result<(), String> {
    // `$TERMINAL` takes precedence if set and non-empty.
    let env_term = std::env::var("TERMINAL").ok().filter(|s| !s.is_empty());
    let mut chain: Vec<&str> = Vec::with_capacity(LINUX_TERMINAL_CHAIN.len() + 1);
    if let Some(ref t) = env_term {
        chain.push(t.as_str());
    }
    chain.extend_from_slice(LINUX_TERMINAL_CHAIN);

    let chosen = detect_terminal(&chain, |n| which_on_path(n).is_some());
    let Some(term) = chosen else {
        let reason = "No supported terminal emulator detected on PATH.";
        post_spawn_fallback_entry(channel_id, repo_path, reason);
        return Err(format!(
            "{} Tried: $TERMINAL, {}. Set $TERMINAL or install one of the supported emulators.",
            reason,
            LINUX_TERMINAL_CHAIN.join(", "),
        ));
    };

    // Build the shell command per-argument — `Command::args` handles
    // individual-argument escaping, so the path never needs shell quoting.
    // We only need to single-quote inside the `bash -lc` string because
    // that's a single composite argument interpreted by bash.
    let bash_script = format!(
        "cd {} && exec rly claude",
        shell_single_quote(repo_path),
    );

    // Most emulators accept `-e <cmd...>`. gnome-terminal deprecated `-e`
    // in favor of `--` but still accepts it. We pass `bash -lc <script>`
    // so the path-quoting lives inside bash where we control it.
    Command::new(&term)
        .arg("-e")
        .arg("bash")
        .arg("-lc")
        .arg(&bash_script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch {}: {}", term, e))?;
    Ok(())
}

/// Windows branch: prefer Windows Terminal, then powershell, then cmd.
/// Spawn with `cd /d <path>` and leave a live shell.
#[cfg(target_os = "windows")]
fn spawn_agent_windows(channel_id: &str, repo_path: &str) -> Result<(), String> {
    let chosen = detect_terminal(WINDOWS_TERMINAL_CHAIN, |n| which_on_path(n).is_some());
    let Some(term) = chosen else {
        let reason = "No supported terminal (wt.exe, powershell.exe, cmd.exe) detected on PATH.";
        post_spawn_fallback_entry(channel_id, repo_path, reason);
        return Err(format!("{} Run `rly claude` in the repo manually.", reason));
    };

    // Each terminal expects the child-command shape differently. We build
    // per-argument to avoid handing cmd.exe a shell-interpolated string.
    let quoted = windows_quote_path(repo_path);
    let shell_line = format!("cd /d {} && rly claude", quoted);

    let mut cmd = Command::new(&term);
    match term.as_str() {
        "wt.exe" => {
            // wt -d <dir> powershell/cmd keeps the shell live in <dir>.
            cmd.arg("-d").arg(repo_path).arg("cmd.exe").arg("/k").arg("rly claude");
        }
        "powershell.exe" => {
            // -NoExit keeps the shell alive after the command completes.
            cmd.arg("-NoExit")
                .arg("-Command")
                .arg(format!("Set-Location -LiteralPath {}; rly claude", quoted));
        }
        _ => {
            // cmd.exe /k <line>
            cmd.arg("/k").arg(&shell_line);
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch {}: {}", term, e))?;
    Ok(())
}

#[tauri::command]
fn spawn_agent(
    channel_id: String,
    alias: String,
    repo_path: String,
) -> Result<Spawn, String> {
    // IPC hardening (OSS-02): reject anything that could traverse the
    // spawns-file path or smuggle shell metachars through alias.
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&alias, "alias")?;

    // Platform dispatch. Each branch populates terminal window/tab ids
    // where it can (macOS only today); Linux/Windows leave them None and
    // rely on the repo-path-based SIGTERM fallback in kill_spawned_agent.
    #[cfg(target_os = "macos")]
    let (window_id, tab_id) = spawn_agent_macos(&repo_path)?;

    #[cfg(target_os = "linux")]
    let (window_id, tab_id): (Option<u32>, Option<u32>) = {
        spawn_agent_linux(&channel_id, &repo_path)?;
        (None, None)
    };

    #[cfg(target_os = "windows")]
    let (window_id, tab_id): (Option<u32>, Option<u32>) = {
        spawn_agent_windows(&channel_id, &repo_path)?;
        (None, None)
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let (window_id, tab_id): (Option<u32>, Option<u32>) = {
        let _ = &channel_id;
        let _ = &repo_path;
        return Err(
            "spawn is not supported on this platform — run `rly claude` in the repo manually"
                .into(),
        );
    };

    let spawn = Spawn {
        alias: alias.clone(),
        repo_path,
        spawned_at: chrono::Utc::now().to_rfc3339(),
        terminal_window_id: window_id,
        terminal_tab_id: tab_id,
    };

    // Idempotent on alias: overwrite any existing entry.
    let mut file = load_spawns_file(&channel_id);
    file.version = 1;
    file.spawns.insert(alias, spawn.clone());
    save_spawns_file(&channel_id, &file)?;

    Ok(spawn)
}

/// Best-effort SIGTERM to a crosslink session whose repoPath matches.
/// Reads `~/.relay/crosslink/sessions/*.json` and kills the first match.
/// Any failure is swallowed; this is a fallback when osascript can't find
/// the tab.
fn try_sigterm_matching_session(repo_path: &str) {
    let sessions_dir = data::harness_root().join("crosslink").join("sessions");
    let Ok(entries) = fs::read_dir(&sessions_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let session_repo = session.get("repoPath").and_then(|v| v.as_str()).unwrap_or("");
        if session_repo != repo_path {
            continue;
        }
        let Some(pid) = session.get("pid").and_then(|v| v.as_u64()) else {
            continue;
        };
        // Shell out to the platform's kill primitive — avoids pulling in
        // libc/nix just for a signal. On Windows we use `taskkill` with
        // `/T` so the whole shell+child tree comes down with the
        // spawned terminal.
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/T")
                .arg("/F")
                .status();
        }
        break;
    }
}

#[tauri::command]
fn kill_spawned_agent(channel_id: String, alias: String) -> Result<(), String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&alias, "alias")?;
    let mut file = load_spawns_file(&channel_id);
    let Some(entry) = file.spawns.remove(&alias) else {
        // Already gone — treat as success.
        return Ok(());
    };

    if std::env::consts::OS == "macos" {
        if let Some(wid) = entry.terminal_window_id {
            // Targeted: close the exact tab in the tracked window, if we
            // have a tab index. Fall back to closing the whole window if
            // the tab lookup fails.
            let close_script = if let Some(tid) = entry.terminal_tab_id {
                format!(
                    r#"tell application "Terminal"
                        try
                            close tab {tid} of window id {wid} saving no
                        on error
                            try
                                close window id {wid} saving no
                            end try
                        end try
                    end tell"#,
                    tid = tid,
                    wid = wid,
                )
            } else {
                format!(
                    r#"tell application "Terminal"
                        try
                            close window id {wid} saving no
                        end try
                    end tell"#,
                    wid = wid,
                )
            };
            let _ = run_osascript(&close_script);
        }
    }

    // Best-effort SIGTERM to the crosslink session for this repo.
    try_sigterm_matching_session(&entry.repo_path);

    // Always rewrite spawns.json without this alias, even if osascript
    // failed — the user may have closed the tab by hand.
    file.version = 1;
    save_spawns_file(&channel_id, &file)?;
    Ok(())
}

#[tauri::command]
fn list_spawns(channel_id: String) -> Result<Vec<Spawn>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    let mut file = load_spawns_file(&channel_id);

    // Build a lookup of live crosslink sessions keyed by repoPath. A session
    // is "live" if its lastHeartbeat is newer than STALE_HEARTBEAT_MS.
    let live_repos = load_live_crosslink_repos();

    let mut survivors: Vec<Spawn> = Vec::new();
    let mut drop_aliases: Vec<String> = Vec::new();

    for (alias, spawn) in &file.spawns {
        if live_repos.contains(&spawn.repo_path) {
            survivors.push(spawn.clone());
        } else {
            drop_aliases.push(alias.clone());
        }
    }

    if !drop_aliases.is_empty() {
        for alias in &drop_aliases {
            file.spawns.remove(alias);
        }
        file.version = 1;
        save_spawns_file(&channel_id, &file)?;
    }

    Ok(survivors)
}

fn load_live_crosslink_repos() -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let sessions_dir = data::harness_root().join("crosslink").join("sessions");
    let Ok(entries) = fs::read_dir(&sessions_dir) else {
        return out;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(repo) = session.get("repoPath").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(hb) = session.get("lastHeartbeat").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(hb) else {
            continue;
        };
        let hb_ms = parsed.timestamp_millis();
        if (now_ms - hb_ms) <= STALE_HEARTBEAT_MS as i64 {
            out.insert(repo.to_string());
        }
    }
    out
}

// -----------------------------------------------------------------------------
// AL-10: Autonomous session readers + kill switch
// -----------------------------------------------------------------------------
//
// The autonomous driver (AL-3/AL-4) writes three files per session under
// `~/.relay/sessions/<sessionId>/`:
//
//   - `metadata.json`   — one-shot record of the flags + channelId the session
//                         was spawned with. Written once at startup.
//   - `lifecycle.json`  — state-machine snapshot, rewritten atomically on
//                         every transition (planning → dispatching → ...).
//   - `budget.jsonl`    — append-only JSONL of per-API-call token increments.
//                         Each line includes a cumulative total.
//   - `approvals.jsonl` — append-only approval queue (AL-8). Stubbed here;
//                         we read it opportunistically — missing file == empty.
//   - `STOP`            — sentinel file. AL-9's `stop_session` drops it; the
//                         driver watches for it and shuts down cleanly.
//
// These readers tolerate partial / missing / corrupted files — a GUI that
// polls every 5s cannot afford to throw on a torn write mid-rename.
// Everything is best-effort and returns `None` / empty defaults when the
// on-disk state isn't parseable.

/// Lightweight header row for the session list — just enough to let the
/// CenterPane find the active session for the selected channel without
/// loading lifecycle/budget for every candidate.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutonomousSessionSummary {
    session_id: String,
    channel_id: String,
    state: String,
    started_at: String,
    trust: String,
}

/// Full session snapshot returned by `get_session_state`. Field names mirror
/// the metadata/lifecycle/budget on-disk shapes one-to-one so the frontend
/// can surface them without an adapter layer.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutonomousSessionState {
    session_id: String,
    channel_id: String,
    state: String,
    trust: String,
    budget_tokens: u64,
    budget_used: u64,
    budget_pct: f64,
    max_hours: f64,
    started_at: String,
    /// ISO timestamp of the most recent lifecycle transition. Useful for the
    /// header's "state changed Xm ago" line if we ever want to surface it.
    updated_at: String,
    /// Hours of wall-clock budget remaining. Clamped to 0 when the session
    /// has exceeded `max_hours` (the lifecycle watchdog will have killed it
    /// by then anyway; the UI just needs a non-negative number).
    hours_remaining: f64,
    /// Best-effort current-ticket id. Derived from the most recent ticket
    /// the repo-admin coordinator is working on. When AL-16's coordinator
    /// state hasn't surfaced a ticket yet, this is `None`.
    current_ticket_id: Option<String>,
    allowed_repos: Vec<String>,
}

#[derive(Deserialize)]
// `sessionId` / `startedAt` / `maxDurationMs` are carried so serde validates
// the file shape (reject a lifecycle.json that's a totally different
// struct), but only `state` + `transitions` are read at the moment. The
// allow silences dead_code warnings that would otherwise fire on the
// defensive fields.
#[allow(dead_code)]
struct LifecycleFileRaw {
    #[serde(rename = "sessionId")]
    session_id: String,
    state: String,
    #[serde(rename = "startedAt")]
    started_at: String,
    #[serde(rename = "maxDurationMs", default)]
    max_duration_ms: u64,
    #[serde(default)]
    transitions: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct MetadataFileRaw {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "channelId")]
    channel_id: String,
    #[serde(rename = "budgetTokens")]
    budget_tokens: u64,
    #[serde(rename = "maxHours")]
    max_hours: f64,
    #[serde(default)]
    trust: String,
    #[serde(rename = "allowedRepos", default)]
    allowed_repos: Vec<String>,
    #[serde(rename = "startedAt")]
    started_at: String,
}

/// Directory that holds all autonomous session subdirs. We accept the
/// `RELAY_HARNESS_ROOT` override that `harness-data` already honors so the
/// tauri backend lines up with the CLI's world view in tests and remote
/// workspace setups.
fn autonomous_sessions_root() -> PathBuf {
    data::harness_root().join("sessions")
}

/// Best-effort read of `metadata.json`. Returns `None` when the file is
/// missing, unreadable, or fails to parse — autonomous sessions spawned by
/// old builds or torn writes mid-rename land here and we skip them silently.
fn read_session_metadata(session_id: &str) -> Option<MetadataFileRaw> {
    let path = autonomous_sessions_root().join(session_id).join("metadata.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_session_lifecycle(session_id: &str) -> Option<LifecycleFileRaw> {
    let path = autonomous_sessions_root().join(session_id).join("lifecycle.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Sum the cumulative token usage from `budget.jsonl`. The last line's
/// `cumulativeUsed` is authoritative — the tracker maintains it invariant
/// under concurrent records. Fall back to summing increments so a
/// hand-edited file still produces a sane total.
fn read_session_budget_used(session_id: &str) -> u64 {
    // I4: budget.jsonl is written by the TokenTracker (AL-1), which ALWAYS
    // stamps `cumulativeUsed` on every line. The previous implementation
    // had a "sum input+output if cumulativeUsed is missing" fallback that
    // double-counted when the two shapes interleaved — an older partial
    // file combined with newer canonical lines gave a value higher than
    // the true cumulative. Dropping the fallback: if a line lacks
    // `cumulativeUsed` it's either legacy noise or a malformed record,
    // neither of which should bump the total. The last well-formed
    // cumulative wins; an entirely empty file returns 0.
    let path = autonomous_sessions_root().join(session_id).join("budget.jsonl");
    let Ok(file) = fs::File::open(&path) else {
        return 0;
    };
    let mut last_cumulative: u64 = 0;
    for line in BufReader::new(file).lines().flatten() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(c) = value.get("cumulativeUsed").and_then(|v| v.as_u64()) {
            last_cumulative = c;
        }
    }
    last_cumulative
}

/// Walks `~/.relay/sessions/` and returns a summary for every session whose
/// metadata.json is readable. Intended for the CenterPane's channel →
/// session lookup — one call, O(sessions) disk reads.
#[tauri::command]
fn list_autonomous_sessions() -> Vec<AutonomousSessionSummary> {
    let root = autonomous_sessions_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Skip hidden + malformed directory names. The harness-data guard is
        // path-based so a rogue `..` directory can't materialize, but we
        // still defend against it for clarity.
        if validate_id_segment(name, "sessionId").is_err() {
            continue;
        }
        let Some(meta) = read_session_metadata(name) else {
            continue;
        };
        let state = read_session_lifecycle(name)
            .map(|lc| lc.state)
            .unwrap_or_else(|| "planning".to_string());
        out.push(AutonomousSessionSummary {
            session_id: meta.session_id,
            channel_id: meta.channel_id,
            state,
            started_at: meta.started_at,
            trust: meta.trust,
        });
    }
    // Most-recent first. The startedAt string is ISO-8601 so lexicographic
    // ordering matches chronological ordering.
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

/// Deep state for one session — metadata + lifecycle + budget summary fused
/// into the shape the AutonomousSessionHeader renders directly.
#[tauri::command]
fn get_session_state(session_id: String) -> Result<Option<AutonomousSessionState>, String> {
    validate_id_segment(&session_id, "sessionId")?;
    let Some(meta) = read_session_metadata(&session_id) else {
        return Ok(None);
    };
    let lifecycle = read_session_lifecycle(&session_id);
    let state = lifecycle.as_ref().map(|lc| lc.state.clone()).unwrap_or_else(|| "planning".into());
    let updated_at = lifecycle
        .as_ref()
        .and_then(|lc| {
            lc.transitions
                .last()
                .and_then(|t| t.get("at").and_then(|v| v.as_str()).map(String::from))
        })
        .unwrap_or_else(|| meta.started_at.clone());

    let budget_used = read_session_budget_used(&session_id);
    let budget_pct = if meta.budget_tokens == 0 {
        0.0
    } else {
        (budget_used as f64 / meta.budget_tokens as f64) * 100.0
    };

    let hours_remaining = {
        let started_ms = chrono::DateTime::parse_from_rfc3339(&meta.started_at)
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let elapsed_ms = (now_ms - started_ms).max(0) as f64;
        let total_ms = meta.max_hours * 3600.0 * 1000.0;
        let remaining_ms = (total_ms - elapsed_ms).max(0.0);
        remaining_ms / (3600.0 * 1000.0)
    };

    // Current ticket is best-effort — the coordinator hasn't converged on a
    // single canonical place to write it as of AL-16. When AL-17 lands a
    // dedicated `current.json` we'll read it here; until then we return None
    // and the header gracefully omits the row.
    let current_ticket_id = read_current_ticket_id(&session_id);

    Ok(Some(AutonomousSessionState {
        session_id: meta.session_id,
        channel_id: meta.channel_id,
        state,
        trust: meta.trust,
        budget_tokens: meta.budget_tokens,
        budget_used,
        budget_pct,
        max_hours: meta.max_hours,
        started_at: meta.started_at,
        updated_at,
        hours_remaining,
        current_ticket_id,
        allowed_repos: meta.allowed_repos,
    }))
}

/// Optional `current.json` reader. The autonomous loop may write a pointer
/// to the ticket a worker is currently processing; the shape is
/// `{"ticketId": "<id>"}`. Returns `None` when the file is missing or
/// malformed — the header just hides the row in that case.
fn read_current_ticket_id(session_id: &str) -> Option<String> {
    let path = autonomous_sessions_root().join(session_id).join("current.json");
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("ticketId")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Drops the `STOP` sentinel file into the session directory. Stub for
/// AL-9 — when AL-9 merges, its implementation will supersede this one (or
// AL-10 B1: `stop_session` is owned by AL-9 (see the definition earlier in
// this file — search for `fn stop_session`). The AL-10 duplicate was
// dropped during the AL-9/AL-10 inter-PR merge so there is only one
// canonical STOP-file writer.
//
// AL-10 B2/B3: `list_session_approvals` / `resolve_session_approval` +
// the `SessionApproval` struct were also dropped here. AL-8 now owns the
// GUI approvals surface via `list_pending_approvals` / `approve_queue_entry`
// / `reject_queue_entry` / `approve_queue_all` — delegating to AL-7's
// canonical `ApprovalsQueue` writer. AL-10 keeps only the session-status
// header (`list_autonomous_sessions`, `get_session_state`).

// -----------------------------------------------------------------------------
// Unit tests
// -----------------------------------------------------------------------------
//
// Covers:
//   * OSS-02 IPC hardening — `validate_id_segment` + `check_run_cli_allowed`.
//   * OSS-01 rewind hardening — `build_rewind_metadata_json` + cancel flag.
//   * OSS-10 cross-platform spawn — `shell_single_quote`, `windows_quote_path`,
//     `parse_terminal_tab_ref`, and `detect_terminal` via an injected probe.
//
// Detection tests simulate a fake `which` so we never actually probe the test
// host's PATH — precedence assertions stay stable regardless of which
// terminals the dev has installed. We never actually spawn a terminal.

#[cfg(test)]
mod tests {
    use super::*;

    // --- validate_id_segment ---

    #[test]
    fn validate_id_segment_accepts_alphanumeric_and_dash_underscore_dot() {
        for ok in [
            "abc",
            "ABC123",
            "channel-1776812897693-lmps9a",
            "session_42",
            "a.b.c",
            "X-1_2.3",
        ] {
            assert!(
                validate_id_segment(ok, "id").is_ok(),
                "expected {:?} to be accepted",
                ok
            );
        }
    }

    #[test]
    fn validate_id_segment_rejects_empty_and_dot_segments() {
        for bad in ["", ".", ".."] {
            assert!(
                validate_id_segment(bad, "id").is_err(),
                "expected {:?} to be rejected",
                bad
            );
        }
    }

    #[test]
    fn validate_id_segment_rejects_path_separators_and_nulls() {
        for bad in [
            "../etc/passwd",
            "foo/bar",
            "foo\\bar",
            "foo\0bar",
            "../",
            "a/b",
        ] {
            assert!(
                validate_id_segment(bad, "id").is_err(),
                "expected {:?} to be rejected",
                bad
            );
        }
    }

    #[test]
    fn validate_id_segment_rejects_whitespace_and_shell_metachars() {
        for bad in ["a b", "a;b", "a|b", "a&b", "a`b`", "a$b", "a\nb"] {
            assert!(
                validate_id_segment(bad, "id").is_err(),
                "expected {:?} to be rejected",
                bad
            );
        }
    }

    // --- find_on_path ---

    #[test]
    fn find_on_path_discovers_executable_in_path_dirs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin_path = dir.path().join("fake-rly-probe");
        std::fs::write(&bin_path, b"#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }

        // Prepend the tempdir to PATH and look for the fake binary.
        let original_path = std::env::var_os("PATH");
        let mut parts = vec![dir.path().to_path_buf()];
        if let Some(ref p) = original_path {
            parts.extend(std::env::split_paths(p));
        }
        let joined = std::env::join_paths(parts).expect("join_paths");
        // NOTE: Rust tests default to parallel execution, so process-wide
        // env mutation here is theoretically racy with any other test that
        // reads PATH. Matches the existing pattern in this file (see the
        // RELAY_HARNESS_ROOT-touching test). Keep the scope narrow and
        // restore before assert; if a second PATH-mutating test is added,
        // serialize them with `serial_test` (not yet a dep).
        // The `unsafe` is required by Rust 2024 edition for env mutation,
        // not a memory-safety claim.
        unsafe { std::env::set_var("PATH", &joined) };

        let found = find_on_path("fake-rly-probe");

        // Restore before asserting so a failed assert doesn't leak PATH.
        match original_path {
            Some(v) => unsafe { std::env::set_var("PATH", v) },
            None => unsafe { std::env::remove_var("PATH") },
        }

        assert_eq!(found.as_deref(), Some(bin_path.to_str().unwrap()));
    }

    #[test]
    fn find_on_path_returns_none_when_absent() {
        assert!(find_on_path("definitely-not-a-real-binary-xyz-7412").is_none());
    }

    // --- compute_augmented_path ---

    #[test]
    fn compute_augmented_path_prepends_nvm_ahead_of_local_prefixes() {
        // Fake HOME containing two nvm node versions; the newest must
        // appear ahead of /usr/local/bin in the resulting PATH so the
        // shim's `exec node` doesn't pick up a stale system node.
        let home_dir = tempfile::tempdir().expect("tempdir");
        let home = home_dir.path().as_os_str().to_owned();
        for v in ["v18.0.0", "v22.14.0"] {
            let bin = home_dir.path().join(".nvm/versions/node").join(v).join("bin");
            std::fs::create_dir_all(&bin).expect("mkdir nvm");
        }
        // /usr/local/bin must exist on the host for the ordering assertion
        // to fire — if missing, the test passes vacuously. That's fine: the
        // comparison we care about (nvm before /usr/local/bin) is only
        // meaningful when both are present, and the newest-vs-older-nvm
        // assertion still covers the sort-order invariant unconditionally.
        let parent = std::ffi::OsString::from("/usr/bin:/bin");
        let result = compute_augmented_path(&parent, &home);

        let segments: Vec<&str> = result.split(':').collect();
        let home_str = home.to_str().unwrap();
        let newest_nvm = format!("{home_str}/.nvm/versions/node/v22.14.0/bin");
        let older_nvm = format!("{home_str}/.nvm/versions/node/v18.0.0/bin");
        let idx_newest = segments.iter().position(|s| *s == newest_nvm);
        let idx_older = segments.iter().position(|s| *s == older_nvm);
        assert!(idx_newest.is_some(), "expected newest nvm in PATH: {result}");
        assert!(idx_older.is_some(), "expected older nvm in PATH: {result}");
        assert!(
            idx_newest.unwrap() < idx_older.unwrap(),
            "newest nvm must precede older: {result}"
        );
        if let Some(idx_usr_local) = segments.iter().position(|s| *s == "/usr/local/bin") {
            assert!(
                idx_newest.unwrap() < idx_usr_local,
                "nvm must precede /usr/local/bin so a stale system node is shadowed: {result}"
            );
        }
    }

    #[test]
    fn compute_augmented_path_preserves_parent_entries_first() {
        // Terminal-launched sessions already have nvm at the top of PATH;
        // the helper must not reorder the parent's entries, only append
        // fallbacks.
        let home_dir = tempfile::tempdir().expect("tempdir");
        let home = home_dir.path().as_os_str().to_owned();
        let parent = std::ffi::OsString::from("/custom/user/bin:/usr/bin");
        let result = compute_augmented_path(&parent, &home);

        let segments: Vec<&str> = result.split(':').collect();
        assert_eq!(
            segments.first().copied(),
            Some("/custom/user/bin"),
            "parent PATH must lead the result: {result}"
        );
        assert_eq!(
            segments.get(1).copied(),
            Some("/usr/bin"),
            "parent PATH order must be preserved: {result}"
        );
    }

    #[test]
    fn compute_augmented_path_deduplicates() {
        // If /opt/homebrew/bin is already in the parent PATH, we must not
        // append a second copy.
        let home_dir = tempfile::tempdir().expect("tempdir");
        let home = home_dir.path().as_os_str().to_owned();
        let parent = std::ffi::OsString::from("/opt/homebrew/bin:/usr/bin");
        let result = compute_augmented_path(&parent, &home);

        let count = result.split(':').filter(|s| *s == "/opt/homebrew/bin").count();
        assert_eq!(count, 1, "duplicate /opt/homebrew/bin in PATH: {result}");
    }

    // --- check_run_cli_allowed ---

    #[test]
    fn run_cli_allows_whitelisted_prefixes() {
        for args in [
            vec!["channel", "list"],
            vec!["channel", "list", "--json"],
            vec!["session", "list", "--channel", "c-123"],
            vec!["chat", "mcp-config"],
            vec!["chat", "system-prompt", "--channel", "c-123"],
            vec!["inspect-mcp"],
            vec!["version"],
            vec!["--version"],
        ] {
            assert!(
                check_run_cli_allowed(&args).is_ok(),
                "expected {:?} to be allowed",
                args
            );
        }
    }

    #[test]
    fn run_cli_rejects_empty_args() {
        assert!(check_run_cli_allowed(&[]).is_err());
    }

    #[test]
    fn run_cli_rejects_non_whitelisted_subcommands() {
        for args in [
            vec!["channel", "create", "new", "desc"],
            vec!["session", "append", "--channel", "c"],
            vec!["chat", "rewind-apply"],
            vec!["random-verb"],
            vec!["claude"],
        ] {
            assert!(
                check_run_cli_allowed(&args).is_err(),
                "expected {:?} to be rejected",
                args
            );
        }
    }

    #[test]
    fn run_cli_rejects_destructive_verbs_everywhere() {
        // Even if a prefix looks legitimate, destructive verbs as tokens
        // in the arg list must kill the request.
        for args in [
            vec!["channel", "archive", "c-123"],
            vec!["channel", "delete", "c-123"],
            vec!["session", "remove", "s-1"],
            vec!["rm", "-rf"],
            vec!["chat", "reset"],
            vec!["workspace", "purge"],
            vec!["channel", "list", "drop"],
        ] {
            let err = check_run_cli_allowed(&args).unwrap_err();
            assert!(
                err.contains("destructive") || err.contains("allow-list"),
                "expected rejection reason for {:?}, got {}",
                args,
                err
            );
        }
    }

    #[test]
    fn run_cli_destructive_denylist_message_is_descriptive() {
        let err = check_run_cli_allowed(&["channel", "archive", "c-123"]).unwrap_err();
        assert!(err.contains("destructive"), "got: {}", err);
        assert!(err.contains("archive"), "got: {}", err);
    }

    // --- OSS-01 rewind hardening ---

    /// Gap #1 regression: a `rewind_key` containing quotes, backslashes,
    /// newlines, or a `},"x":"y"` JSON fragment must round-trip through
    /// serde as a single string field and not break out of the metadata
    /// object. The `format!`-based predecessor would emit malformed JSON
    /// or inject additional fields for these inputs.
    #[test]
    fn rewind_metadata_json_escapes_adversarial_keys() {
        let cases = [
            "plain",
            "with \"quote\"",
            "with \\ backslash",
            "with\nnewline",
            "with\ttab",
            "with \"quote\"\nand \\ and\t tab",
            r#"},"x":"y"#,
            r#"break"}, "injected": "yes"}"#,
        ];
        for key in cases {
            let raw = build_rewind_metadata_json(key);
            let parsed: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("invalid JSON for key {key:?}: {e} (raw: {raw})"));
            let obj = parsed
                .as_object()
                .unwrap_or_else(|| panic!("expected object for key {key:?}, got {parsed}"));
            // Exactly one field, and it must be `rewindKey` with our exact input.
            assert_eq!(obj.len(), 1, "unexpected extra fields for key {key:?}: {parsed}");
            assert_eq!(
                obj.get("rewindKey").and_then(|v| v.as_str()),
                Some(key),
                "rewindKey did not round-trip for {key:?}: {parsed}"
            );
        }
    }

    #[test]
    fn cancel_flag_roundtrip() {
        // Isolated check: mark/clear affects is_stream_cancelled as expected.
        // Use a stream_id guaranteed unique across the test binary.
        let sid = u64::MAX - 42;
        assert!(!is_stream_cancelled(sid));
        mark_stream_cancelled(sid);
        assert!(is_stream_cancelled(sid));
        clear_stream_cancelled(sid);
        assert!(!is_stream_cancelled(sid));
    }

    // --- OSS-10 shell_single_quote (POSIX) ---

    #[test]
    fn shell_single_quote_plain() {
        assert_eq!(shell_single_quote("/home/user/repo"), "'/home/user/repo'");
    }

    #[test]
    fn shell_single_quote_spaces() {
        assert_eq!(
            shell_single_quote("/path with spaces/repo"),
            "'/path with spaces/repo'"
        );
    }

    #[test]
    fn shell_single_quote_embedded_single_quote() {
        // Canonical POSIX trick: close, escaped-single, reopen.
        assert_eq!(
            shell_single_quote("/path/o'brien/repo"),
            "'/path/o'\\''brien/repo'"
        );
    }

    #[test]
    fn shell_single_quote_embedded_double_quote() {
        // Double quotes are harmless inside single quotes.
        assert_eq!(
            shell_single_quote(r#"/path/"quoted"/repo"#),
            r#"'/path/"quoted"/repo'"#
        );
    }

    #[test]
    fn shell_single_quote_non_ascii() {
        assert_eq!(shell_single_quote("/路径/仓库"), "'/路径/仓库'");
    }

    #[test]
    fn shell_single_quote_backslashes_preserved() {
        // Single quotes disable backslash interpretation — preserved verbatim.
        assert_eq!(
            shell_single_quote(r"/path/with\back\slashes"),
            r"'/path/with\back\slashes'"
        );
    }

    // --- OSS-10 windows_quote_path ---

    #[test]
    fn windows_quote_path_plain() {
        assert_eq!(windows_quote_path(r"C:\Users\me\repo"), r#""C:\Users\me\repo""#);
    }

    #[test]
    fn windows_quote_path_spaces() {
        assert_eq!(
            windows_quote_path(r"C:\Program Files\repo"),
            r#""C:\Program Files\repo""#
        );
    }

    #[test]
    fn windows_quote_path_embedded_quote() {
        // Inner " must be escaped as \" and any preceding backslashes doubled.
        // Input:  C:\foo"bar   ->   "C:\foo\"bar"
        assert_eq!(
            windows_quote_path(r#"C:\foo"bar"#),
            r#""C:\foo\"bar""#
        );
    }

    #[test]
    fn windows_quote_path_trailing_backslash() {
        // Trailing backslash before the closing quote must be doubled to
        // avoid escaping the closing quote. Input C:\repo\ -> "C:\repo\\"
        assert_eq!(windows_quote_path(r"C:\repo\"), r#""C:\repo\\""#);
    }

    #[test]
    fn windows_quote_path_backslash_before_quote() {
        // Backslashes preceding an inner quote get doubled.
        // Input: a\"b -> "a\\\"b"
        assert_eq!(windows_quote_path(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn windows_quote_path_non_ascii() {
        assert_eq!(windows_quote_path(r"C:\路径\仓库"), "\"C:\\路径\\仓库\"");
    }

    // --- OSS-10 parse_terminal_tab_ref ---

    #[test]
    fn parse_terminal_tab_ref_typical() {
        let raw = "tab 3 of window id 12345";
        assert_eq!(parse_terminal_tab_ref(raw), (Some(12345), Some(3)));
    }

    #[test]
    fn parse_terminal_tab_ref_no_tab() {
        assert_eq!(parse_terminal_tab_ref("window id 42"), (Some(42), None));
    }

    #[test]
    fn parse_terminal_tab_ref_empty() {
        assert_eq!(parse_terminal_tab_ref(""), (None, None));
    }

    // --- OSS-10 detect_terminal ---

    #[test]
    fn detect_terminal_picks_first_match() {
        let chain = &["gnome-terminal", "konsole", "xterm"];
        let present = ["konsole", "xterm"];
        let got = detect_terminal(chain, |n| present.contains(&n));
        assert_eq!(got.as_deref(), Some("konsole"));
    }

    #[test]
    fn detect_terminal_honors_chain_order() {
        let chain = &["alacritty", "gnome-terminal", "xterm"];
        let present = ["xterm", "gnome-terminal", "alacritty"];
        let got = detect_terminal(chain, |n| present.contains(&n));
        // Order is *chain*, not `present`.
        assert_eq!(got.as_deref(), Some("alacritty"));
    }

    #[test]
    fn detect_terminal_none_found() {
        let chain = &["gnome-terminal", "konsole"];
        let got = detect_terminal(chain, |_| false);
        assert!(got.is_none());
    }

    #[test]
    fn detect_terminal_env_term_wins_on_linux() {
        // Simulate the Linux-branch behavior where $TERMINAL is pushed to
        // the front of the chain. If $TERMINAL is set to a weird-but-real
        // emulator, detection should pick it before anything in the default
        // chain — even if a default-chain entry is also present.
        let env_term = "my-custom-term";
        let mut chain: Vec<&str> = vec![env_term];
        chain.extend_from_slice(LINUX_TERMINAL_CHAIN);
        let present = ["my-custom-term", "xterm"];
        let got = detect_terminal(&chain, |n| present.contains(&n));
        assert_eq!(got.as_deref(), Some("my-custom-term"));
    }

    #[test]
    fn detect_terminal_windows_chain_prefers_wt() {
        let present = ["wt.exe", "cmd.exe"];
        let got = detect_terminal(WINDOWS_TERMINAL_CHAIN, |n| present.contains(&n));
        assert_eq!(got.as_deref(), Some("wt.exe"));
    }

    #[test]
    fn detect_terminal_windows_chain_falls_through_to_cmd() {
        let present = ["cmd.exe"];
        let got = detect_terminal(WINDOWS_TERMINAL_CHAIN, |n| present.contains(&n));
        assert_eq!(got.as_deref(), Some("cmd.exe"));
    }

    // --- AL-10 autonomous session readers ---
    //
    // Build a fake `~/.relay/sessions/<sessionId>/` tree under a tmpdir,
    // point `RELAY_HARNESS_ROOT` at it, and assert the readers produce the
    // same shape the header renders against. Using the env-var override
    // instead of a fn-level injection keeps the command surface unchanged
    // (the commands call `harness_data::harness_root()` directly).
    //
    // We deliberately keep these tests single-threaded via a module-local
    // Mutex — `RELAY_HARNESS_ROOT` is process-global and parallel tests
    // would step on each other's fixtures.

    use std::sync::Mutex as TestMutex;
    static RELAY_ROOT_LOCK: TestMutex<()> = TestMutex::new(());

    fn with_fake_relay_root<F: FnOnce(&std::path::Path)>(f: F) {
        let _guard = RELAY_ROOT_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("RELAY_HARNESS_ROOT").ok();
        std::env::set_var("RELAY_HARNESS_ROOT", tmp.path());
        f(tmp.path());
        match prev {
            Some(v) => std::env::set_var("RELAY_HARNESS_ROOT", v),
            None => std::env::remove_var("RELAY_HARNESS_ROOT"),
        }
    }

    fn write_session_fixture(
        root: &std::path::Path,
        session_id: &str,
        channel_id: &str,
        budget_tokens: u64,
        used: u64,
        state: &str,
        max_hours: f64,
    ) {
        let dir = root.join("sessions").join(session_id);
        fs::create_dir_all(&dir).unwrap();
        let started_at = chrono::Utc::now().to_rfc3339();
        let metadata = serde_json::json!({
            "sessionId": session_id,
            "channelId": channel_id,
            "budgetTokens": budget_tokens,
            "maxHours": max_hours,
            "maxHoursRequested": max_hours,
            "trust": "supervised",
            "allowedRepos": ["repo-a"],
            "startedAt": started_at,
            "command": "rly run --autonomous",
            "invokedBy": { "user": "test", "host": "test" },
        });
        fs::write(dir.join("metadata.json"), metadata.to_string()).unwrap();
        let lifecycle = serde_json::json!({
            "sessionId": session_id,
            "state": state,
            "startedAt": started_at,
            "transitions": [],
            "maxDurationMs": (max_hours * 3600.0 * 1000.0) as u64,
        });
        fs::write(dir.join("lifecycle.json"), lifecycle.to_string()).unwrap();
        if used > 0 {
            let line = serde_json::json!({
                "ts": started_at,
                "inputTokens": used,
                "outputTokens": 0,
                "cumulativeUsed": used,
            });
            fs::write(dir.join("budget.jsonl"), format!("{}\n", line)).unwrap();
        }
    }

    #[test]
    fn list_autonomous_sessions_empty_on_no_root() {
        with_fake_relay_root(|_| {
            assert!(list_autonomous_sessions().is_empty());
        });
    }

    #[test]
    fn list_autonomous_sessions_surfaces_well_formed_sessions() {
        with_fake_relay_root(|root| {
            write_session_fixture(root, "auto-a", "channel-1", 10_000, 2_500, "dispatching", 8.0);
            write_session_fixture(root, "auto-b", "channel-2", 10_000, 0, "planning", 8.0);
            let sessions = list_autonomous_sessions();
            assert_eq!(sessions.len(), 2);
            let by_id: std::collections::HashMap<_, _> =
                sessions.iter().map(|s| (s.session_id.as_str(), s)).collect();
            assert_eq!(by_id["auto-a"].channel_id, "channel-1");
            assert_eq!(by_id["auto-a"].state, "dispatching");
            assert_eq!(by_id["auto-b"].state, "planning");
        });
    }

    #[test]
    fn list_autonomous_sessions_skips_corrupt_metadata() {
        with_fake_relay_root(|root| {
            // A directory with no metadata.json at all.
            fs::create_dir_all(root.join("sessions").join("auto-orphan")).unwrap();
            // A directory whose metadata.json isn't JSON.
            let bad = root.join("sessions").join("auto-bad");
            fs::create_dir_all(&bad).unwrap();
            fs::write(bad.join("metadata.json"), "{ not json").unwrap();
            // A valid session alongside.
            write_session_fixture(root, "auto-ok", "channel-1", 10_000, 0, "planning", 8.0);

            let sessions = list_autonomous_sessions();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].session_id, "auto-ok");
        });
    }

    #[test]
    fn get_session_state_computes_budget_pct_and_hours_remaining() {
        with_fake_relay_root(|root| {
            write_session_fixture(root, "auto-a", "channel-1", 10_000, 2_500, "dispatching", 8.0);
            let state = get_session_state("auto-a".into()).unwrap().unwrap();
            assert_eq!(state.budget_used, 2_500);
            assert!((state.budget_pct - 25.0).abs() < 0.01);
            assert!(state.hours_remaining > 0.0 && state.hours_remaining <= 8.0);
            assert_eq!(state.state, "dispatching");
        });
    }

    #[test]
    fn get_session_state_handles_zero_budget_without_dividing_by_zero() {
        with_fake_relay_root(|root| {
            write_session_fixture(root, "auto-a", "channel-1", 0, 0, "planning", 1.0);
            let state = get_session_state("auto-a".into()).unwrap().unwrap();
            assert_eq!(state.budget_pct, 0.0);
        });
    }

    #[test]
    fn get_session_state_returns_none_for_unknown_session() {
        with_fake_relay_root(|_| {
            let state = get_session_state("auto-nope".into()).unwrap();
            assert!(state.is_none());
        });
    }

    // AL-10 B1/B2/B3: stop_session / list_session_approvals /
    // resolve_session_approval tests were removed. AL-9's stop_session
    // is covered by its own tests (search earlier in the tests module);
    // AL-8's queue surfaces carry their own test coverage via
    // `test/approvals/queue.test.ts` and the harness-data crate's
    // `ApprovalQueueRecord` parser tests.
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            list_channels,
            get_channel,
            list_feed,
            list_sessions,
            list_session_counts,
            load_session,
            list_channel_tickets,
            list_channel_decisions,
            list_channel_runs,
            list_runs,
            list_ticket_ledger,
            list_agent_names,
            run_cli,
            create_channel,
            archive_channel,
            unarchive_channel,
            create_dm,
            promote_dm,
            set_channel_full_access,
            update_channel_repos,
            set_channel_starred,
            set_channel_tier,
            set_primary_repo,
            get_settings,
            update_settings,
            post_to_channel,
            create_session,
            delete_session,
            stop_session,
            append_session_message,
            rewind_snapshot,
            rewind_apply,
            start_chat,
            cancel_chat_stream,
            spawn_agent,
            kill_spawned_agent,
            list_spawns,
            list_tracked_prs,
            list_pending_plans,
            approve_plan,
            reject_plan,
            list_sections,
            create_section,
            rename_section,
            decommission_section,
            restore_section,
            delete_section,
            assign_channel_section,
            // AL-8 approvals surface.
            list_pending_approvals,
            approve_queue_entry,
            reject_queue_entry,
            approve_queue_all,
            // AL-10 session-status header. `stop_session` is registered
            // earlier (AL-9 owner); AL-10's duplicate was dropped.
            list_autonomous_sessions,
            get_session_state,
            // Provider profiles (PR 3 of multi-provider series).
            list_provider_profiles,
            get_default_provider_profile_id,
            upsert_provider_profile,
            remove_provider_profile,
            set_default_provider_profile,
            set_channel_provider_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
