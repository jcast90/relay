mod ui;

use harness_data as data;

use crossterm::{
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::prelude::*;
use std::collections::HashMap;
use std::io::stdout;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use data::*;

/// Resolve the Relay CLI binary path (env: RELAY_BIN or legacy AGENT_HARNESS_BIN; default "rly")
fn cli_bin() -> String {
    std::env::var("RELAY_BIN")
        .or_else(|_| std::env::var("AGENT_HARNESS_BIN"))
        .unwrap_or_else(|_| "rly".to_string())
}

/// Call the Relay CLI with given args and parse JSON output.
/// Returns None if the command fails or output isn't valid JSON.
fn cli_json(args: &[&str]) -> Option<serde_json::Value> {
    let output = Command::new(cli_bin())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).ok()
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FocusPanel {
    Sidebar,
    Center,
    Right,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    Chat,
    Board,
    Decisions,
}

#[derive(Clone, Copy, PartialEq)]
pub enum InputMode {
    Normal,
    Input,
    NewChannel,
    /// Multi-step channel creation: selecting repos after naming
    RepoSelect,
    /// Browsing chat session history
    SessionSelect,
}

#[derive(Clone, Debug)]
pub struct ActiveRun {
    pub run_id: String,
    pub state: String,
    pub feature_request: String,
    pub workspace: String,
}

// --- Chat types ---

#[derive(Clone, Debug, PartialEq)]
pub enum ChatRole {
    User,
    Assistant,
    System,
    /// Inline tool-use activity indicator (e.g. "Reading src/foo.ts")
    Activity,
}

impl ChatRole {
    pub fn as_str(&self) -> &str {
        match self {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::System => "system",
            ChatRole::Activity => "activity",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "user" => ChatRole::User,
            "assistant" => ChatRole::Assistant,
            "system" => ChatRole::System,
            "activity" => ChatRole::Activity,
            _ => ChatRole::System,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    pub timestamp: String,
    /// Which repo agent produced/received this message (alias like "ui", "be")
    /// None = general/orchestrator context
    pub agent_alias: Option<String>,
}

impl ChatMessage {
    fn from_persisted(p: &data::PersistedChatMessage) -> Self {
        ChatMessage {
            role: ChatRole::from_str(&p.role),
            content: p.content.clone(),
            timestamp: p.timestamp.clone(),
            agent_alias: p.agent_alias.clone(),
        }
    }
}

/// Stacked activity tracker per agent — keeps the last N activities
#[derive(Clone, Debug)]
pub struct ActivityStack {
    pub entries: Vec<(String, String)>, // (activity_description, timestamp)
    pub agent_alias: Option<String>,
}

/// Item for the @ completion popup
#[derive(Clone, Debug)]
pub struct CompletionItem {
    pub label: String,      // display text
    pub insert: String,     // text to insert (e.g. "@ui ")
    pub kind: CompletionKind,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CompletionKind {
    Repo,
    Agent,
    Channel,
}

// --- Per-repo worker ---

enum WorkerCommand {
    SendMessage(String),
}

enum WorkerEvent {
    Chunk(String),
    Activity(String),
    Done(Option<String>),
    Error(String),
    /// Claude CLI session ID captured (for --resume support)
    ClaudeSessionId(String),
}

/// A Claude worker session bound to a specific repo directory
#[allow(dead_code)]
struct RepoWorker {
    pub alias: String,
    pub repo_path: String,
    pub tx: mpsc::Sender<WorkerCommand>,
    pub rx: mpsc::Receiver<WorkerEvent>,
    pub streaming: bool,
}

/// Stores the pixel-rect of each panel so mouse clicks can resolve focus.
#[derive(Default, Clone)]
pub struct LayoutRegions {
    pub sidebar: Rect,
    pub center: Rect,
    pub right: Rect,
    pub input: Rect,
}

/// Text selection state scoped to a specific panel.
/// Positions are stored as content-relative (line_index, col) so they
/// track the text itself rather than screen pixels — scrolling moves
/// the highlight with the content.
#[derive(Clone, Debug, Default)]
pub struct TextSelection {
    /// Whether a selection is currently active (mouse is being dragged)
    pub selecting: bool,
    /// Start position as (content_line_index, col_within_inner)
    pub start: (usize, usize),
    /// End position as (content_line_index, col_within_inner)
    pub end: (usize, usize),
    /// Which panel this selection belongs to
    pub panel: Option<FocusPanel>,
    /// The full rendered text lines for the panel (captured during draw for copy)
    pub rendered_lines: Vec<String>,
    /// The panel's inner area (excluding borders) set during draw
    pub inner_area: Rect,
}

/// State for the repo-selection popup during channel creation or editing
#[derive(Clone)]
pub struct RepoSelectState {
    pub channel_name: String,
    pub available_repos: Vec<WorkspaceEntry>,
    pub selected: Vec<bool>,
    pub cursor: usize,
    /// Alias inputs for each selected repo
    pub aliases: Vec<String>,
    /// Which step: picking repos or assigning aliases
    pub step: RepoSelectStep,
    pub alias_cursor: usize,
    pub alias_input_cursor: usize,
    /// If Some, we're editing repos on an existing channel (not creating new)
    pub editing_channel_id: Option<String>,
    /// Scroll offset for the repo list
    pub scroll_offset: usize,
    /// Search/filter string (type / to start filtering)
    pub filter: String,
    /// Whether the filter input is active
    pub filtering: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum RepoSelectStep {
    Picking,
    Aliasing,
}

pub struct App {
    pub channels: Vec<Channel>,
    pub selected_channel: usize,
    pub feed: Vec<ChannelEntry>,
    pub tickets: Vec<TicketLedgerEntry>,
    pub active_runs: Vec<ActiveRun>,
    pub agents: Vec<AgentNameEntry>,
    pub decisions: Vec<Decision>,
    pub active_tab: Tab,
    pub should_quit: bool,

    // Focus
    pub focus: FocusPanel,

    // Scroll positions for center panel content
    pub chat_scroll: usize,
    pub board_scroll: usize,
    pub decisions_scroll: usize,

    // Right panel scroll
    pub runs_scroll: usize,

    // Detail popup
    pub show_detail: bool,
    pub detail_scroll: usize,

    // Input mode
    pub input_mode: InputMode,
    pub input_buffer: String,
    pub input_cursor: usize,

    // Chat with Claude
    pub chat_messages: Vec<ChatMessage>,
    pub chat_streaming: bool,

    // Per-repo workers: alias -> worker
    workers: HashMap<String, RepoWorker>,
    /// Which worker alias is currently targeted (None = general)
    pub active_worker_alias: Option<String>,

    // Fallback general worker (no --cwd, for channels with no repos)
    general_worker_tx: mpsc::Sender<WorkerCommand>,
    general_worker_rx: mpsc::Receiver<WorkerEvent>,

    // Auto-approval for claude permissions
    pub auto_approve: bool,

    // Layout regions for mouse hit-testing
    pub layout: LayoutRegions,

    // Total rendered line count for chat (set during draw)
    pub chat_total_lines: usize,

    // Repo selection state for channel creation
    pub repo_select: Option<RepoSelectState>,

    // Mouse capture toggle — when false, terminal handles native text selection
    pub mouse_captured: bool,

    // Per-panel text selection
    pub selection: TextSelection,

    // Activity stacks per agent alias (None key = general)
    pub activity_stacks: HashMap<Option<String>, ActivityStack>,
    /// Whether to show all activities or just the condensed top-3
    pub activity_expanded: bool,

    // @ completion popup state
    pub completion_items: Vec<CompletionItem>,
    pub completion_visible: bool,
    pub completion_cursor: usize,
    /// The position in input_buffer where @ was typed
    pub completion_anchor: usize,

    // Chat sessions
    pub active_session: Option<data::ChatSession>,
    pub session_list: Vec<data::ChatSession>,
    pub session_cursor: usize,
}

impl App {
    fn new(
        general_tx: mpsc::Sender<WorkerCommand>,
        general_rx: mpsc::Receiver<WorkerEvent>,
        auto_approve: bool,
    ) -> Self {
        Self {
            channels: Vec::new(),
            selected_channel: 0,
            feed: Vec::new(),
            tickets: Vec::new(),
            active_runs: Vec::new(),
            agents: Vec::new(),
            decisions: Vec::new(),
            active_tab: Tab::Chat,
            should_quit: false,
            focus: FocusPanel::Center,
            chat_scroll: 0,
            board_scroll: 0,
            decisions_scroll: 0,
            runs_scroll: 0,
            show_detail: false,
            detail_scroll: 0,
            input_mode: InputMode::Normal,
            input_buffer: String::new(),
            input_cursor: 0,
            chat_messages: Vec::new(),
            chat_streaming: false,
            workers: HashMap::new(),
            active_worker_alias: None,
            general_worker_tx: general_tx,
            general_worker_rx: general_rx,
            auto_approve,
            layout: LayoutRegions::default(),
            chat_total_lines: 0,
            repo_select: None,
            mouse_captured: true,
            selection: TextSelection::default(),
            activity_stacks: HashMap::new(),
            activity_expanded: false,
            completion_items: Vec::new(),
            completion_visible: false,
            completion_cursor: 0,
            completion_anchor: 0,
            active_session: None,
            session_list: Vec::new(),
            session_cursor: 0,
        }
    }

    /// Get the current channel ID if one is selected
    fn current_channel_id(&self) -> Option<String> {
        self.channels.get(self.selected_channel).map(|ch| ch.channel_id.clone())
    }

    /// Archive (soft-delete) the currently selected channel via CLI
    fn delete_current_channel(&mut self) {
        let ch = match self.channels.get(self.selected_channel) {
            Some(c) => c,
            None => return,
        };

        cli_json(&["channel", "archive", &ch.channel_id, "--json"]);

        // Drop workers for this channel
        self.workers.clear();
        self.active_worker_alias = None;

        // Refresh — archived channel will be filtered out
        self.refresh();
        if self.selected_channel >= self.channels.len() && self.selected_channel > 0 {
            self.selected_channel -= 1;
        }
        self.load_chat_for_channel();
        self.respawn_workers_with_session();
    }

    /// Load chat history from the active session for the current channel.
    /// Also handles legacy migration and auto-loads the most recent session.
    fn load_chat_for_channel(&mut self) {
        self.chat_messages.clear();
        self.activity_stacks.clear();
        self.active_session = None;

        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };

        // Migrate old chat.jsonl if present
        migrate_legacy_chat(&ch_id);

        // Load session list
        self.session_list = load_sessions(&ch_id);

        // Auto-load the most recent session (first in the sorted list)
        if let Some(session) = self.session_list.first().cloned() {
            self.activate_session(&ch_id, session);
        }
    }

    /// Switch to a specific session, loading its messages
    fn activate_session(&mut self, channel_id: &str, session: data::ChatSession) {
        self.chat_messages.clear();
        self.activity_stacks.clear();

        let persisted = load_session_chat(channel_id, &session.session_id, 500);
        for p in &persisted {
            self.chat_messages.push(ChatMessage::from_persisted(p));
        }
        self.active_session = Some(session);
        self.chat_scroll = usize::MAX;
    }

    /// Start a new chat session for the current channel via CLI
    fn new_session(&mut self) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };

        // Create session via CLI
        if let Some(json) = cli_json(&["session", "create", "--channel", &ch_id, "--title", "New conversation"]) {
            if let Ok(session) = serde_json::from_value::<data::ChatSession>(json) {
                self.chat_messages.clear();
                self.activity_stacks.clear();
                self.active_session = Some(session);
                self.session_list = load_sessions(&ch_id);
            }
        }

        // Reset workers to start fresh Claude sessions (no --resume)
        self.reset_workers_for_new_session();
    }

    /// Kill and respawn all workers so they start fresh (no --resume)
    fn reset_workers_for_new_session(&mut self) {
        // Drop existing workers (their threads will exit when sender drops)
        self.workers.clear();
        self.active_worker_alias = None;

        // Respawn general worker
        let ch_id = self.channels.get(self.selected_channel).map(|c| c.channel_id.as_str());
        let (general_tx, general_rx) = spawn_claude_worker(self.auto_approve, None, ch_id);
        self.general_worker_tx = general_tx;
        self.general_worker_rx = general_rx;

        // Respawn per-repo workers for current channel
        self.ensure_workers_for_channel();
    }

    /// Respawn all workers using --resume session IDs from the active session.
    /// Called on startup after session data has been loaded.
    fn respawn_workers_with_session(&mut self) {
        self.workers.clear();
        self.active_worker_alias = None;

        let ch_id = self.current_channel_id();
        let resume_sid = self.active_session.as_ref()
            .and_then(|s| s.claude_session_ids.get("_general"))
            .cloned();

        let (general_tx, general_rx) = spawn_claude_worker_with_session(
            self.auto_approve,
            None,
            resume_sid.as_deref(),
            None,
            ch_id.as_deref(),
        );
        self.general_worker_tx = general_tx;
        self.general_worker_rx = general_rx;

        self.ensure_workers_for_channel();
    }

    /// Persist a chat message to the active session via CLI
    fn persist_message(&mut self, msg: &ChatMessage) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };

        // Auto-create a session if none active
        if self.active_session.is_none() {
            let title = if msg.role == ChatRole::User {
                truncate_str(&msg.content, 60)
            } else {
                "New conversation".to_string()
            };
            if let Some(json) = cli_json(&["session", "create", "--channel", &ch_id, "--title", &title]) {
                if let Ok(session) = serde_json::from_value::<data::ChatSession>(json) {
                    self.active_session = Some(session);
                    self.session_list = load_sessions(&ch_id);
                }
            }
        }

        if let Some(ref mut session) = self.active_session {
            let role = msg.role.as_str();
            let alias_args: Vec<String> = msg.agent_alias.as_ref()
                .map(|a| vec!["--alias".to_string(), a.clone()])
                .unwrap_or_default();

            let mut args: Vec<String> = vec![
                "session".into(), "append".into(),
                "--channel".into(), ch_id.clone(),
                "--session".into(), session.session_id.clone(),
                "--role".into(), role.to_string(),
            ];
            args.extend(alias_args);
            args.push(msg.content.clone());

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            cli_json(&arg_refs);

            session.message_count += 1;
            session.updated_at = chrono::Utc::now().to_rfc3339();

            // Update title from first user message if still default
            if session.title == "New conversation" && msg.role == ChatRole::User {
                session.title = truncate_str(&msg.content, 60);
            }
        }
    }

    /// Update the last persisted message (for completed streaming) via CLI
    fn persist_update_last(&self, msg: &ChatMessage) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };
        if let Some(ref session) = self.active_session {
            let mut args: Vec<String> = vec![
                "session".into(), "update-last".into(),
                "--channel".into(), ch_id,
                "--session".into(), session.session_id.clone(),
                "--role".into(), msg.role.as_str().to_string(),
            ];
            if let Some(ref alias) = msg.agent_alias {
                args.push("--alias".into());
                args.push(alias.clone());
            }
            args.push(msg.content.clone());

            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            cli_json(&arg_refs);
        }
    }

    /// Store a Claude CLI session ID for a worker alias via CLI
    fn store_claude_session_id(&mut self, alias: &str, claude_sid: &str) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };
        if let Some(ref mut session) = self.active_session {
            session.claude_session_ids.insert(alias.to_string(), claude_sid.to_string());
            cli_json(&[
                "session", "update-claude-sid",
                "--channel", &ch_id,
                "--session", &session.session_id,
                "--alias", alias,
                "--sid", claude_sid,
            ]);
        }
    }

    fn refresh(&mut self) {
        self.channels = load_channels();
        self.agents = load_agent_names();

        let selected = self.channels.get(self.selected_channel);

        if let Some(ch) = selected {
            self.feed = load_channel_feed(&ch.channel_id, 200);
            self.decisions = load_channel_decisions(&ch.channel_id);

            self.tickets.clear();
            // Load tickets from orchestrator runs
            let run_links = load_channel_run_links(&ch.channel_id);
            for link in &run_links {
                let tickets = load_ticket_ledger(&link.workspace_id, &link.run_id);
                self.tickets.extend(tickets);
            }
            // Load channel-local tickets (created via chat)
            let chat_tickets = load_channel_tickets(&ch.channel_id);
            self.tickets.extend(chat_tickets);
        } else {
            self.feed.clear();
            self.tickets.clear();
            self.decisions.clear();
        }

        self.active_runs.clear();
        let mut seen_run_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for ws in load_workspaces() {
            for run in load_runs_for_workspace(&ws.workspace_id) {
                // Skip runs that have completed_at set — they finished (or crashed) even if state wasn't updated
                let truly_active = is_active_state(&run.state) && run.completed_at.is_none();
                if truly_active && seen_run_ids.insert(run.run_id.clone()) {
                    self.active_runs.push(ActiveRun {
                        run_id: run.run_id,
                        state: run.state,
                        feature_request: run.feature_request,
                        workspace: ws
                            .repo_path
                            .split('/')
                            .last()
                            .unwrap_or(&ws.workspace_id)
                            .to_string(),
                    });
                }
            }
        }

        // Clamp scroll positions after data refresh
        self.clamp_scrolls();
    }

    /// Ensure per-repo workers exist for the currently selected channel's repos.
    /// Called when switching channels or after creating a channel with repos.
    /// If a session is active with stored Claude session IDs, workers resume those sessions.
    fn ensure_workers_for_channel(&mut self) {
        let repos = match self.channels.get(self.selected_channel) {
            Some(ch) => ch.repo_assignments.clone(),
            None => return,
        };

        let claude_sids = self.active_session
            .as_ref()
            .map(|s| s.claude_session_ids.clone())
            .unwrap_or_default();

        for repo in &repos {
            if self.workers.contains_key(&repo.alias) {
                continue;
            }
            let resume_sid = claude_sids.get(&repo.alias).map(|s| s.as_str());
            let ch_id = self.channels.get(self.selected_channel).map(|c| c.channel_id.as_str());
            let (tx, rx) = spawn_claude_worker_with_session(
                self.auto_approve,
                Some(&repo.repo_path),
                resume_sid,
                Some(&repo.alias),
                ch_id,
            );
            self.workers.insert(
                repo.alias.clone(),
                RepoWorker {
                    alias: repo.alias.clone(),
                    repo_path: repo.repo_path.clone(),
                    tx,
                    rx,
                    streaming: false,
                },
            );
        }

        // Don't auto-select a worker — user picks one explicitly with @alias.
        // Messages without @alias go to the general worker.
    }

    /// Get the list of repo aliases for the current channel
    pub fn current_repo_aliases(&self) -> Vec<String> {
        self.channels
            .get(self.selected_channel)
            .map(|ch| ch.repo_assignments.iter().map(|r| r.alias.clone()).collect())
            .unwrap_or_default()
    }

    /// Get the repo assignments for the current channel
    pub fn current_repo_assignments(&self) -> Vec<RepoAssignment> {
        self.channels
            .get(self.selected_channel)
            .map(|ch| ch.repo_assignments.clone())
            .unwrap_or_default()
    }

    /// Drain any pending events from ALL workers
    fn drain_worker_events(&mut self) {
        // Drain general worker
        while let Ok(event) = self.general_worker_rx.try_recv() {
            self.handle_worker_event(event, None);
        }

        // Drain per-repo workers
        let aliases: Vec<String> = self.workers.keys().cloned().collect();
        for alias in &aliases {
            let events: Vec<WorkerEvent> = {
                if let Some(worker) = self.workers.get(alias) {
                    let mut evts = Vec::new();
                    while let Ok(evt) = worker.rx.try_recv() {
                        evts.push(evt);
                    }
                    evts
                } else {
                    Vec::new()
                }
            };
            for evt in events {
                self.handle_worker_event(evt, Some(alias.clone()));
            }
        }
    }

    fn handle_worker_event(&mut self, event: WorkerEvent, alias: Option<String>) {
        match event {
            WorkerEvent::Chunk(text) => {
                // Remove the activity stack message for this alias if present
                if let Some(last) = self.chat_messages.last() {
                    if last.role == ChatRole::Activity && last.agent_alias == alias {
                        self.chat_messages.pop();
                    }
                }

                // Find or create assistant message for this alias
                let needs_new = match self.chat_messages.last() {
                    Some(m) => m.role != ChatRole::Assistant || m.agent_alias != alias,
                    None => true,
                };
                if needs_new {
                    let msg = ChatMessage {
                        role: ChatRole::Assistant,
                        content: String::new(),
                        timestamp: now_time(),
                        agent_alias: alias.clone(),
                    };
                    self.persist_message(&msg);
                    self.chat_messages.push(msg);
                }
                if let Some(last) = self.chat_messages.last_mut() {
                    last.content.push_str(&text);
                }
                self.chat_scroll = usize::MAX;
                self.chat_streaming = true;
            }
            WorkerEvent::Activity(desc) => {
                use data::tool_activity::{ACTIVITY_STACK_MAX, ACTIVITY_TOP_N};
                let now = now_time();
                // Cap BEFORE appending so a burst of tool_use blocks can't spike
                // the stack past the limit even for a single frame (mirrors the
                // fix being shipped in OSS-02 / gap #12).
                let stack = self.activity_stacks
                    .entry(alias.clone())
                    .or_insert_with(|| ActivityStack {
                        entries: Vec::new(),
                        agent_alias: alias.clone(),
                    });
                while stack.entries.len() >= ACTIVITY_STACK_MAX {
                    stack.entries.remove(0);
                }
                stack.entries.push((desc.clone(), now.clone()));

                // Remove previous activity message for this alias if it's the last message
                if let Some(last) = self.chat_messages.last() {
                    if last.role == ChatRole::Activity && last.agent_alias == alias {
                        self.chat_messages.pop();
                    }
                    // Also remove empty assistant message
                    if let Some(last2) = self.chat_messages.last() {
                        if last2.role == ChatRole::Assistant && last2.content.is_empty() {
                            self.chat_messages.pop();
                        }
                    }
                }

                // Build stacked activity content. Top-N newest visible (most
                // recent last — natural reading order), each prefixed with a
                // wall-clock timestamp so the user can see how fast tool calls
                // are firing. Matches the GUI's stacked card layout.
                let stack = self.activity_stacks.get(&alias).unwrap();
                let top_n = if self.activity_expanded { stack.entries.len() } else { ACTIVITY_TOP_N };
                let total = stack.entries.len();
                let start = total.saturating_sub(top_n);
                let mut lines: Vec<String> = Vec::with_capacity(top_n + 2);

                // First line is the header-adjacent status ("N actions · thinking")
                // so the UI layer always has something to pair with the alias
                // badge, mirroring the GUI's `stream-status` span.
                let action_label = if total == 1 { "action" } else { "actions" };
                lines.push(format!(
                    "{} {} · {}",
                    total,
                    action_label,
                    if self.chat_streaming { "writing response" } else { "thinking" },
                ));

                for (d, ts) in &stack.entries[start..] {
                    lines.push(format!("[{}] {}", ts, d));
                }
                let hidden = total.saturating_sub(top_n);
                if hidden > 0 {
                    lines.push(format!("  +{} more", hidden));
                }
                if let Some((_, last_ts)) = stack.entries.last() {
                    lines.push(format!("last update {}", last_ts));
                }

                self.chat_messages.push(ChatMessage {
                    role: ChatRole::Activity,
                    content: lines.join("\n"),
                    timestamp: now,
                    agent_alias: alias.clone(),
                });
                self.chat_scroll = usize::MAX;
            }
            WorkerEvent::Done(_session_id) => {
                // Clear activity stack for this alias
                self.activity_stacks.remove(&alias);

                // Remove trailing activity message
                if let Some(last) = self.chat_messages.last() {
                    if last.role == ChatRole::Activity && last.agent_alias == alias {
                        self.chat_messages.pop();
                    }
                }

                if let Some(last) = self.chat_messages.last_mut() {
                    if last.role == ChatRole::Assistant {
                        let trimmed = last.content.trim().to_string();
                        last.content = trimmed;
                    }
                }
                // Persist the final assistant message
                if let Some(last) = self.chat_messages.last() {
                    if last.role == ChatRole::Assistant && !last.content.is_empty() {
                        self.persist_update_last(last);
                    }
                }
                if let Some(last) = self.chat_messages.last() {
                    if last.role == ChatRole::Assistant && last.content.is_empty() {
                        self.chat_messages.pop();
                    }
                }
                // Mark the specific worker as not streaming
                if let Some(ref a) = alias {
                    if let Some(w) = self.workers.get_mut(a) {
                        w.streaming = false;
                    }
                }
                // Check if any worker is still streaming
                self.chat_streaming = self.workers.values().any(|w| w.streaming);
            }
            WorkerEvent::Error(e) => {
                let msg = ChatMessage {
                    role: ChatRole::System,
                    content: format!("Error: {}", e),
                    timestamp: now_time(),
                    agent_alias: alias.clone(),
                };
                self.persist_message(&msg);
                self.chat_messages.push(msg);
                if let Some(ref a) = alias {
                    if let Some(w) = self.workers.get_mut(a) {
                        w.streaming = false;
                    }
                }
                self.chat_streaming = self.workers.values().any(|w| w.streaming);
            }
            WorkerEvent::ClaudeSessionId(sid) => {
                let worker_alias = alias.unwrap_or_else(|| "_general".to_string());
                self.store_claude_session_id(&worker_alias, &sid);
            }
        }
    }

    fn clamp_scrolls(&mut self) {
        // chat_scroll is clamped during draw (line-based)
        if !self.tickets.is_empty() {
            self.board_scroll = self.board_scroll.min(self.tickets.len() - 1);
        } else {
            self.board_scroll = 0;
        }
        if !self.decisions.is_empty() {
            self.decisions_scroll = self.decisions_scroll.min(self.decisions.len() - 1);
        } else {
            self.decisions_scroll = 0;
        }
        if !self.active_runs.is_empty() {
            self.runs_scroll = self.runs_scroll.min(self.active_runs.len() - 1);
        } else {
            self.runs_scroll = 0;
        }
    }

    fn center_item_count(&self) -> usize {
        match self.active_tab {
            Tab::Chat => self.chat_messages.len(),
            Tab::Board => self.sorted_ticket_indices().len(),
            Tab::Decisions => self.decisions.len(),
        }
    }

    fn center_scroll(&self) -> usize {
        match self.active_tab {
            Tab::Chat => self.chat_scroll,
            Tab::Board => self.board_scroll,
            Tab::Decisions => self.decisions_scroll,
        }
    }

    fn set_center_scroll(&mut self, val: usize) {
        match self.active_tab {
            Tab::Chat => self.chat_scroll = val,
            Tab::Board => self.board_scroll = val,
            Tab::Decisions => self.decisions_scroll = val,
        }
    }

    pub fn sorted_ticket_indices(&self) -> Vec<usize> {
        let status_order = [
            "executing", "verifying", "ready", "blocked", "pending", "retry", "completed", "failed",
        ];
        let mut indices: Vec<usize> = (0..self.tickets.len()).collect();
        indices.sort_by(|&a, &b| {
            let a_pos = status_order
                .iter()
                .position(|s| *s == self.tickets[a].status)
                .unwrap_or(99);
            let b_pos = status_order
                .iter()
                .position(|s| *s == self.tickets[b].status)
                .unwrap_or(99);
            a_pos.cmp(&b_pos)
        });
        indices
    }

    fn handle_mouse(&mut self, event: MouseEvent) {
        if self.show_detail || self.input_mode == InputMode::NewChannel || self.input_mode == InputMode::RepoSelect || self.input_mode == InputMode::SessionSelect {
            return;
        }

        let col = event.column;
        let row = event.row;

        match event.kind {
            MouseEventKind::ScrollDown => {
                let panel = self.panel_at(col, row);
                match panel {
                    Some(FocusPanel::Sidebar) => {
                        if self.selected_channel < self.channels.len().saturating_sub(1) {
                            self.selected_channel += 1;
                            self.refresh();
                            self.ensure_workers_for_channel();
                            self.load_chat_for_channel();
                        }
                    }
                    Some(FocusPanel::Center) => {
                        match self.active_tab {
                            Tab::Chat => {
                                self.chat_scroll = self.chat_scroll.saturating_add(3);
                            }
                            Tab::Board => {
                                let count = self.sorted_ticket_indices().len();
                                if self.board_scroll < count.saturating_sub(1) {
                                    self.board_scroll = (self.board_scroll + 1).min(count.saturating_sub(1));
                                }
                            }
                            Tab::Decisions => {
                                if self.decisions_scroll < self.decisions.len().saturating_sub(1) {
                                    self.decisions_scroll += 1;
                                }
                            }
                        }
                    }
                    Some(FocusPanel::Right) => {
                        if self.runs_scroll < self.active_runs.len().saturating_sub(1) {
                            self.runs_scroll += 1;
                        }
                    }
                    None => {}
                }
                // Extend selection downward if actively selecting while scrolling
                if self.selection.selecting && self.selection.panel.is_some() {
                    self.selection.end.0 = self.selection.end.0.saturating_add(3);
                }
            }
            MouseEventKind::ScrollUp => {
                let panel = self.panel_at(col, row);
                match panel {
                    Some(FocusPanel::Sidebar) => {
                        if self.selected_channel > 0 {
                            self.selected_channel -= 1;
                            self.refresh();
                            self.ensure_workers_for_channel();
                            self.load_chat_for_channel();
                        }
                    }
                    Some(FocusPanel::Center) => {
                        match self.active_tab {
                            Tab::Chat => {
                                self.chat_scroll = self.chat_scroll.saturating_sub(3);
                            }
                            Tab::Board => {
                                self.board_scroll = self.board_scroll.saturating_sub(1);
                            }
                            Tab::Decisions => {
                                self.decisions_scroll = self.decisions_scroll.saturating_sub(1);
                            }
                        }
                    }
                    Some(FocusPanel::Right) => {
                        self.runs_scroll = self.runs_scroll.saturating_sub(1);
                    }
                    None => {}
                }
                // Extend selection upward if actively selecting while scrolling
                if self.selection.selecting && self.selection.panel.is_some() {
                    self.selection.end.0 = self.selection.end.0.saturating_sub(3);
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if self.layout.input.contains(Position::new(col, row)) {
                    self.input_mode = InputMode::Input;
                    self.active_tab = Tab::Chat;
                    return;
                }

                if let Some(panel) = self.panel_at(col, row) {
                    self.focus = panel;

                    // Start text selection — convert screen coords to content coords
                    let content_pos = self.screen_to_content(panel, row, col);
                    self.selection = TextSelection {
                        selecting: true,
                        start: content_pos,
                        end: content_pos,
                        panel: Some(panel),
                        rendered_lines: Vec::new(),
                        inner_area: Rect::default(),
                    };
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.selection.selecting {
                    if let Some(panel) = self.selection.panel {
                        let area = match panel {
                            FocusPanel::Sidebar => self.layout.sidebar,
                            FocusPanel::Center => self.layout.center,
                            FocusPanel::Right => self.layout.right,
                        };
                        let clamped_col = col.clamp(area.x, area.x + area.width.saturating_sub(1));
                        let clamped_row = row.clamp(area.y, area.y + area.height.saturating_sub(1));
                        self.selection.end = self.screen_to_content(panel, clamped_row, clamped_col);
                    }
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self.selection.selecting {
                    self.selection.selecting = false;
                    if self.selection.start != self.selection.end {
                        self.copy_selection_to_clipboard();
                    }
                }
            }
            _ => {}
        }
    }

    /// Convert screen (row, col) to content-relative (line_index, col_within_inner).
    /// Accounts for scroll offset and panel border insets.
    fn screen_to_content(&self, panel: FocusPanel, screen_row: u16, screen_col: u16) -> (usize, usize) {
        let area = match panel {
            FocusPanel::Sidebar => self.layout.sidebar,
            FocusPanel::Center => self.layout.center,
            FocusPanel::Right => self.layout.right,
        };
        // Inner area is area minus 1px border on each side
        let inner_y = area.y + 1;
        let inner_x = area.x + 1;

        let scroll_offset = match panel {
            FocusPanel::Center => self.center_scroll(),
            FocusPanel::Right => self.runs_scroll,
            FocusPanel::Sidebar => self.selected_channel, // sidebar doesn't really scroll the same way
        };

        let visible_row = screen_row.saturating_sub(inner_y) as usize;
        let content_line = visible_row + scroll_offset;
        let col = screen_col.saturating_sub(inner_x) as usize;
        (content_line, col)
    }

    /// Extract selected text from rendered lines and copy to system clipboard
    fn copy_selection_to_clipboard(&self) {
        let sel = &self.selection;
        if sel.rendered_lines.is_empty() {
            return;
        }

        // Normalize so start <= end
        let (start_line, start_col, end_line, end_col) = if sel.start.0 < sel.end.0
            || (sel.start.0 == sel.end.0 && sel.start.1 <= sel.end.1)
        {
            (sel.start.0, sel.start.1, sel.end.0, sel.end.1)
        } else {
            (sel.end.0, sel.end.1, sel.start.0, sel.start.1)
        };

        let mut selected_text = String::new();

        for (i, line) in sel.rendered_lines.iter().enumerate() {
            if i < start_line || i > end_line {
                continue;
            }

            let chars: Vec<char> = line.chars().collect();
            let line_start = if i == start_line { start_col } else { 0 };
            let line_end = if i == end_line {
                (end_col + 1).min(chars.len())
            } else {
                chars.len()
            };

            if line_start < chars.len() {
                let end = line_end.min(chars.len());
                let slice: String = chars[line_start..end].iter().collect();
                selected_text.push_str(slice.trim_end());
            }

            if i < end_line {
                selected_text.push('\n');
            }
        }

        if !selected_text.is_empty() {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(selected_text);
            }
        }
    }

    /// Handle a bracketed paste event — insert multi-line text into the input buffer.
    /// Newlines are preserved so the user can paste code blocks and long text.
    fn handle_paste(&mut self, text: String) {
        // Auto-enter input mode if not already
        if self.input_mode != InputMode::Input {
            self.input_mode = InputMode::Input;
            self.active_tab = Tab::Chat;
        }

        // Sanitize: strip control chars except newlines/tabs, cap total buffer size
        let clean: String = text
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();

        // Cap total buffer at 32KB to prevent rendering issues with huge pastes
        let max_buf: usize = 32_768;
        let remaining_capacity = max_buf.saturating_sub(self.input_buffer.len());
        let to_insert: &str = if clean.len() > remaining_capacity {
            // Take up to remaining capacity at a char boundary
            match clean.char_indices().take_while(|(i, _)| *i < remaining_capacity).last() {
                Some((i, c)) => &clean[..i + c.len_utf8()],
                None => "",
            }
        } else {
            &clean
        };

        if !to_insert.is_empty() {
            // Ensure input_cursor is at a valid char boundary
            let cursor = self.input_cursor.min(self.input_buffer.len());
            // Find nearest char boundary at or before cursor
            let safe_cursor = self.input_buffer[..cursor]
                .char_indices()
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);

            self.input_buffer.insert_str(safe_cursor, to_insert);
            self.input_cursor = safe_cursor + to_insert.len();
        }

        self.update_completion();
    }

    fn panel_at(&self, col: u16, row: u16) -> Option<FocusPanel> {
        let pos = Position::new(col, row);
        if self.layout.sidebar.contains(pos) {
            Some(FocusPanel::Sidebar)
        } else if self.layout.center.contains(pos) {
            Some(FocusPanel::Center)
        } else if self.layout.right.contains(pos) {
            Some(FocusPanel::Right)
        } else {
            None
        }
    }

    fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) {
        // Session selection popup
        if self.input_mode == InputMode::SessionSelect {
            self.handle_session_select_key(code);
            return;
        }

        // Repo selection popup
        if self.input_mode == InputMode::RepoSelect {
            self.handle_repo_select_key(code);
            return;
        }

        // Input mode handling (chat input)
        if self.input_mode == InputMode::Input {
            let ctrl = modifiers.contains(KeyModifiers::CONTROL);

            // Handle completion popup keys first
            if self.completion_visible {
                match code {
                    KeyCode::Tab | KeyCode::Enter => {
                        self.accept_completion();
                        return;
                    }
                    KeyCode::Down => {
                        if self.completion_cursor < self.completion_items.len().saturating_sub(1) {
                            self.completion_cursor += 1;
                        }
                        return;
                    }
                    KeyCode::Up => {
                        if self.completion_cursor > 0 {
                            self.completion_cursor -= 1;
                        }
                        return;
                    }
                    KeyCode::Esc => {
                        self.completion_visible = false;
                        return;
                    }
                    _ => {
                        // Fall through to normal input handling, then update completion
                    }
                }
            }

            match code {
                KeyCode::Esc => {
                    self.input_mode = InputMode::Normal;
                    self.input_buffer.clear();
                    self.input_cursor = 0;
                    self.completion_visible = false;
                }
                KeyCode::Enter => {
                    if !self.input_buffer.trim().is_empty() {
                        self.send_message();
                    }
                    self.input_mode = InputMode::Normal;
                    self.input_buffer.clear();
                    self.input_cursor = 0;
                    self.completion_visible = false;
                }
                // Ctrl-A: beginning of line
                KeyCode::Char('a') if ctrl => {
                    self.input_cursor = 0;
                }
                // Ctrl-E: end of line
                KeyCode::Char('e') if ctrl => {
                    self.input_cursor = self.input_buffer.len();
                }
                // Ctrl-U: kill to beginning of line
                KeyCode::Char('u') if ctrl => {
                    self.input_buffer.drain(..self.input_cursor);
                    self.input_cursor = 0;
                }
                // Ctrl-K: kill to end of line
                KeyCode::Char('k') if ctrl => {
                    self.input_buffer.truncate(self.input_cursor);
                }
                // Ctrl-W: delete word backward
                KeyCode::Char('w') if ctrl => {
                    if self.input_cursor > 0 {
                        let before = &self.input_buffer[..self.input_cursor];
                        let trimmed = before.trim_end();
                        // rfind(' ') returns a byte index — ' ' is 1 byte so the +1 is safe
                        let new_end = trimmed.rfind(' ').map(|i| i + 1).unwrap_or(0);
                        self.input_buffer.drain(new_end..self.input_cursor);
                        self.input_cursor = new_end;
                    }
                }
                // Ctrl-B: back one character
                KeyCode::Char('b') if ctrl => {
                    if self.input_cursor > 0 {
                        self.input_cursor = self.input_buffer[..self.input_cursor]
                            .char_indices()
                            .last()
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                    }
                }
                // Ctrl-F: forward one character
                KeyCode::Char('f') if ctrl => {
                    if self.input_cursor < self.input_buffer.len() {
                        self.input_cursor = self.input_buffer[self.input_cursor..]
                            .char_indices()
                            .nth(1)
                            .map(|(i, _)| self.input_cursor + i)
                            .unwrap_or(self.input_buffer.len());
                    }
                }
                KeyCode::Backspace => {
                    if self.input_cursor > 0 {
                        let prev = self.input_buffer[..self.input_cursor]
                            .char_indices()
                            .last()
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                        self.input_buffer.drain(prev..self.input_cursor);
                        self.input_cursor = prev;
                    }
                }
                KeyCode::Delete => {
                    if self.input_cursor < self.input_buffer.len() {
                        let next = self.input_buffer[self.input_cursor..]
                            .char_indices()
                            .nth(1)
                            .map(|(i, _)| self.input_cursor + i)
                            .unwrap_or(self.input_buffer.len());
                        self.input_buffer.drain(self.input_cursor..next);
                    }
                }
                KeyCode::Left => {
                    if self.input_cursor > 0 {
                        self.input_cursor = self.input_buffer[..self.input_cursor]
                            .char_indices()
                            .last()
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                    }
                }
                KeyCode::Right => {
                    if self.input_cursor < self.input_buffer.len() {
                        self.input_cursor = self.input_buffer[self.input_cursor..]
                            .char_indices()
                            .nth(1)
                            .map(|(i, _)| self.input_cursor + i)
                            .unwrap_or(self.input_buffer.len());
                    }
                }
                KeyCode::Home => self.input_cursor = 0,
                KeyCode::End => self.input_cursor = self.input_buffer.len(),
                KeyCode::Char(c) => {
                    self.input_buffer.insert(self.input_cursor, c);
                    self.input_cursor += c.len_utf8();
                }
                _ => {}
            }

            // After any keypress in input mode, update completion popup
            self.update_completion();

            return;
        }

        // New channel input mode
        if self.input_mode == InputMode::NewChannel {
            match code {
                KeyCode::Esc => {
                    self.input_mode = InputMode::Normal;
                    self.input_buffer.clear();
                    self.input_cursor = 0;
                }
                KeyCode::Enter => {
                    if !self.input_buffer.trim().is_empty() {
                        // Transition to repo selection step
                        let channel_name = self.input_buffer.trim().to_string();
                        let available_repos = load_workspaces();
                        let count = available_repos.len();
                        self.repo_select = Some(RepoSelectState {
                            channel_name,
                            available_repos,
                            selected: vec![false; count],
                            cursor: 0,
                            aliases: Vec::new(),
                            step: RepoSelectStep::Picking,
                            alias_cursor: 0,
                            alias_input_cursor: 0,
                            editing_channel_id: None,
                            scroll_offset: 0,
                            filter: String::new(),
                            filtering: false,
                        });
                        self.input_mode = InputMode::RepoSelect;
                        self.input_buffer.clear();
                        self.input_cursor = 0;
                    }
                }
                KeyCode::Backspace => {
                    if self.input_cursor > 0 {
                        self.input_buffer.remove(self.input_cursor - 1);
                        self.input_cursor -= 1;
                    }
                }
                KeyCode::Delete => {
                    if self.input_cursor < self.input_buffer.len() {
                        self.input_buffer.remove(self.input_cursor);
                    }
                }
                KeyCode::Left => {
                    if self.input_cursor > 0 {
                        self.input_cursor -= 1;
                    }
                }
                KeyCode::Right => {
                    if self.input_cursor < self.input_buffer.len() {
                        self.input_cursor += 1;
                    }
                }
                KeyCode::Char(c) => {
                    self.input_buffer.insert(self.input_cursor, c);
                    self.input_cursor += 1;
                }
                _ => {}
            }
            return;
        }

        // Detail popup mode
        if self.show_detail {
            match code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                    self.show_detail = false;
                    self.detail_scroll = 0;
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    self.detail_scroll = self.detail_scroll.saturating_add(1);
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    self.detail_scroll = self.detail_scroll.saturating_sub(1);
                }
                _ => {}
            }
            return;
        }

        // Normal mode
        match code {
            KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,
            KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
                self.should_quit = true;
            }

            // Panel focus
            KeyCode::Char('h') | KeyCode::Left => {
                self.focus = match self.focus {
                    FocusPanel::Right => FocusPanel::Center,
                    FocusPanel::Center => FocusPanel::Sidebar,
                    FocusPanel::Sidebar => FocusPanel::Sidebar,
                };
            }
            KeyCode::Char('l') | KeyCode::Right => {
                self.focus = match self.focus {
                    FocusPanel::Sidebar => FocusPanel::Center,
                    FocusPanel::Center => FocusPanel::Right,
                    FocusPanel::Right => FocusPanel::Right,
                };
            }

            // Vertical navigation
            KeyCode::Char('j') | KeyCode::Down => self.navigate_down(),
            KeyCode::Char('k') | KeyCode::Up => self.navigate_up(),

            // Tab switching
            KeyCode::Tab => {
                self.active_tab = match self.active_tab {
                    Tab::Chat => Tab::Board,
                    Tab::Board => Tab::Decisions,
                    Tab::Decisions => Tab::Chat,
                };
            }
            KeyCode::BackTab => {
                self.active_tab = match self.active_tab {
                    Tab::Chat => Tab::Decisions,
                    Tab::Board => Tab::Chat,
                    Tab::Decisions => Tab::Board,
                };
            }
            KeyCode::Char('1') => self.active_tab = Tab::Chat,
            KeyCode::Char('2') => self.active_tab = Tab::Board,
            KeyCode::Char('3') => self.active_tab = Tab::Decisions,

            // Open detail
            KeyCode::Enter => self.open_detail(),

            // Chat input mode
            KeyCode::Char('i') | KeyCode::Char('/') => {
                self.input_mode = InputMode::Input;
                self.active_tab = Tab::Chat;
            }

            // New channel
            KeyCode::Char('n') => {
                self.input_mode = InputMode::NewChannel;
            }

            // Add/edit repos on current channel
            KeyCode::Char('r') => {
                self.open_repo_editor();
            }

            // Session history
            KeyCode::Char('s') => {
                self.open_session_picker();
            }

            // Delete channel
            KeyCode::Char('d') => {
                if self.focus == FocusPanel::Sidebar {
                    self.delete_current_channel();
                }
            }

            // Toggle mouse capture (m = release mouse for text selection)
            KeyCode::Char('m') => {
                self.mouse_captured = !self.mouse_captured;
                if self.mouse_captured {
                    let _ = stdout().execute(EnableMouseCapture);
                } else {
                    let _ = stdout().execute(DisableMouseCapture);
                }
            }

            // Page navigation
            KeyCode::Char('g') => self.jump_to_top(),
            KeyCode::Char('G') => self.jump_to_bottom(),

            _ => {}
        }
    }

    fn handle_repo_select_key(&mut self, code: KeyCode) {
        let state = match self.repo_select.as_mut() {
            Some(s) => s,
            None => return,
        };

        match state.step {
            RepoSelectStep::Picking => {
                // If filtering is active, handle text input
                if state.filtering {
                    match code {
                        KeyCode::Esc => {
                            state.filtering = false;
                            state.filter.clear();
                            state.cursor = 0;
                            state.scroll_offset = 0;
                        }
                        KeyCode::Enter => {
                            state.filtering = false;
                            // Keep filter applied, cursor stays where it is
                        }
                        KeyCode::Backspace => {
                            state.filter.pop();
                            state.cursor = 0;
                            state.scroll_offset = 0;
                        }
                        KeyCode::Char(c) => {
                            state.filter.push(c);
                            state.cursor = 0;
                            state.scroll_offset = 0;
                        }
                        _ => {}
                    }
                    return;
                }

                // Get filtered indices for navigation
                let filter_lower = state.filter.to_lowercase();
                let filtered_indices: Vec<usize> = state.available_repos.iter().enumerate()
                    .filter(|(_, ws)| {
                        filter_lower.is_empty() || {
                            let name = ws.repo_path.split('/').last().unwrap_or(&ws.workspace_id);
                            name.to_lowercase().contains(&filter_lower)
                                || ws.repo_path.to_lowercase().contains(&filter_lower)
                        }
                    })
                    .map(|(i, _)| i)
                    .collect();
                let filtered_count = filtered_indices.len();

                match code {
                    KeyCode::Esc => {
                        if !state.filter.is_empty() {
                            // First Esc clears filter
                            state.filter.clear();
                            state.cursor = 0;
                            state.scroll_offset = 0;
                        } else {
                            self.repo_select = None;
                            self.input_mode = InputMode::Normal;
                        }
                    }
                    KeyCode::Char('/') => {
                        state.filtering = true;
                    }
                    KeyCode::Char('j') | KeyCode::Down => {
                        if state.cursor < filtered_count.saturating_sub(1) {
                            state.cursor += 1;
                            // Keep cursor in viewport (assume ~14 visible lines)
                            let viewport = 14usize;
                            if state.cursor >= state.scroll_offset + viewport {
                                state.scroll_offset = state.cursor.saturating_sub(viewport.saturating_sub(1));
                            }
                        }
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        if state.cursor > 0 {
                            state.cursor -= 1;
                            if state.cursor < state.scroll_offset {
                                state.scroll_offset = state.cursor;
                            }
                        }
                    }
                    KeyCode::Char(' ') => {
                        // Toggle selection on the real repo index
                        if let Some(&real_idx) = filtered_indices.get(state.cursor) {
                            if real_idx < state.selected.len() {
                                state.selected[real_idx] = !state.selected[real_idx];
                            }
                        }
                    }
                    KeyCode::Enter => {
                        // Move to alias step if any repos selected, otherwise create without repos
                        let any_selected = state.selected.iter().any(|&s| s);
                        if any_selected {
                            // Pre-fill aliases from repo dir names
                            let aliases: Vec<String> = state
                                .available_repos
                                .iter()
                                .zip(state.selected.iter())
                                .filter(|(_, &sel)| sel)
                                .map(|(ws, _)| {
                                    ws.repo_path
                                        .split('/')
                                        .last()
                                        .unwrap_or(&ws.workspace_id)
                                        .to_string()
                                })
                                .collect();
                            state.aliases = aliases;
                            state.alias_cursor = 0;
                            state.alias_input_cursor = state.aliases.first().map(|a| a.len()).unwrap_or(0);
                            state.step = RepoSelectStep::Aliasing;
                        } else {
                            // Create channel with no repos
                            self.finalize_channel_creation();
                        }
                    }
                    _ => {}
                }
            }
            RepoSelectStep::Aliasing => {
                match code {
                    KeyCode::Esc => {
                        // Go back to picking
                        state.step = RepoSelectStep::Picking;
                    }
                    KeyCode::Down | KeyCode::Tab => {
                        if state.alias_cursor < state.aliases.len().saturating_sub(1) {
                            state.alias_cursor += 1;
                            state.alias_input_cursor = state.aliases[state.alias_cursor].len();
                        }
                    }
                    KeyCode::Up | KeyCode::BackTab => {
                        if state.alias_cursor > 0 {
                            state.alias_cursor -= 1;
                            state.alias_input_cursor = state.aliases[state.alias_cursor].len();
                        }
                    }
                    KeyCode::Enter => {
                        self.finalize_channel_creation();
                    }
                    KeyCode::Backspace => {
                        if let Some(alias) = state.aliases.get_mut(state.alias_cursor) {
                            if state.alias_input_cursor > 0 {
                                alias.remove(state.alias_input_cursor - 1);
                                state.alias_input_cursor -= 1;
                            }
                        }
                    }
                    KeyCode::Left => {
                        if state.alias_input_cursor > 0 {
                            state.alias_input_cursor -= 1;
                        }
                    }
                    KeyCode::Right => {
                        if let Some(alias) = state.aliases.get(state.alias_cursor) {
                            if state.alias_input_cursor < alias.len() {
                                state.alias_input_cursor += 1;
                            }
                        }
                    }
                    KeyCode::Char(c) => {
                        if let Some(alias) = state.aliases.get_mut(state.alias_cursor) {
                            alias.insert(state.alias_input_cursor, c);
                            state.alias_input_cursor += 1;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn finalize_channel_creation(&mut self) {
        let state = match self.repo_select.take() {
            Some(s) => s,
            None => return,
        };

        // Build repo assignments string: alias:workspaceId:repoPath,...
        let selected_repos: Vec<&WorkspaceEntry> = state
            .available_repos
            .iter()
            .zip(state.selected.iter())
            .filter(|(_, &sel)| sel)
            .map(|(ws, _)| ws)
            .collect();

        let repos_arg: String = selected_repos
            .iter()
            .enumerate()
            .map(|(i, ws)| {
                let alias = state
                    .aliases
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| {
                        ws.repo_path.split('/').last().unwrap_or(&ws.workspace_id).to_string()
                    });
                format!("{}:{}:{}", alias, ws.workspace_id, ws.repo_path)
            })
            .collect::<Vec<_>>()
            .join(",");

        if let Some(existing_id) = state.editing_channel_id {
            // --- Editing repos on an existing channel via CLI ---
            let mut args = vec!["channel", "update", &existing_id, "--json"];
            if !repos_arg.is_empty() {
                args.push("--repos");
                args.push(&repos_arg);
            }
            cli_json(&args);
        } else {
            // --- Creating a new channel via CLI ---
            let name = &state.channel_name;
            let mut args = vec!["channel", "create", name, name, "--json"];
            if !repos_arg.is_empty() {
                args.push("--repos");
                args.push(&repos_arg);
            }
            let result = cli_json(&args);

            // Select the newly created channel after refresh
            self.input_mode = InputMode::Normal;
            self.refresh();
            if let Some(channel_id) = result.and_then(|v| v.get("channelId").and_then(|id| id.as_str()).map(|s| s.to_string())) {
                if let Some(idx) = self.channels.iter().position(|c| c.channel_id == channel_id) {
                    self.selected_channel = idx;
                    self.refresh();
                }
            }
            self.ensure_workers_for_channel();
            self.load_chat_for_channel();
            return;
        }

        self.input_mode = InputMode::Normal;
        self.refresh();
        self.ensure_workers_for_channel();
    }

    fn navigate_down(&mut self) {
        match self.focus {
            FocusPanel::Sidebar => {
                if self.selected_channel < self.channels.len().saturating_sub(1) {
                    self.selected_channel += 1;
                    self.refresh();
                    self.ensure_workers_for_channel();
                    self.load_chat_for_channel();
                }
            }
            FocusPanel::Center => {
                match self.active_tab {
                    Tab::Chat => {
                        self.chat_scroll = self.chat_scroll.saturating_add(1);
                    }
                    _ => {
                        let count = self.center_item_count();
                        let scroll = self.center_scroll();
                        if scroll < count.saturating_sub(1) {
                            self.set_center_scroll(scroll + 1);
                        }
                    }
                }
            }
            FocusPanel::Right => {
                if self.runs_scroll < self.active_runs.len().saturating_sub(1) {
                    self.runs_scroll += 1;
                }
            }
        }
    }

    fn navigate_up(&mut self) {
        match self.focus {
            FocusPanel::Sidebar => {
                if self.selected_channel > 0 {
                    self.selected_channel -= 1;
                    self.refresh();
                    self.ensure_workers_for_channel();
                    self.load_chat_for_channel();
                }
            }
            FocusPanel::Center => {
                match self.active_tab {
                    Tab::Chat => {
                        self.chat_scroll = self.chat_scroll.saturating_sub(1);
                    }
                    _ => {
                        let scroll = self.center_scroll();
                        if scroll > 0 {
                            self.set_center_scroll(scroll - 1);
                        }
                    }
                }
            }
            FocusPanel::Right => {
                if self.runs_scroll > 0 {
                    self.runs_scroll -= 1;
                }
            }
        }
    }

    fn jump_to_top(&mut self) {
        match self.focus {
            FocusPanel::Sidebar => self.selected_channel = 0,
            FocusPanel::Center => self.set_center_scroll(0),
            FocusPanel::Right => self.runs_scroll = 0,
        }
    }

    fn jump_to_bottom(&mut self) {
        match self.focus {
            FocusPanel::Sidebar => {
                self.selected_channel = self.channels.len().saturating_sub(1);
            }
            FocusPanel::Center => {
                match self.active_tab {
                    Tab::Chat => {
                        self.chat_scroll = usize::MAX;
                    }
                    _ => {
                        let count = self.center_item_count();
                        self.set_center_scroll(count.saturating_sub(1));
                    }
                }
            }
            FocusPanel::Right => {
                self.runs_scroll = self.active_runs.len().saturating_sub(1);
            }
        }
    }

    fn open_detail(&mut self) {
        let has_item = match self.focus {
            FocusPanel::Sidebar => !self.channels.is_empty(),
            FocusPanel::Center => self.center_item_count() > 0,
            FocusPanel::Right => !self.active_runs.is_empty(),
        };
        if has_item {
            self.show_detail = true;
            self.detail_scroll = 0;
        }
    }

    fn open_repo_editor(&mut self) {
        if self.channels.is_empty() {
            return;
        }

        let ch = &self.channels[self.selected_channel];
        let available_repos = load_workspaces();

        // Pre-select repos that are already assigned
        let selected: Vec<bool> = available_repos
            .iter()
            .map(|ws| {
                ch.repo_assignments
                    .iter()
                    .any(|r| r.workspace_id == ws.workspace_id)
            })
            .collect();

        // Pre-fill aliases for already-assigned repos
        let mut aliases: Vec<String> = Vec::new();
        for ws in &available_repos {
            if let Some(existing) = ch.repo_assignments.iter().find(|r| r.workspace_id == ws.workspace_id) {
                aliases.push(existing.alias.clone());
            }
        }

        let channel_id = ch.channel_id.clone();
        self.repo_select = Some(RepoSelectState {
            channel_name: ch.name.clone(),
            available_repos,
            selected,
            cursor: 0,
            aliases,
            step: RepoSelectStep::Picking,
            alias_cursor: 0,
            alias_input_cursor: 0,
            editing_channel_id: Some(channel_id),
            scroll_offset: 0,
            filter: String::new(),
            filtering: false,
        });
        self.input_mode = InputMode::RepoSelect;
    }

    fn open_session_picker(&mut self) {
        if let Some(ch_id) = self.current_channel_id() {
            // Ensure migration has happened
            migrate_legacy_chat(&ch_id);
            self.session_list = load_sessions(&ch_id);
            self.session_cursor = 0;
            // Highlight the active session
            if let Some(ref active) = self.active_session {
                if let Some(pos) = self.session_list.iter().position(|s| s.session_id == active.session_id) {
                    self.session_cursor = pos;
                }
            }
            self.input_mode = InputMode::SessionSelect;
        }
    }

    fn handle_session_select_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.input_mode = InputMode::Normal;
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if self.session_cursor < self.session_list.len().saturating_sub(1) {
                    self.session_cursor += 1;
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.session_cursor > 0 {
                    self.session_cursor -= 1;
                }
            }
            KeyCode::Enter => {
                // Activate selected session
                if let Some(session) = self.session_list.get(self.session_cursor).cloned() {
                    if let Some(ch_id) = self.current_channel_id() {
                        self.activate_session(&ch_id, session);
                        // Reset workers to use the session's Claude session IDs
                        self.workers.clear();
                        self.active_worker_alias = None;
                        let (general_tx, general_rx) = {
                            let sid = self.active_session.as_ref()
                                .and_then(|s| s.claude_session_ids.get("_general"))
                                .map(|s| s.as_str());
                            spawn_claude_worker_with_session(self.auto_approve, None, sid, None, Some(&ch_id))
                        };
                        self.general_worker_tx = general_tx;
                        self.general_worker_rx = general_rx;
                        self.ensure_workers_for_channel();
                    }
                    self.input_mode = InputMode::Normal;
                    self.active_tab = Tab::Chat;
                }
            }
            KeyCode::Char('n') => {
                // Create new session
                self.new_session();
                self.input_mode = InputMode::Normal;
                self.active_tab = Tab::Chat;
            }
            KeyCode::Char('d') => {
                // Delete selected session (but not the active one) via CLI
                if let Some(session) = self.session_list.get(self.session_cursor) {
                    let is_active = self.active_session.as_ref()
                        .map(|a| a.session_id == session.session_id)
                        .unwrap_or(false);
                    if !is_active {
                        if let Some(ch_id) = self.current_channel_id() {
                            let sid = session.session_id.clone();
                            cli_json(&["session", "delete", "--channel", &ch_id, "--session", &sid]);
                            self.session_list.retain(|s| s.session_id != sid);
                            if self.session_cursor >= self.session_list.len() && self.session_cursor > 0 {
                                self.session_cursor -= 1;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn send_message(&mut self) {
        let msg = self.input_buffer.trim().to_string();
        if msg.is_empty() {
            return;
        }

        // Dismiss completion popup
        self.completion_visible = false;

        // Parse @alias prefix to route to a specific repo agent
        let (target_alias, actual_msg) = parse_agent_prefix(&msg, &self.current_repo_aliases());

        // Resolve #channel references — inject referenced channel context
        let msg_with_context = self.resolve_channel_refs(&actual_msg);

        let resolved_alias = target_alias.or_else(|| self.active_worker_alias.clone());

        // Add user message to chat (show original, not the expanded version)
        let user_msg = ChatMessage {
            role: ChatRole::User,
            content: actual_msg.clone(),
            timestamp: now_time(),
            agent_alias: resolved_alias.clone(),
        };
        self.persist_message(&user_msg);
        self.chat_messages.push(user_msg);

        // Add empty assistant message (will be persisted when first chunk arrives)
        self.chat_messages.push(ChatMessage {
            role: ChatRole::Assistant,
            content: String::new(),
            timestamp: now_time(),
            agent_alias: resolved_alias.clone(),
        });

        self.chat_streaming = true;
        self.active_tab = Tab::Chat;
        self.chat_scroll = usize::MAX;

        // Route to the correct worker (send the context-expanded version)
        if let Some(ref alias) = resolved_alias {
            if let Some(worker) = self.workers.get_mut(alias) {
                worker.streaming = true;
                let _ = worker.tx.send(WorkerCommand::SendMessage(msg_with_context));
                return;
            }
        }

        // Fallback to general worker
        let _ = self.general_worker_tx.send(WorkerCommand::SendMessage(msg_with_context));
    }

    /// Resolve #channel-name references in a message.
    /// For each match, appends a context block with that channel's recent chat history.
    /// Resolve #channel references via CLI — returns message with context appended
    fn resolve_channel_refs(&self, msg: &str) -> String {
        // Quick check: does the message even contain a # reference?
        if !msg.contains('#') {
            return msg.to_string();
        }

        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return msg.to_string(),
        };

        if let Some(json) = cli_json(&["chat", "resolve-refs", "--channel", &ch_id, msg]) {
            if let Some(resolved) = json.get("resolved").and_then(|v| v.as_str()) {
                return resolved.to_string();
            }
        }

        msg.to_string()
    }

    /// Build completion items for the @ popup
    fn build_completion_items(&self, filter: &str) -> Vec<CompletionItem> {
        let mut items = Vec::new();
        let filter_lower = filter.to_lowercase();

        // Repo aliases
        for repo in self.current_repo_assignments() {
            if filter.is_empty() || repo.alias.to_lowercase().contains(&filter_lower) {
                let repo_short = repo.repo_path.split('/').last().unwrap_or(&repo.alias);
                items.push(CompletionItem {
                    label: format!("@{} — {}", repo.alias, repo_short),
                    insert: format!("@{} ", repo.alias),
                    kind: CompletionKind::Repo,
                });
            }
        }

        // Registered agents
        for agent in &self.agents {
            if filter.is_empty() || agent.display_name.to_lowercase().contains(&filter_lower) {
                items.push(CompletionItem {
                    label: format!("@{} [{}]", agent.display_name, agent.provider),
                    insert: format!("@{} ", agent.display_name),
                    kind: CompletionKind::Agent,
                });
            }
        }

        items
    }

    fn build_channel_completion_items(&self, filter: &str) -> Vec<CompletionItem> {
        let mut items = Vec::new();
        let filter_lower = filter.to_lowercase();

        for ch in &self.channels {
            if filter.is_empty() || ch.name.to_lowercase().contains(&filter_lower) {
                items.push(CompletionItem {
                    label: format!("#{}", ch.name),
                    insert: format!("#{} ", ch.name),
                    kind: CompletionKind::Channel,
                });
            }
        }

        items
    }

    /// Update the completion popup based on current input
    fn update_completion(&mut self) {
        let buf = &self.input_buffer;
        let cursor = self.input_cursor.min(buf.len());

        let before_cursor = &buf[..cursor];

        // Check for @ mentions (repos, agents)
        if let Some(at_pos) = before_cursor.rfind('@') {
            let fragment = &before_cursor[at_pos + 1..];
            if !fragment.contains(' ') {
                self.completion_anchor = at_pos;
                let items = self.build_completion_items(fragment);
                if !items.is_empty() {
                    self.completion_items = items;
                    self.completion_visible = true;
                    self.completion_cursor = 0;
                    return;
                }
            }
        }

        // Check for # channel references
        if let Some(hash_pos) = before_cursor.rfind('#') {
            let fragment = &before_cursor[hash_pos + 1..];
            if !fragment.contains(' ') {
                self.completion_anchor = hash_pos;
                let items = self.build_channel_completion_items(fragment);
                if !items.is_empty() {
                    self.completion_items = items;
                    self.completion_visible = true;
                    self.completion_cursor = 0;
                    return;
                }
            }
        }

        self.completion_visible = false;
    }

    /// Accept the currently selected completion item
    fn accept_completion(&mut self) {
        if !self.completion_visible || self.completion_items.is_empty() {
            return;
        }
        let item = self.completion_items[self.completion_cursor].clone();
        // Replace from anchor to cursor with the insert text
        let after = self.input_buffer[self.input_cursor..].to_string();
        self.input_buffer.truncate(self.completion_anchor);
        self.input_buffer.push_str(&item.insert);
        self.input_cursor = self.input_buffer.len();
        self.input_buffer.push_str(&after);
        self.completion_visible = false;
    }

    /// Check if a specific repo worker is currently streaming
    pub fn is_worker_streaming(&self, alias: &str) -> bool {
        self.workers.get(alias).map(|w| w.streaming).unwrap_or(false)
    }
}

/// Parse @alias prefix from a message.
/// Returns (Some(alias), rest_of_message) if found, or (None, original) if not.
fn parse_agent_prefix(msg: &str, known_aliases: &[String]) -> (Option<String>, String) {
    let trimmed = msg.trim();
    if !trimmed.starts_with('@') {
        return (None, msg.to_string());
    }

    // Extract the word after @
    let rest = &trimmed[1..];
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let candidate = &rest[..end];

    // Check if it matches a known alias
    if let Some(alias) = known_aliases.iter().find(|a| a.as_str() == candidate) {
        let message = rest[end..].trim().to_string();
        (Some(alias.clone()), message)
    } else {
        (None, msg.to_string())
    }
}


fn now_time() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

fn truncate_str(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    let char_count = trimmed.chars().count();
    if char_count <= max {
        trimmed.to_string()
    } else {
        let take = max.saturating_sub(3);
        let end: String = trimmed.chars().take(take).collect();
        format!("{}...", end)
    }
}

/// Spawn a background worker thread for a Claude CLI session.
/// If `cwd` is Some, the claude process runs in that directory.
/// If `resume_session_id` is Some, the first message will resume that Claude session.
fn spawn_claude_worker(
    auto_approve: bool,
    cwd: Option<&str>,
    channel_id: Option<&str>,
) -> (mpsc::Sender<WorkerCommand>, mpsc::Receiver<WorkerEvent>) {
    spawn_claude_worker_with_session(auto_approve, cwd, None, None, channel_id)
}

/// Find the MCP config file via CLI
fn find_mcp_config(cwd: Option<&str>) -> Option<String> {
    let mut args = vec!["chat", "mcp-config"];
    let repo_arg;
    if let Some(dir) = cwd {
        repo_arg = format!("{}", dir);
        args.push("--repo");
        args.push(&repo_arg);
    }

    cli_json(&args)
        .and_then(|json| json.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()))
}

fn spawn_claude_worker_with_session(
    auto_approve: bool,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
    repo_alias: Option<&str>,
    channel_id: Option<&str>,
) -> (mpsc::Sender<WorkerCommand>, mpsc::Receiver<WorkerEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCommand>();
    let (evt_tx, evt_rx) = mpsc::channel::<WorkerEvent>();

    let cwd_owned = cwd.map(|s| s.to_string());
    let initial_session_id = resume_session_id.map(|s| s.to_string());
    let repo_alias_owned = repo_alias.map(|s| s.to_string());
    let channel_id_owned = channel_id.map(|s| s.to_string());
    let mcp_config = find_mcp_config(cwd);

    thread::spawn(move || {
        let mut session_id: Option<String> = initial_session_id;
        let claude_bin = std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());

        while let Ok(WorkerCommand::SendMessage(msg)) = cmd_rx.recv() {
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
            ];

            if auto_approve {
                args.push("--dangerously-skip-permissions".to_string());
            }

            // Attach MCP config so Claude has access to harness tools
            if let Some(ref mcp_path) = mcp_config {
                args.push("--mcp-config".to_string());
                args.push(mcp_path.clone());
            }

            // Build system prompt via CLI
            if let Some(ref ch_id) = channel_id_owned {
                let mut prompt_args: Vec<String> = vec![
                    "chat".into(), "system-prompt".into(),
                    "--channel".into(), ch_id.clone(),
                ];
                if let Some(ref dir) = cwd_owned {
                    prompt_args.push("--repo".into());
                    prompt_args.push(dir.clone());
                }
                if let Some(ref alias) = repo_alias_owned {
                    prompt_args.push("--alias".into());
                    prompt_args.push(alias.clone());
                }
                let prompt_arg_refs: Vec<&str> = prompt_args.iter().map(|s| s.as_str()).collect();
                if let Some(json) = cli_json(&prompt_arg_refs) {
                    if let Some(prompt) = json.get("prompt").and_then(|v| v.as_str()) {
                        args.push("--append-system-prompt".to_string());
                        args.push(prompt.to_string());
                    }
                }
            } else if let (Some(ref alias), Some(ref dir)) = (&repo_alias_owned, &cwd_owned) {
                // No channel — still add basic repo context
                let repo_name = dir.rsplit('/').next().unwrap_or(dir);
                args.push("--append-system-prompt".to_string());
                args.push(format!(
                    "You are working in the '{}' repository (alias: @{}) at: {}. \
                     Your working directory is already set to this repo.",
                    repo_name, alias, dir
                ));
            }

            if let Some(ref id) = session_id {
                args.push("--resume".to_string());
                args.push(id.clone());
            }

            args.push(msg);

            let mut cmd = Command::new(&claude_bin);
            cmd.args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            // Set working directory if specified
            if let Some(ref dir) = cwd_owned {
                cmd.current_dir(dir);
            }

            let child = cmd.spawn();

            match child {
                Ok(mut child) => {
                    let stdout = child.stdout.take().unwrap();
                    let reader = BufReader::new(stdout);
                    let mut got_assistant_text = false;

                    for line in reader.lines() {
                        match line {
                            Ok(line) if line.is_empty() => continue,
                            Ok(line) => {
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line)
                                {
                                    match json.get("type").and_then(|t| t.as_str()) {
                                        Some("assistant") => {
                                            if let Some(content) = json
                                                .pointer("/message/content")
                                                .and_then(|c| c.as_array())
                                            {
                                                for block in content {
                                                    let block_type = block.get("type").and_then(|t| t.as_str());
                                                    match block_type {
                                                        Some("text") => {
                                                            if let Some(text) = block
                                                                .get("text")
                                                                .and_then(|v| v.as_str())
                                                            {
                                                                if !text.is_empty() {
                                                                    got_assistant_text = true;
                                                                    let _ = evt_tx.send(
                                                                        WorkerEvent::Chunk(
                                                                            text.to_string(),
                                                                        ),
                                                                    );
                                                                }
                                                            }
                                                        }
                                                        Some("tool_use") => {
                                                            let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                                                            let input = block.get("input").unwrap_or(&serde_json::Value::Null);
                                                            let desc = data::tool_activity::describe_tool_use(tool_name, input);
                                                            let _ = evt_tx.send(WorkerEvent::Activity(desc));
                                                        }
                                                        _ => {}
                                                    }
                                                }
                                            }
                                            if let Some(sid) = json
                                                .get("session_id")
                                                .and_then(|v| v.as_str())
                                            {
                                                session_id = Some(sid.to_string());
                                            }
                                        }
                                        Some("result") => {
                                            if let Some(sid) = json
                                                .get("session_id")
                                                .and_then(|v| v.as_str())
                                            {
                                                session_id = Some(sid.to_string());
                                                let _ = evt_tx.send(WorkerEvent::ClaudeSessionId(sid.to_string()));
                                            }
                                            if !got_assistant_text {
                                                if let Some(text) =
                                                    json.get("result").and_then(|v| v.as_str())
                                                {
                                                    if !text.is_empty() {
                                                        let _ = evt_tx.send(WorkerEvent::Chunk(
                                                            text.to_string(),
                                                        ));
                                                    }
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }

                    let _ = child.wait();
                    let _ = evt_tx.send(WorkerEvent::Done(session_id.clone()));
                }
                Err(e) => {
                    let _ = evt_tx.send(WorkerEvent::Error(format!(
                        "Failed to start claude: {}. Set CLAUDE_BIN env var if not on PATH.",
                        e
                    )));
                }
            }
        }
    });

    (cmd_tx, evt_rx)
}

// `describe_tool_use` now lives in `harness_data::tool_activity` so the GUI
// (src-tauri) and the TUI render identical one-liners. See OSS-06.

fn prompt_auto_approve() -> bool {
    use std::io::Write;
    print!("\x1b[1;36m?\x1b[0m Auto-approve all Claude permission prompts? (y/N): ");
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    matches!(input.trim().to_lowercase().as_str(), "y" | "yes")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let auto_approve = prompt_auto_approve();

    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    stdout().execute(EnableMouseCapture)?;
    stdout().execute(EnableBracketedPaste)?;

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;

    // Spawn a temporary general worker — will be replaced after session loads
    let (general_tx, general_rx) = spawn_claude_worker(auto_approve, None, None);
    let mut app = App::new(general_tx, general_rx, auto_approve);
    app.refresh();

    // Load session data FIRST so we know which Claude session IDs to resume
    app.load_chat_for_channel();

    // Now respawn workers with the correct --resume session IDs from the loaded session
    app.respawn_workers_with_session();

    let tick_rate = Duration::from_secs(3);
    let mut last_tick = Instant::now();

    loop {
        terminal.draw(|frame| ui::draw(frame, &mut app))?;

        let timeout = if app.chat_streaming {
            Duration::from_millis(50)
        } else {
            tick_rate
                .checked_sub(last_tick.elapsed())
                .unwrap_or(Duration::ZERO)
        };

        if event::poll(timeout)? {
            match event::read()? {
                Event::Key(key) => {
                    if key.kind == KeyEventKind::Press {
                        app.handle_key(key.code, key.modifiers);
                    }
                }
                Event::Mouse(mouse) => {
                    app.handle_mouse(mouse);
                }
                Event::Paste(text) => {
                    app.handle_paste(text);
                }
                _ => {}
            }
        }

        app.drain_worker_events();

        if last_tick.elapsed() >= tick_rate {
            app.refresh();
            last_tick = Instant::now();
        }

        if app.should_quit {
            break;
        }
    }

    disable_raw_mode()?;
    stdout().execute(DisableBracketedPaste)?;
    stdout().execute(DisableMouseCapture)?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}
