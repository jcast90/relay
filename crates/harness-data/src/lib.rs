use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub mod tool_activity;

// --- Workspace Registry ---

#[derive(Debug, Deserialize)]
pub struct WorkspaceRegistry {
    pub workspaces: Vec<WorkspaceEntry>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub workspace_id: String,
    pub repo_path: String,
}

// --- Runs Index ---

#[derive(Debug, Deserialize)]
pub struct RunsIndex {
    pub runs: Option<Vec<RunIndexEntry>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RunIndexEntry {
    pub run_id: String,
    pub feature_request: String,
    pub state: String,
    pub channel_id: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

// --- Ticket Ledger ---

#[derive(Debug, Deserialize)]
pub struct TicketLedger {
    pub tickets: Option<Vec<TicketLedgerEntry>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TicketLedgerEntry {
    pub ticket_id: String,
    pub title: String,
    pub specialty: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub assigned_agent_id: Option<String>,
    pub assigned_agent_name: Option<String>,
    pub verification: String,
    pub attempt: u32,
    /// Alias of the channel repo assignment this ticket should be routed
    /// to. Optional and `#[serde(default)]`-backed so ticket files written
    /// before per-repo routing existed still deserialize.
    #[serde(default)]
    pub assigned_alias: Option<String>,
}

// --- Channel ---

/// A repo assigned to a channel, with an alias for @-addressing in chat
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoAssignment {
    pub alias: String,        // e.g. "ui", "be", "brain"
    pub workspace_id: String, // from workspace-registry
    pub repo_path: String,    // absolute path to repo
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub channel_id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub members: Vec<ChannelMember>,
    pub pinned_refs: Vec<ChannelRef>,
    #[serde(default)]
    pub repo_assignments: Vec<RepoAssignment>,
    /// When set, identifies the `workspace_id` of the entry in
    /// `repo_assignments` that is this channel's primary repo. Back-compat
    /// via `#[serde(default)]` — channel files predating the
    /// primary/associated model omit this field and deserialize with
    /// `None`, in which case consumers fall back to the first entry in
    /// `repo_assignments`.
    #[serde(default)]
    pub primary_workspace_id: Option<String>,
    /// ISO 8601 timestamps. Optional for back-compat with channel files
    /// written before these fields were tracked.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMember {
    pub agent_id: String,
    pub display_name: String,
    pub role: String,
    pub provider: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRef {
    #[serde(rename = "type")]
    pub ref_type: String,
    pub target_id: String,
    pub label: String,
}

// --- Channel Feed Entry ---

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEntry {
    pub entry_id: String,
    pub channel_id: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub from_agent_id: Option<String>,
    pub from_display_name: Option<String>,
    pub content: String,
    pub metadata: HashMap<String, String>,
    pub created_at: String,
}

// --- Agent Names ---

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentNameEntry {
    pub agent_id: String,
    pub display_name: String,
    pub provider: String,
    pub role: String,
}

// --- Decision ---

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision_id: String,
    pub title: String,
    pub description: String,
    pub rationale: String,
    pub alternatives: Vec<String>,
    pub decided_by_name: String,
    pub created_at: String,
}

// --- Channel Run Link ---

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRunLink {
    pub run_id: String,
    pub workspace_id: String,
}

// --- Global Config ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfig {
    #[serde(default)]
    pub project_dirs: Vec<String>,
}

// --- Data Loading ---

pub fn harness_root() -> PathBuf {
    // Prefer the new `.relay` path; fall back to the legacy `.agent-harness`
    // path if that's what exists. The Node side auto-migrates on first run,
    // so Rust readers naturally follow once a TS invocation has happened.
    let home = dirs::home_dir().unwrap_or_default();
    let relay = home.join(".relay");
    let legacy = home.join(".agent-harness");
    if relay.exists() {
        relay
    } else if legacy.exists() {
        legacy
    } else {
        relay
    }
}

pub fn load_config() -> HarnessConfig {
    let path = harness_root().join("config.json");
    load_json::<HarnessConfig>(&path).unwrap_or(HarnessConfig {
        project_dirs: Vec::new(),
    })
}

/// Scan a directory for immediate child directories that contain a .git folder
fn discover_repos_in(dir: &Path) -> Vec<WorkspaceEntry> {
    let mut repos = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return repos,
    };

    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() && child.join(".git").exists() {
            let repo_path = child.to_string_lossy().to_string();
            let name = child
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            repos.push(WorkspaceEntry {
                workspace_id: format!("discovered:{}", name),
                repo_path,
            });
        }
    }

    repos
}

pub fn load_workspaces() -> Vec<WorkspaceEntry> {
    let path = harness_root().join("workspace-registry.json");
    let mut workspaces = load_json::<WorkspaceRegistry>(&path)
        .map(|r| r.workspaces)
        .unwrap_or_default();

    // Discover repos from configured projectDirs
    let config = load_config();
    let existing_paths: std::collections::HashSet<String> =
        workspaces.iter().map(|w| w.repo_path.clone()).collect();

    for dir in &config.project_dirs {
        let expanded = if dir.starts_with("~/") {
            dirs::home_dir()
                .unwrap_or_default()
                .join(&dir[2..])
        } else {
            PathBuf::from(dir)
        };

        for repo in discover_repos_in(&expanded) {
            if !existing_paths.contains(&repo.repo_path) {
                workspaces.push(repo);
            }
        }
    }

    workspaces.sort_by(|a, b| a.repo_path.cmp(&b.repo_path));
    workspaces
}

pub fn load_agent_names() -> Vec<AgentNameEntry> {
    let path = harness_root().join("agent-names.json");
    load_json::<Vec<AgentNameEntry>>(&path).unwrap_or_default()
}

pub fn load_channels() -> Vec<Channel> {
    let channels_dir = harness_root().join("channels");
    let mut channels = Vec::new();

    if let Ok(entries) = fs::read_dir(&channels_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Some(ch) = load_json::<Channel>(&path) {
                    if ch.status == "active" {
                        channels.push(ch);
                    }
                }
            }
        }
    }

    channels.sort_by(|a, b| a.name.cmp(&b.name));
    channels
}

pub fn load_channel_feed(channel_id: &str, limit: usize) -> Vec<ChannelEntry> {
    let path = harness_root()
        .join("channels")
        .join(channel_id)
        .join("feed.jsonl");

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let entries: Vec<ChannelEntry> = content
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    entries.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect()
}

/// Load channel-local tickets (created via chat, not from orchestrator runs)
pub fn load_channel_tickets(channel_id: &str) -> Vec<TicketLedgerEntry> {
    let path = harness_root()
        .join("channels")
        .join(channel_id)
        .join("tickets.json");
    load_json::<TicketLedger>(&path)
        .and_then(|l| l.tickets)
        .unwrap_or_default()
}

pub fn load_channel_run_links(channel_id: &str) -> Vec<ChannelRunLink> {
    let path = harness_root()
        .join("channels")
        .join(channel_id)
        .join("runs.json");
    load_json::<Vec<ChannelRunLink>>(&path).unwrap_or_default()
}

pub fn load_channel_decisions(channel_id: &str) -> Vec<Decision> {
    let dir = harness_root()
        .join("channels")
        .join(channel_id)
        .join("decisions");

    let mut decisions = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Some(d) = load_json::<Decision>(&path) {
                    decisions.push(d);
                }
            }
        }
    }

    decisions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    decisions
}

pub fn load_runs_for_workspace(workspace_id: &str) -> Vec<RunIndexEntry> {
    let path = harness_root()
        .join("workspaces")
        .join(workspace_id)
        .join("artifacts")
        .join("runs-index.json");

    load_json::<RunsIndex>(&path)
        .and_then(|r| r.runs)
        .unwrap_or_default()
}

pub fn load_ticket_ledger(workspace_id: &str, run_id: &str) -> Vec<TicketLedgerEntry> {
    let path = harness_root()
        .join("workspaces")
        .join(workspace_id)
        .join("artifacts")
        .join(run_id)
        .join("ticket-ledger.json");

    load_json::<TicketLedger>(&path)
        .and_then(|l| l.tickets)
        .unwrap_or_default()
}

const ACTIVE_STATES: &[&str] = &[
    "CLASSIFYING", "DRAFT_PLAN", "PLAN_REVIEW", "AWAITING_APPROVAL",
    "DESIGN_DOC", "PHASE_READY", "PHASE_EXECUTE", "TEST_FIX_LOOP",
    "REVIEW_FIX_LOOP", "TICKETS_EXECUTING", "TICKETS_COMPLETE",
];

pub fn is_active_state(state: &str) -> bool {
    ACTIVE_STATES.contains(&state)
}

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

// --- Chat Sessions & Persistence ---

/// A chat session within a channel
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub session_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    /// Per-worker Claude CLI session IDs for --resume (alias -> claude session id)
    #[serde(default)]
    pub claude_session_ids: HashMap<String, String>,
}

/// Serializable chat message for JSONL persistence
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedChatMessage {
    pub role: String,       // "user", "assistant", "system", "activity"
    pub content: String,
    pub timestamp: String,
    pub agent_alias: Option<String>,
    /// Free-form per-message metadata. Used today by the rewind feature to
    /// tag user turns with a `rewindKey` that points at the git refs
    /// captured before that turn. `#[serde(default)]` keeps older JSONL
    /// transcripts (no metadata field) loadable.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
}

fn sessions_dir(channel_id: &str) -> PathBuf {
    harness_root()
        .join("channels")
        .join(channel_id)
        .join("sessions")
}

fn sessions_index_path(channel_id: &str) -> PathBuf {
    harness_root()
        .join("channels")
        .join(channel_id)
        .join("sessions.json")
}

fn session_chat_path(channel_id: &str, session_id: &str) -> PathBuf {
    sessions_dir(channel_id).join(format!("{}.jsonl", session_id))
}

/// Load all sessions for a channel, sorted by most recent first
pub fn load_sessions(channel_id: &str) -> Vec<ChatSession> {
    let path = sessions_index_path(channel_id);
    let mut sessions: Vec<ChatSession> = load_json::<Vec<ChatSession>>(&path).unwrap_or_default();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// Save sessions index (atomic write)
pub fn save_sessions(channel_id: &str, sessions: &[ChatSession]) {
    let path = sessions_index_path(channel_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp_path = path.with_extension("json.tmp");
    if let Ok(content) = serde_json::to_string_pretty(sessions) {
        if fs::write(&tmp_path, &content).is_ok() {
            let _ = fs::rename(&tmp_path, &path);
        }
    }
}

/// Create a new session and return it
pub fn create_session(channel_id: &str, title: &str) -> ChatSession {
    let now = chrono::Utc::now().to_rfc3339();
    let session = ChatSession {
        session_id: format!("sess-{}", chrono::Utc::now().timestamp_millis()),
        title: title.to_string(),
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        claude_session_ids: HashMap::new(),
    };

    let _ = fs::create_dir_all(sessions_dir(channel_id));

    let mut sessions = load_sessions(channel_id);
    sessions.push(session.clone());
    save_sessions(channel_id, &sessions);

    session
}

/// Update a session in the index (title, message count, timestamps, claude session ids)
pub fn update_session(channel_id: &str, session: &ChatSession) {
    let mut sessions = load_sessions(channel_id);
    if let Some(existing) = sessions.iter_mut().find(|s| s.session_id == session.session_id) {
        *existing = session.clone();
    }
    save_sessions(channel_id, &sessions);
}

/// Load chat messages for a specific session
pub fn load_session_chat(channel_id: &str, session_id: &str, limit: usize) -> Vec<PersistedChatMessage> {
    let path = session_chat_path(channel_id, session_id);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let entries: Vec<PersistedChatMessage> = content
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    entries.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect()
}

/// Migrate old single chat.jsonl to a session (one-time migration)
pub fn migrate_legacy_chat(channel_id: &str) {
    let legacy_path = harness_root()
        .join("channels")
        .join(channel_id)
        .join("chat.jsonl");

    if !legacy_path.exists() {
        return;
    }

    let content = match fs::read_to_string(&legacy_path) {
        Ok(c) if !c.trim().is_empty() => c,
        _ => {
            let _ = fs::remove_file(&legacy_path);
            return;
        }
    };

    // Create a session for the legacy chat
    let session = create_session(channel_id, "Imported conversation");

    // Copy messages to the new session file
    let dest = session_chat_path(channel_id, &session.session_id);
    let _ = fs::create_dir_all(sessions_dir(channel_id));
    let _ = fs::write(&dest, &content);

    // Count messages
    let count = content.lines().filter(|l| !l.is_empty()).count();
    let mut updated = session;
    updated.message_count = count;
    update_session(channel_id, &updated);

    // Remove legacy file
    let _ = fs::remove_file(&legacy_path);
}
