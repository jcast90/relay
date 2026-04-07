use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// --- Workspace Registry ---

#[derive(Debug, Deserialize)]
pub struct WorkspaceRegistry {
    pub workspaces: Vec<WorkspaceEntry>,
}

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Deserialize, Clone)]
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
}

// --- Channel ---

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub channel_id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub members: Vec<ChannelMember>,
    pub pinned_refs: Vec<ChannelRef>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMember {
    pub agent_id: String,
    pub display_name: String,
    pub role: String,
    pub provider: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRef {
    #[serde(rename = "type")]
    pub ref_type: String,
    pub target_id: String,
    pub label: String,
}

// --- Channel Feed Entry ---

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentNameEntry {
    pub agent_id: String,
    pub display_name: String,
    pub provider: String,
    pub role: String,
}

// --- Decision ---

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRunLink {
    pub run_id: String,
    pub workspace_id: String,
}

// --- Data Loading ---

pub fn harness_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".agent-harness")
}

pub fn load_workspaces() -> Vec<WorkspaceEntry> {
    let path = harness_root().join("workspace-registry.json");
    load_json::<WorkspaceRegistry>(&path)
        .map(|r| r.workspaces)
        .unwrap_or_default()
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
