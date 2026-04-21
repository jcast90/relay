use harness_data as data;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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

#[tauri::command]
fn list_workspaces() -> Vec<data::WorkspaceEntry> {
    data::load_workspaces()
}

#[tauri::command]
fn list_channels() -> Vec<data::Channel> {
    data::load_channels()
}

#[tauri::command]
fn get_channel(channel_id: String) -> Result<Option<data::Channel>, String> {
    validate_id_segment(&channel_id, "channelId")?;
    Ok(data::load_channels()
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

#[derive(Serialize)]
struct CliResult {
    success: bool,
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

fn cli_run(args: &[&str]) -> CliResult {
    let bin = std::env::var("RELAY_BIN")
        .or_else(|_| std::env::var("AGENT_HARNESS_BIN"))
        .unwrap_or_else(|_| "rly".to_string());
    match Command::new(bin)
        .args(args)
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
/// As of this commit, no call site in `gui/src/` uses `run_cli` — the
/// frontend reaches the CLI through the typed wrappers (`create_channel`,
/// `post_to_channel`, etc.). `run_cli` stays for escape-hatch diagnostics
/// but is locked down to a short read-only list so a compromised renderer
/// can't trigger destructive operations. Add entries here as the renderer
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
    for repo in &repos {
        validate_id_segment(&repo.alias, "repo.alias")?;
        validate_id_segment(&repo.workspace_id, "repo.workspaceId")?;
    }
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

    let repos = repos_arg(&repos);
    let mut args: Vec<&str> = vec!["channel", "create", &name, &description, "--json"];
    if !repos.is_empty() {
        args.push("--repos");
        args.push(&repos);
    }
    if let Some(ref alias) = primary_alias {
        args.push("--primary");
        args.push(alias);
    }
    cli_json(&args)
}

#[tauri::command]
fn archive_channel(channel_id: String) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    cli_json(&["channel", "archive", &channel_id, "--json"])
}

#[tauri::command]
fn update_channel_repos(
    channel_id: String,
    repos: Vec<RepoAssignmentInput>,
) -> Result<serde_json::Value, String> {
    validate_id_segment(&channel_id, "channelId")?;
    for repo in &repos {
        validate_id_segment(&repo.alias, "repo.alias")?;
        validate_id_segment(&repo.workspace_id, "repo.workspaceId")?;
    }
    let repos = repos_arg(&repos);
    cli_json(&["channel", "update", &channel_id, "--repos", &repos, "--json"])
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

fn describe_tool_use(name: &str, input: &serde_json::Value) -> String {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let basename = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let trunc = |s: String, n: usize| {
        if s.chars().count() <= n {
            s
        } else {
            let mut out: String = s.chars().take(n).collect();
            out.push('…');
            out
        }
    };
    match name {
        "Read" => format!("Reading {}", basename(&s("file_path"))),
        "Edit" => format!("Editing {}", basename(&s("file_path"))),
        "Write" => format!("Writing {}", basename(&s("file_path"))),
        "Bash" => format!("$ {}", trunc(s("command"), 60)),
        "Grep" => format!("Searching '{}'", trunc(s("pattern"), 40)),
        "Glob" => format!("Finding {}", s("pattern")),
        "WebSearch" => format!("Web search: {}", trunc(s("query"), 40)),
        "WebFetch" => format!("Fetching {}", trunc(s("url"), 50)),
        "Skill" => format!("/{}", s("skill")),
        _ => name.to_string(),
    }
}

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
    let metadata_json = rewind_key
        .as_ref()
        .map(|k| format!("{{\"rewindKey\":\"{}\"}}", k.replace('"', "\\\"")));
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
        cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
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

        for line in reader.lines() {
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
                                            text: describe_tool_use(name, input),
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

// --- Terminal.app spawn/kill lifecycle (Task #24) ---
//
// Each channel tracks an associated-repo agent spawn in
// `~/.relay/channels/<channelId>/spawns.json`. On macOS, "spawn" opens a new
// Terminal.app tab running `rly claude` in the repo; we capture the window/tab
// ids from the AppleScript return value so we can close them again later.
//
// We hardcode STALE_HEARTBEAT_MS here (matching the crosslink store) instead
// of depending on the TS/crosslink side, so self-heal stays self-contained.
const STALE_HEARTBEAT_MS: u64 = 120_000;

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

#[tauri::command]
fn spawn_agent(
    channel_id: String,
    alias: String,
    repo_path: String,
) -> Result<Spawn, String> {
    validate_id_segment(&channel_id, "channelId")?;
    validate_id_segment(&alias, "alias")?;
    if std::env::consts::OS != "macos" {
        return Err(
            "spawn is macOS-only — run `rly claude` in the repo manually on this platform".into(),
        );
    }

    // Build the shell command the Terminal tab should run. We single-quote
    // the path to survive spaces and most shell metacharacters, then wrap
    // the whole shell command as an AppleScript string literal.
    let shell_cmd = format!("cd {} && rly claude", shell_single_quote(&repo_path));
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
        // Shell out to `kill` — avoids pulling in libc/nix just for SIGTERM.
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
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

#[cfg(test)]
mod tests {
    use super::{check_run_cli_allowed, validate_id_segment};

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            list_channels,
            get_channel,
            list_feed,
            list_sessions,
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
            update_channel_repos,
            post_to_channel,
            create_session,
            delete_session,
            append_session_message,
            rewind_snapshot,
            rewind_apply,
            start_chat,
            spawn_agent,
            kill_spawned_agent,
            list_spawns,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
