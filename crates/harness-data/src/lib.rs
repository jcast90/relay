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
    /// Provenance of the ticket. Omitted / "relay" = Relay-produced;
    /// "linear" = read-only mirror of a Linear issue. All
    /// `#[serde(default)]` for back-compat with ticket files written before
    /// the Linear mirror existed.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub linear_issue_id: Option<String>,
    #[serde(default)]
    pub linear_identifier: Option<String>,
    #[serde(default)]
    pub linear_state: Option<String>,
    #[serde(default)]
    pub linear_url: Option<String>,
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

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelTier {
    FeatureLarge,
    Feature,
    Bugfix,
    Chore,
    Question,
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
    /// Linear project ID mirrored onto this channel's board. Read-only.
    /// Absence means no Linear mirror is configured.
    #[serde(default)]
    pub linear_project_id: Option<String>,
    /// Classifier-assigned tier surfaced as a pill in the channel header.
    /// Back-compat via serde default; older channel files deserialize with None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<ChannelTier>,
    /// Channel is pinned to the Starred section of the sidebar.
    #[serde(default)]
    pub starred: bool,
    /// Per-channel opt-in for unattended agent runs (AL-0). When `true`,
    /// agent subprocesses dispatched on behalf of this channel skip every
    /// permission prompt. Optional + `#[serde(default)]` so older channel
    /// files that predate the flag keep deserializing as `false`.
    #[serde(default)]
    pub full_access: Option<bool>,
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

// --- Tracked PRs ---
//
// Written by the CLI's PR watcher (see `src/cli/pr-watcher-factory.ts`
// `persistSnapshot`) to `channels/<channel_id>/tracked-prs.json` on every
// poll tick. Shape mirrors `TrackedPrRowSchema` in
// `src/domain/pr-row.ts` — keep these in sync. Optional CI/review/state
// fields are null when the row has been tracked but not yet polled.

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPrRow {
    pub ticket_id: String,
    pub channel_id: String,
    pub owner: String,
    pub name: String,
    pub number: u64,
    pub url: String,
    pub branch: String,
    pub ci: Option<String>,
    pub review: Option<String>,
    pub pr_state: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TrackedPrFile {
    #[serde(default)]
    pub rows: Vec<TrackedPrRow>,
}

// --- Run Approval Record ---
//
// Mirrors what `submitApproval()` writes via the artifact store — a
// `<runId>__approval.json` under `run-artifacts/` in the global relay root
// (see `storage/file-store.ts`). When present it means someone has already
// decided on the plan; absent + run state `AWAITING_APPROVAL` means a plan
// is pending.

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub run_id: String,
    pub decision: String,
    #[serde(default)]
    pub feedback: Option<String>,
    pub timestamp: String,
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
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".relay")
}

pub fn load_config() -> HarnessConfig {
    let path = harness_root().join("config.json");
    load_json::<HarnessConfig>(&path).unwrap_or(HarnessConfig {
        project_dirs: Vec::new(),
    })
}

// --- GUI Settings ---

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuiSettings {
    #[serde(default = "default_ticket_provider")]
    pub ticket_provider: String,
    #[serde(default)]
    pub linear_api_token: String,
    #[serde(default)]
    pub linear_workspace: String,
    #[serde(default = "default_poll_interval")]
    pub linear_poll_seconds: u32,
    #[serde(default = "default_right_rail_open")]
    pub right_rail_open: bool,
}

fn default_ticket_provider() -> String { "relay".to_string() }
fn default_poll_interval() -> u32 { 30 }
fn default_right_rail_open() -> bool { true }

pub fn gui_settings_path() -> PathBuf {
    harness_root().join("gui-settings.json")
}

pub fn load_gui_settings() -> GuiSettings {
    load_json::<GuiSettings>(&gui_settings_path()).unwrap_or_else(|| GuiSettings {
        ticket_provider: default_ticket_provider(),
        linear_api_token: String::new(),
        linear_workspace: String::new(),
        linear_poll_seconds: default_poll_interval(),
        right_rail_open: default_right_rail_open(),
    })
}

pub fn save_gui_settings(s: &GuiSettings) -> Result<(), String> {
    let path = gui_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
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
    load_channels_with_status(false)
}

fn channel_json_path(channel_id: &str) -> PathBuf {
    harness_root()
        .join("channels")
        .join(format!("{}.json", channel_id))
}

pub fn load_channel(channel_id: &str) -> Option<Channel> {
    load_json::<Channel>(&channel_json_path(channel_id))
}

/// Atomic write of a Channel record. Stamps `updated_at` to now before
/// persisting so every mutator doesn't have to remember to bump it.
pub fn save_channel(channel: &Channel) -> Result<(), String> {
    let mut ch = channel.clone();
    ch.updated_at = Some(chrono::Utc::now().to_rfc3339());
    let path = channel_json_path(&ch.channel_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&ch).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_channels_with_status(include_archived: bool) -> Vec<Channel> {
    let channels_dir = harness_root().join("channels");
    let mut channels = Vec::new();

    if let Ok(entries) = fs::read_dir(&channels_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Some(ch) = load_json::<Channel>(&path) {
                    if include_archived || ch.status == "active" {
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

/// Load the persisted tracked-PR snapshot for a channel.
/// Returns an empty vec when the file is missing or malformed — callers
/// treat "no file" and "no tracked rows" identically.
pub fn load_tracked_prs(channel_id: &str) -> Vec<TrackedPrRow> {
    let path = harness_root()
        .join("channels")
        .join(channel_id)
        .join("tracked-prs.json");
    load_json::<TrackedPrFile>(&path)
        .map(|f| f.rows)
        .unwrap_or_default()
}

/// Load the approval record for a run, if one has been written. Returns
/// None when no decision has been recorded.
pub fn load_approval_record(run_id: &str) -> Option<ApprovalRecord> {
    let path = harness_root()
        .join("run-artifacts")
        .join(format!("{}__approval.json", run_id));
    load_json::<ApprovalRecord>(&path)
}

/// Is this run waiting on a plan-approval decision? True when the run's
/// state is `AWAITING_APPROVAL` *and* no approval record has been written
/// yet. Matches the CLI's `rly pending-plans` semantics.
pub fn is_awaiting_approval(run: &RunIndexEntry) -> bool {
    run.state == "AWAITING_APPROVAL" && load_approval_record(&run.run_id).is_none()
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

/// Kind of path segment being validated. Used only for error messages so
/// callers can tell which input was unsafe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    /// A namespace (top-level directory under the store root).
    Namespace,
    /// An identifier (leaf filename without extension).
    Id,
}

impl SegmentKind {
    fn as_str(self) -> &'static str {
        match self {
            SegmentKind::Namespace => "ns",
            SegmentKind::Id => "id",
        }
    }
}

/// Rust mirror of `assertSafeSegment` in `src/storage/file-store.ts`. Rejects
/// path segments that could escape the store root via traversal (`..`),
/// collapse to the parent (`.`), pierce a directory boundary (`/`, `\`), or
/// trip the kernel's null-byte guard. Empty strings are also rejected because
/// they deserialize ambiguously in several of the file layouts this crate
/// reads.
///
/// Returns `Ok(())` for safe segments, `Err(String)` with a human-readable
/// message for unsafe ones. Never panics.
pub fn assert_safe_segment(segment: &str, kind: SegmentKind) -> Result<(), String> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains('/')
        || segment.contains('\\')
        || segment.contains('\0')
    {
        return Err(format!(
            "Unsafe path segment in {}: {:?}",
            kind.as_str(),
            segment
        ));
    }
    Ok(())
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

// --- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Schema-drift guards. These tests hand-write the JSON the TUI and GUI
    //! expect to see on disk. If the TS orchestrator renames, drops, or
    //! re-cases a field, the dashboards silently display nothing — these
    //! tests fail loudly instead. See `AGENTS.md` > "Cross-dashboard
    //! contract" for the why.
    use super::*;

    // --- assert_safe_segment -------------------------------------------------

    #[test]
    fn safe_segment_accepts_normal_ids() {
        for ok in [
            "channels",
            "channel-123",
            "sess_01HZ",
            "ticket.T-42",
            "run-000-aaa",
            "a",
        ] {
            assert!(
                assert_safe_segment(ok, SegmentKind::Id).is_ok(),
                "expected {:?} to be accepted",
                ok
            );
        }
    }

    #[test]
    fn safe_segment_rejects_empty() {
        let err = assert_safe_segment("", SegmentKind::Id).unwrap_err();
        assert!(err.contains("id"));
    }

    #[test]
    fn safe_segment_rejects_dot_and_dotdot() {
        assert!(assert_safe_segment(".", SegmentKind::Id).is_err());
        assert!(assert_safe_segment("..", SegmentKind::Id).is_err());
    }

    #[test]
    fn safe_segment_rejects_slashes_and_backslashes() {
        assert!(assert_safe_segment("foo/bar", SegmentKind::Id).is_err());
        assert!(assert_safe_segment("/absolute", SegmentKind::Id).is_err());
        assert!(assert_safe_segment("foo\\bar", SegmentKind::Id).is_err());
        assert!(assert_safe_segment("..\\windows", SegmentKind::Id).is_err());
    }

    #[test]
    fn safe_segment_rejects_null_byte() {
        assert!(assert_safe_segment("foo\0bar", SegmentKind::Id).is_err());
        assert!(assert_safe_segment("\0", SegmentKind::Id).is_err());
    }

    #[test]
    fn safe_segment_error_mentions_kind() {
        let ns_err = assert_safe_segment("..", SegmentKind::Namespace).unwrap_err();
        let id_err = assert_safe_segment("..", SegmentKind::Id).unwrap_err();
        assert!(ns_err.contains("ns"), "ns error was: {}", ns_err);
        assert!(id_err.contains("id"), "id error was: {}", id_err);
    }

    // --- is_active_state -----------------------------------------------------

    #[test]
    fn active_state_recognizes_known_states() {
        for s in [
            "CLASSIFYING",
            "DRAFT_PLAN",
            "TICKETS_EXECUTING",
            "TICKETS_COMPLETE",
        ] {
            assert!(is_active_state(s), "{} should be active", s);
        }
    }

    #[test]
    fn active_state_rejects_unknown_and_casing_variants() {
        assert!(!is_active_state("DONE"));
        assert!(!is_active_state(""));
        // Casing matters — orchestrator writes upper-snake-case.
        assert!(!is_active_state("classifying"));
    }

    // --- workspace / runs / ticket ledger -----------------------------------

    #[test]
    fn workspace_entry_round_trip() {
        let json = r#"{"workspaceId":"ws-1","repoPath":"/tmp/repo"}"#;
        let w: WorkspaceEntry = serde_json::from_str(json).unwrap();
        assert_eq!(w.workspace_id, "ws-1");
        assert_eq!(w.repo_path, "/tmp/repo");
        let out = serde_json::to_string(&w).unwrap();
        assert!(out.contains("\"workspaceId\":\"ws-1\""));
    }

    #[test]
    fn workspace_registry_deserializes_list() {
        let json = r#"{"workspaces":[
            {"workspaceId":"a","repoPath":"/a"},
            {"workspaceId":"b","repoPath":"/b"}
        ]}"#;
        let reg: WorkspaceRegistry = serde_json::from_str(json).unwrap();
        assert_eq!(reg.workspaces.len(), 2);
        assert_eq!(reg.workspaces[1].workspace_id, "b");
    }

    #[test]
    fn run_index_entry_handles_optional_fields() {
        let json = r#"{
            "runId":"r-1",
            "featureRequest":"do a thing",
            "state":"TICKETS_EXECUTING",
            "startedAt":"2024-01-01T00:00:00Z",
            "updatedAt":"2024-01-01T00:01:00Z"
        }"#;
        let r: RunIndexEntry = serde_json::from_str(json).unwrap();
        assert_eq!(r.run_id, "r-1");
        assert!(r.channel_id.is_none());
        assert!(r.completed_at.is_none());
    }

    #[test]
    fn runs_index_missing_runs_is_none() {
        let idx: RunsIndex = serde_json::from_str("{}").unwrap();
        assert!(idx.runs.is_none());
    }

    #[test]
    fn ticket_ledger_entry_with_assigned_alias() {
        let json = r#"{
            "ticketId":"T-1",
            "title":"do X",
            "specialty":"general",
            "status":"TODO",
            "dependsOn":["T-0"],
            "verification":"tests",
            "attempt":0,
            "assignedAlias":"ui"
        }"#;
        let t: TicketLedgerEntry = serde_json::from_str(json).unwrap();
        assert_eq!(t.ticket_id, "T-1");
        assert_eq!(t.depends_on, vec!["T-0"]);
        assert_eq!(t.assigned_alias.as_deref(), Some("ui"));
        assert!(t.assigned_agent_id.is_none());
    }

    #[test]
    fn ticket_ledger_entry_with_linear_mirror_fields() {
        let json = r#"{
            "ticketId":"linear:abc-123",
            "title":"mirrored issue",
            "specialty":"general",
            "status":"ready",
            "dependsOn":[],
            "verification":"pending",
            "attempt":0,
            "source":"linear",
            "linearIssueId":"abc-123",
            "linearIdentifier":"ENG-42",
            "linearState":"open",
            "linearUrl":"https://linear.app/acme/issue/ENG-42"
        }"#;
        let t: TicketLedgerEntry = serde_json::from_str(json).unwrap();
        assert_eq!(t.source.as_deref(), Some("linear"));
        assert_eq!(t.linear_identifier.as_deref(), Some("ENG-42"));
        assert_eq!(t.linear_state.as_deref(), Some("open"));
        assert_eq!(
            t.linear_url.as_deref(),
            Some("https://linear.app/acme/issue/ENG-42")
        );
    }

    #[test]
    fn ticket_ledger_entry_back_compat_without_linear_fields() {
        // A Relay-authored ticket written before the mirror existed must
        // still parse cleanly with all Linear fields absent.
        let json = r#"{
            "ticketId":"T-9",
            "title":"x",
            "specialty":"general",
            "status":"ready",
            "dependsOn":[],
            "verification":"pending",
            "attempt":0
        }"#;
        let t: TicketLedgerEntry = serde_json::from_str(json).unwrap();
        assert!(t.source.is_none());
        assert!(t.linear_issue_id.is_none());
        assert!(t.linear_identifier.is_none());
        assert!(t.linear_state.is_none());
        assert!(t.linear_url.is_none());
    }

    #[test]
    fn channel_with_linear_project_id() {
        let json = r#"{
            "channelId":"c-1",
            "name":"x",
            "description":"",
            "status":"active",
            "members":[],
            "pinnedRefs":[],
            "linearProjectId":"proj-uuid-abc"
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert_eq!(ch.linear_project_id.as_deref(), Some("proj-uuid-abc"));
    }

    #[test]
    fn channel_back_compat_without_linear_project_id() {
        let json = r#"{
            "channelId":"c-1",
            "name":"x",
            "description":"",
            "status":"active",
            "members":[],
            "pinnedRefs":[]
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert!(ch.linear_project_id.is_none());
    }

    #[test]
    fn channel_with_full_access_true() {
        let json = r#"{
            "channelId":"c-1",
            "name":"x",
            "description":"",
            "status":"active",
            "members":[],
            "pinnedRefs":[],
            "fullAccess":true
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert_eq!(ch.full_access, Some(true));
    }

    #[test]
    fn channel_back_compat_without_full_access() {
        // Older channel files omit `fullAccess`. Must deserialize as None
        // so consumers treating None as "off" get the safe default (AL-0).
        let json = r#"{
            "channelId":"c-1",
            "name":"x",
            "description":"",
            "status":"active",
            "members":[],
            "pinnedRefs":[]
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert!(ch.full_access.is_none());
    }

    #[test]
    fn ticket_ledger_entry_back_compat_without_assigned_alias() {
        // Old ticket files predate per-repo routing — must still parse.
        let json = r#"{
            "ticketId":"T-2",
            "title":"old ticket",
            "specialty":"general",
            "status":"DONE",
            "dependsOn":[],
            "verification":"tests",
            "attempt":3
        }"#;
        let t: TicketLedgerEntry = serde_json::from_str(json).unwrap();
        assert_eq!(t.attempt, 3);
        assert!(t.assigned_alias.is_none());
    }

    #[test]
    fn ticket_ledger_wraps_optional_tickets_vec() {
        let wrapped: TicketLedger =
            serde_json::from_str(r#"{"tickets":[]}"#).unwrap();
        assert!(wrapped.tickets.unwrap().is_empty());
        let empty: TicketLedger = serde_json::from_str("{}").unwrap();
        assert!(empty.tickets.is_none());
    }

    // --- channel / members / refs -------------------------------------------

    #[test]
    fn channel_full_round_trip() {
        let json = r#"{
            "channelId":"c-1",
            "name":"general",
            "description":"chat",
            "status":"active",
            "members":[{
                "agentId":"a-1",
                "displayName":"Claude",
                "role":"worker",
                "provider":"claude",
                "status":"online"
            }],
            "pinnedRefs":[{
                "type":"ticket",
                "targetId":"T-1",
                "label":"spec"
            }],
            "repoAssignments":[{
                "alias":"ui",
                "workspaceId":"ws-1",
                "repoPath":"/tmp/ui"
            }],
            "primaryWorkspaceId":"ws-1",
            "createdAt":"2024-01-01T00:00:00Z",
            "updatedAt":"2024-01-02T00:00:00Z"
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert_eq!(ch.channel_id, "c-1");
        assert_eq!(ch.members.len(), 1);
        assert_eq!(ch.members[0].provider, "claude");
        assert_eq!(ch.pinned_refs[0].ref_type, "ticket");
        assert_eq!(ch.repo_assignments[0].alias, "ui");
        assert_eq!(ch.primary_workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn channel_back_compat_omits_new_fields() {
        // Predates repoAssignments / primaryWorkspaceId / createdAt / updatedAt.
        let json = r#"{
            "channelId":"c-legacy",
            "name":"legacy",
            "description":"",
            "status":"active",
            "members":[],
            "pinnedRefs":[]
        }"#;
        let ch: Channel = serde_json::from_str(json).unwrap();
        assert!(ch.repo_assignments.is_empty());
        assert!(ch.primary_workspace_id.is_none());
        assert!(ch.created_at.is_none());
        assert!(ch.updated_at.is_none());
    }

    #[test]
    fn channel_ref_renames_type_field() {
        // The Rust field is `ref_type` but the JSON key is `type`. Regression
        // test: if someone drops `#[serde(rename = "type")]` every pinned ref
        // silently drops.
        let r: ChannelRef = serde_json::from_str(
            r#"{"type":"decision","targetId":"d-1","label":"L"}"#,
        )
        .unwrap();
        assert_eq!(r.ref_type, "decision");
        let out = serde_json::to_string(&r).unwrap();
        assert!(out.contains("\"type\":\"decision\""));
        // Must not accidentally emit `refType`.
        assert!(!out.contains("refType"));
    }

    // --- channel feed / agent names / decisions -----------------------------

    #[test]
    fn channel_entry_round_trip_with_metadata() {
        let json = r#"{
            "entryId":"e-1",
            "channelId":"c-1",
            "type":"message",
            "fromAgentId":"a-1",
            "fromDisplayName":"Claude",
            "content":"hello",
            "metadata":{"k":"v"},
            "createdAt":"2024-01-01T00:00:00Z"
        }"#;
        let e: ChannelEntry = serde_json::from_str(json).unwrap();
        assert_eq!(e.entry_type, "message");
        assert_eq!(e.metadata.get("k").map(String::as_str), Some("v"));
        assert_eq!(e.from_display_name.as_deref(), Some("Claude"));
    }

    #[test]
    fn channel_entry_allows_null_agent_fields() {
        // System-posted feed entries have no author.
        let json = r#"{
            "entryId":"e-2",
            "channelId":"c-1",
            "type":"system",
            "fromAgentId":null,
            "fromDisplayName":null,
            "content":"joined",
            "metadata":{},
            "createdAt":"2024-01-01T00:00:00Z"
        }"#;
        let e: ChannelEntry = serde_json::from_str(json).unwrap();
        assert!(e.from_agent_id.is_none());
        assert!(e.metadata.is_empty());
    }

    #[test]
    fn agent_name_entry_round_trip() {
        let json = r#"{
            "agentId":"a-1",
            "displayName":"Claude",
            "provider":"claude",
            "role":"worker"
        }"#;
        let a: AgentNameEntry = serde_json::from_str(json).unwrap();
        assert_eq!(a.display_name, "Claude");
        let out = serde_json::to_string(&a).unwrap();
        assert!(out.contains("\"agentId\":\"a-1\""));
    }

    #[test]
    fn decision_round_trip() {
        let json = r#"{
            "decisionId":"d-1",
            "title":"Adopt X",
            "description":"...",
            "rationale":"why",
            "alternatives":["A","B"],
            "decidedByName":"human",
            "createdAt":"2024-01-01T00:00:00Z"
        }"#;
        let d: Decision = serde_json::from_str(json).unwrap();
        assert_eq!(d.decision_id, "d-1");
        assert_eq!(d.alternatives, vec!["A", "B"]);
        assert_eq!(d.decided_by_name, "human");
    }

    #[test]
    fn channel_run_link_round_trip() {
        let json = r#"{"runId":"r-1","workspaceId":"ws-1"}"#;
        let link: ChannelRunLink = serde_json::from_str(json).unwrap();
        assert_eq!(link.run_id, "r-1");
        assert_eq!(link.workspace_id, "ws-1");
    }

    // --- config -------------------------------------------------------------

    #[test]
    fn harness_config_defaults_empty_project_dirs() {
        let c: HarnessConfig = serde_json::from_str("{}").unwrap();
        assert!(c.project_dirs.is_empty());
    }

    #[test]
    fn harness_config_parses_list() {
        let c: HarnessConfig = serde_json::from_str(
            r#"{"projectDirs":["~/code","/abs"]}"#,
        )
        .unwrap();
        assert_eq!(c.project_dirs, vec!["~/code", "/abs"]);
    }

    // --- chat sessions ------------------------------------------------------

    #[test]
    fn chat_session_round_trip_with_claude_ids() {
        let json = r#"{
            "sessionId":"sess-1",
            "title":"t",
            "createdAt":"2024-01-01T00:00:00Z",
            "updatedAt":"2024-01-01T00:01:00Z",
            "messageCount":3,
            "claudeSessionIds":{"ui":"claude-abc"}
        }"#;
        let s: ChatSession = serde_json::from_str(json).unwrap();
        assert_eq!(s.session_id, "sess-1");
        assert_eq!(s.message_count, 3);
        assert_eq!(
            s.claude_session_ids.get("ui").map(String::as_str),
            Some("claude-abc")
        );
    }

    #[test]
    fn chat_session_back_compat_without_claude_ids() {
        let json = r#"{
            "sessionId":"sess-1",
            "title":"t",
            "createdAt":"2024-01-01T00:00:00Z",
            "updatedAt":"2024-01-01T00:00:00Z",
            "messageCount":0
        }"#;
        let s: ChatSession = serde_json::from_str(json).unwrap();
        assert!(s.claude_session_ids.is_empty());
    }

    #[test]
    fn persisted_chat_message_with_metadata() {
        let json = r#"{
            "role":"user",
            "content":"hi",
            "timestamp":"2024-01-01T00:00:00Z",
            "agentAlias":null,
            "metadata":{"rewindKey":"abc"}
        }"#;
        let m: PersistedChatMessage = serde_json::from_str(json).unwrap();
        assert_eq!(m.role, "user");
        assert_eq!(m.metadata.get("rewindKey").map(String::as_str), Some("abc"));
    }

    #[test]
    fn persisted_chat_message_omits_metadata_when_empty_on_serialize() {
        // `skip_serializing_if = "HashMap::is_empty"` keeps JSONL transcripts
        // small on disk. If someone flips that, older readers start pulling
        // a field they don't expect. Guard against a drive-by change.
        let m = PersistedChatMessage {
            role: "assistant".into(),
            content: "hello".into(),
            timestamp: "2024-01-01T00:00:00Z".into(),
            agent_alias: Some("ui".into()),
            metadata: HashMap::new(),
        };
        let out = serde_json::to_string(&m).unwrap();
        assert!(!out.contains("metadata"), "unexpected metadata in: {}", out);
        assert!(out.contains("\"agentAlias\":\"ui\""));
    }

    #[test]
    fn persisted_chat_message_back_compat_without_metadata() {
        let json = r#"{
            "role":"assistant",
            "content":"ok",
            "timestamp":"2024-01-01T00:00:00Z",
            "agentAlias":"ui"
        }"#;
        let m: PersistedChatMessage = serde_json::from_str(json).unwrap();
        assert!(m.metadata.is_empty());
    }

    // --- negative: drift detector ------------------------------------------

    #[test]
    fn channel_rejects_snake_case_keys() {
        // If the TS side accidentally starts writing snake_case (or someone
        // drops `#[serde(rename_all = "camelCase")]`), this fails so the
        // dashboards don't silently go blank.
        let json = r#"{
            "channel_id":"c-1",
            "name":"x",
            "description":"",
            "status":"active",
            "members":[],
            "pinned_refs":[]
        }"#;
        let res: Result<Channel, _> = serde_json::from_str(json);
        assert!(res.is_err(), "expected snake_case to be rejected");
    }
}
