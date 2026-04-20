use harness_data as data;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Emitter;

#[tauri::command]
fn list_workspaces() -> Vec<data::WorkspaceEntry> {
    data::load_workspaces()
}

#[tauri::command]
fn list_channels() -> Vec<data::Channel> {
    data::load_channels()
}

#[tauri::command]
fn get_channel(channel_id: String) -> Option<data::Channel> {
    data::load_channels()
        .into_iter()
        .find(|c| c.channel_id == channel_id)
}

#[tauri::command]
fn list_feed(channel_id: String, limit: usize) -> Vec<data::ChannelEntry> {
    data::load_channel_feed(&channel_id, limit)
}

#[tauri::command]
fn list_sessions(channel_id: String) -> Vec<data::ChatSession> {
    data::load_sessions(&channel_id)
}

#[tauri::command]
fn load_session(
    channel_id: String,
    session_id: String,
    limit: usize,
) -> Vec<data::PersistedChatMessage> {
    data::load_session_chat(&channel_id, &session_id, limit)
}

#[tauri::command]
fn list_channel_tickets(channel_id: String) -> Vec<data::TicketLedgerEntry> {
    data::load_channel_tickets(&channel_id)
}

#[tauri::command]
fn list_channel_decisions(channel_id: String) -> Vec<data::Decision> {
    data::load_channel_decisions(&channel_id)
}

#[tauri::command]
fn list_channel_runs(channel_id: String) -> Vec<data::ChannelRunLink> {
    data::load_channel_run_links(&channel_id)
}

#[tauri::command]
fn list_runs(workspace_id: String) -> Vec<data::RunIndexEntry> {
    data::load_runs_for_workspace(&workspace_id)
}

#[tauri::command]
fn list_ticket_ledger(workspace_id: String, run_id: String) -> Vec<data::TicketLedgerEntry> {
    data::load_ticket_ledger(&workspace_id, &run_id)
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
    let bin = std::env::var("AGENT_HARNESS_BIN").unwrap_or_else(|_| "agent-harness".to_string());
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
            "agent-harness {} failed: {}",
            args.join(" "),
            result.stderr.trim()
        ));
    }
    serde_json::from_str(result.stdout.trim()).map_err(|e| {
        format!(
            "invalid JSON from agent-harness {}: {} (output: {})",
            args.join(" "),
            e,
            result.stdout
        )
    })
}

#[tauri::command]
fn run_cli(args: Vec<String>) -> CliResult {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli_run(&refs)
}

#[derive(serde::Deserialize)]
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
) -> Result<serde_json::Value, String> {
    let repos = repos_arg(&repos);
    let mut args: Vec<&str> = vec!["channel", "create", &name, &description, "--json"];
    if !repos.is_empty() {
        args.push("--repos");
        args.push(&repos);
    }
    cli_json(&args)
}

#[tauri::command]
fn archive_channel(channel_id: String) -> Result<serde_json::Value, String> {
    cli_json(&["channel", "archive", &channel_id, "--json"])
}

#[tauri::command]
fn update_channel_repos(
    channel_id: String,
    repos: Vec<RepoAssignmentInput>,
) -> Result<serde_json::Value, String> {
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
    cli_json(&[
        "session", "create", "--channel", &channel_id, "--title", &title,
    ])
}

#[tauri::command]
fn delete_session(
    channel_id: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
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
) -> Result<serde_json::Value, String> {
    let mut args: Vec<&str> = vec![
        "session", "append", "--channel", &channel_id, "--session", &session_id, "--role", &role,
    ];
    if let Some(ref alias) = agent_alias {
        args.push("--alias");
        args.push(alias);
    }
    args.push(&content);
    cli_json(&args)
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
) -> Result<u64, String> {
    let stream_id = CHAT_SEQ.fetch_add(1, Ordering::SeqCst);

    // Persist user message immediately so UI reflects history on reload.
    let alias_arg = alias.clone();
    let mut append_args: Vec<&str> = vec![
        "session", "append", "--channel", &channel_id, "--session", &session_id, "--role", "user",
    ];
    if let Some(ref a) = alias_arg {
        append_args.push("--alias");
        append_args.push(a);
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
            start_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
