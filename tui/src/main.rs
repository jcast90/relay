mod data;
mod ui;

use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseButton, MouseEvent, MouseEventKind,
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

#[derive(Clone, Copy, PartialEq)]
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
    fn to_persisted(&self) -> data::PersistedChatMessage {
        data::PersistedChatMessage {
            role: self.role.as_str().to_string(),
            content: self.content.clone(),
            timestamp: self.timestamp.clone(),
            agent_alias: self.agent_alias.clone(),
        }
    }

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

    /// Start a new chat session for the current channel
    fn new_session(&mut self) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };

        let session = create_session(&ch_id, "New conversation");
        self.chat_messages.clear();
        self.activity_stacks.clear();
        self.active_session = Some(session.clone());
        self.session_list = load_sessions(&ch_id);

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

    /// Persist a chat message to the active session
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
            let session = create_session(&ch_id, &title);
            self.active_session = Some(session);
            self.session_list = load_sessions(&ch_id);
        }

        if let Some(ref mut session) = self.active_session {
            append_session_message(&ch_id, &session.session_id, &msg.to_persisted());
            session.message_count += 1;
            session.updated_at = chrono::Utc::now().to_rfc3339();

            // Update title from first user message if still default
            if session.title == "New conversation" && msg.role == ChatRole::User {
                session.title = truncate_str(&msg.content, 60);
            }

            update_session(&ch_id, session);
        }
    }

    /// Update the last persisted message (for completed streaming)
    fn persist_update_last(&self, msg: &ChatMessage) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };
        if let Some(ref session) = self.active_session {
            update_last_session_message(&ch_id, &session.session_id, &msg.to_persisted());
        }
    }

    /// Store a Claude CLI session ID for a worker alias in the active session
    fn store_claude_session_id(&mut self, alias: &str, claude_sid: &str) {
        let ch_id = match self.current_channel_id() {
            Some(id) => id,
            None => return,
        };
        if let Some(ref mut session) = self.active_session {
            session.claude_session_ids.insert(alias.to_string(), claude_sid.to_string());
            update_session(&ch_id, session);
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
                if is_active_state(&run.state) && seen_run_ids.insert(run.run_id.clone()) {
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

        // Default active worker to first repo if none set
        if self.active_worker_alias.is_none() && !repos.is_empty() {
            self.active_worker_alias = Some(repos[0].alias.clone());
        }
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
                // Push to activity stack for this alias
                let stack = self.activity_stacks
                    .entry(alias.clone())
                    .or_insert_with(|| ActivityStack {
                        entries: Vec::new(),
                        agent_alias: alias.clone(),
                    });
                stack.entries.push((desc.clone(), now_time()));
                // Keep max 20 entries
                if stack.entries.len() > 20 {
                    stack.entries.remove(0);
                }

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

                // Build stacked activity content — show top 3
                let stack = self.activity_stacks.get(&alias).unwrap();
                let top_n = if self.activity_expanded { stack.entries.len() } else { 3 };
                let recent: Vec<&str> = stack.entries.iter()
                    .rev()
                    .take(top_n)
                    .map(|(d, _)| d.as_str())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let total = stack.entries.len();
                let content = if total > top_n {
                    format!("{}\n  +{} more", recent.join("\n"), total - top_n)
                } else {
                    recent.join("\n")
                };

                self.chat_messages.push(ChatMessage {
                    role: ChatRole::Activity,
                    content,
                    timestamp: now_time(),
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
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if self.layout.input.contains(Position::new(col, row)) {
                    self.input_mode = InputMode::Input;
                    self.active_tab = Tab::Chat;
                    return;
                }

                if let Some(panel) = self.panel_at(col, row) {
                    self.focus = panel;
                }
            }
            _ => {}
        }
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
                        let new_end = trimmed.rfind(' ').map(|i| i + 1).unwrap_or(0);
                        self.input_buffer.drain(new_end..self.input_cursor);
                        self.input_cursor = new_end;
                    }
                }
                // Ctrl-B: back one character
                KeyCode::Char('b') if ctrl => {
                    if self.input_cursor > 0 {
                        self.input_cursor -= 1;
                    }
                }
                // Ctrl-F: forward one character
                KeyCode::Char('f') if ctrl => {
                    if self.input_cursor < self.input_buffer.len() {
                        self.input_cursor += 1;
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
                KeyCode::Home => self.input_cursor = 0,
                KeyCode::End => self.input_cursor = self.input_buffer.len(),
                KeyCode::Char(c) => {
                    self.input_buffer.insert(self.input_cursor, c);
                    self.input_cursor += 1;
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
                match code {
                    KeyCode::Esc => {
                        self.repo_select = None;
                        self.input_mode = InputMode::Normal;
                    }
                    KeyCode::Char('j') | KeyCode::Down => {
                        if state.cursor < state.available_repos.len().saturating_sub(1) {
                            state.cursor += 1;
                        }
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        if state.cursor > 0 {
                            state.cursor -= 1;
                        }
                    }
                    KeyCode::Char(' ') => {
                        // Toggle selection
                        if state.cursor < state.selected.len() {
                            state.selected[state.cursor] = !state.selected[state.cursor];
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

        // Build repo assignments from selection
        let mut repo_assignments: Vec<RepoAssignment> = Vec::new();
        let selected_repos: Vec<&WorkspaceEntry> = state
            .available_repos
            .iter()
            .zip(state.selected.iter())
            .filter(|(_, &sel)| sel)
            .map(|(ws, _)| ws)
            .collect();

        for (i, ws) in selected_repos.iter().enumerate() {
            let alias = state
                .aliases
                .get(i)
                .cloned()
                .unwrap_or_else(|| {
                    ws.repo_path
                        .split('/')
                        .last()
                        .unwrap_or(&ws.workspace_id)
                        .to_string()
                });
            repo_assignments.push(RepoAssignment {
                alias,
                workspace_id: ws.workspace_id.clone(),
                repo_path: ws.repo_path.clone(),
            });
        }

        let assignments_json: Vec<serde_json::Value> = repo_assignments
            .iter()
            .map(|r| {
                serde_json::json!({
                    "alias": r.alias,
                    "workspaceId": r.workspace_id,
                    "repoPath": r.repo_path,
                })
            })
            .collect();

        let channels_dir = data::harness_root().join("channels");
        let _ = std::fs::create_dir_all(&channels_dir);

        if let Some(existing_id) = state.editing_channel_id {
            // --- Editing repos on an existing channel ---
            let channel_file = channels_dir.join(format!("{}.json", existing_id));
            if let Ok(content) = std::fs::read_to_string(&channel_file) {
                if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
                    json["repoAssignments"] = serde_json::Value::Array(
                        assignments_json.into_iter().map(|v| v).collect(),
                    );
                    if let Ok(updated) = serde_json::to_string_pretty(&json) {
                        let _ = std::fs::write(&channel_file, updated);
                    }
                }
            }

            // Write a feed entry about the change
            let repo_desc = repo_desc_string(&repo_assignments);
            let channel_sub_dir = channels_dir.join(&existing_id);
            let _ = std::fs::create_dir_all(&channel_sub_dir);
            let entry = serde_json::json!({
                "entryId": format!("tui-{}", chrono::Utc::now().timestamp_millis()),
                "channelId": existing_id,
                "type": "status_update",
                "fromAgentId": "tui-user",
                "fromDisplayName": "You",
                "content": format!("Repos updated: {}", repo_desc),
                "metadata": {},
                "createdAt": chrono::Utc::now().to_rfc3339(),
            });
            let feed_path = channel_sub_dir.join("feed.jsonl");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&feed_path)
            {
                use std::io::Write;
                let _ = writeln!(file, "{}", entry);
            }
        } else {
            // --- Creating a new channel ---
            let name = state.channel_name;
            let channel_id = format!("ch-{}", chrono::Utc::now().timestamp_millis());

            let channel_json = serde_json::json!({
                "channelId": channel_id,
                "name": name,
                "description": name,
                "status": "active",
                "members": [],
                "pinnedRefs": [],
                "repoAssignments": assignments_json,
            });

            let channel_file = channels_dir.join(format!("{}.json", channel_id));
            if let Ok(content) = serde_json::to_string_pretty(&channel_json) {
                let _ = std::fs::write(&channel_file, content);
            }

            let channel_sub_dir = channels_dir.join(&channel_id);
            let _ = std::fs::create_dir_all(&channel_sub_dir);

            let repo_desc = repo_desc_string(&repo_assignments);
            let entry = serde_json::json!({
                "entryId": format!("tui-{}", chrono::Utc::now().timestamp_millis()),
                "channelId": channel_id,
                "type": "status_update",
                "fromAgentId": "tui-user",
                "fromDisplayName": "You",
                "content": format!("Channel \"{}\" created with repos: {}", name, repo_desc),
                "metadata": {},
                "createdAt": chrono::Utc::now().to_rfc3339(),
            });

            let feed_path = channel_sub_dir.join("feed.jsonl");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&feed_path)
            {
                use std::io::Write;
                let _ = writeln!(file, "{}", entry);
            }

            // Select the newly created channel after refresh
            self.input_mode = InputMode::Normal;
            self.refresh();
            if let Some(idx) = self.channels.iter().position(|c| c.channel_id == channel_id) {
                self.selected_channel = idx;
                self.refresh();
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
                // Delete selected session (but not the active one)
                if let Some(session) = self.session_list.get(self.session_cursor) {
                    let is_active = self.active_session.as_ref()
                        .map(|a| a.session_id == session.session_id)
                        .unwrap_or(false);
                    if !is_active {
                        if let Some(ch_id) = self.current_channel_id() {
                            let sid = session.session_id.clone();
                            // Remove from index
                            self.session_list.retain(|s| s.session_id != sid);
                            save_sessions(&ch_id, &self.session_list);
                            // Delete the chat file
                            let chat_path = data::harness_root()
                                .join("channels")
                                .join(&ch_id)
                                .join("sessions")
                                .join(format!("{}.jsonl", sid));
                            let _ = std::fs::remove_file(chat_path);
                            // Clamp cursor
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

        let resolved_alias = target_alias.or_else(|| self.active_worker_alias.clone());

        // Add user message to chat and persist
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

        // Route to the correct worker
        if let Some(ref alias) = resolved_alias {
            if let Some(worker) = self.workers.get_mut(alias) {
                worker.streaming = true;
                let _ = worker.tx.send(WorkerCommand::SendMessage(actual_msg));
                return;
            }
        }

        // Fallback to general worker
        let _ = self.general_worker_tx.send(WorkerCommand::SendMessage(actual_msg));
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

    /// Update the completion popup based on current input
    fn update_completion(&mut self) {
        let buf = &self.input_buffer;
        let cursor = self.input_cursor;

        // Find the @ character before cursor
        let before_cursor = &buf[..cursor];
        if let Some(at_pos) = before_cursor.rfind('@') {
            // Make sure there's no space between @ and cursor (still typing the mention)
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

fn repo_desc_string(repo_assignments: &[RepoAssignment]) -> String {
    if repo_assignments.is_empty() {
        "none".to_string()
    } else {
        repo_assignments
            .iter()
            .map(|r| {
                format!(
                    "@{} ({})",
                    r.alias,
                    r.repo_path.split('/').last().unwrap_or(&r.repo_path)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn now_time() -> String {
    chrono::Utc::now().format("%H:%M:%S").to_string()
}

fn truncate_str(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.len() <= max {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..max.saturating_sub(3)])
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
    let harness_dir = harness_root().to_string_lossy().to_string();

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

            // Build system prompt with repo context and artifact paths
            let mut system_parts: Vec<String> = Vec::new();

            if let (Some(ref alias), Some(ref dir)) = (&repo_alias_owned, &cwd_owned) {
                let repo_name = dir.rsplit('/').next().unwrap_or(dir);
                system_parts.push(format!(
                    "You are working in the '{}' repository (alias: @{}) at: {}. \
                     Your working directory is already set to this repo — do NOT search for it elsewhere. \
                     All file operations should be relative to this directory.",
                    repo_name, alias, dir
                ));
            }

            if let Some(ref ch_id) = channel_id_owned {
                let channel_dir = format!("{}/channels/{}", harness_dir, ch_id);
                let tickets_path = format!("{}/tickets.json", channel_dir);
                let decisions_dir = format!("{}/decisions", channel_dir);
                system_parts.push(format!(
                    "\n\n## Shared Ticket Board & Decisions\n\
                     \n\
                     The ticket board at `{tickets}` is the shared coordination surface for all agents in this channel. \
                     Other agents read this file to know what work is available, what's blocked, and when dependencies are resolved.\n\
                     \n\
                     ### Ticket lifecycle\n\
                     When the user asks you to create tickets, a plan, or task breakdown, write them to:\n\
                     `{tickets}`\n\
                     \n\
                     Format:\n\
                     ```json\n\
                     {{\"tickets\": [\n\
                       {{\n\
                         \"ticketId\": \"T-1\",\n\
                         \"title\": \"Short description of the work\",\n\
                         \"specialty\": \"frontend|backend|fullstack|devops|design\",\n\
                         \"status\": \"pending\",\n\
                         \"dependsOn\": [\"T-0\"],\n\
                         \"assignedAgentId\": null,\n\
                         \"assignedAgentName\": null,\n\
                         \"verification\": \"how to verify this ticket is done (test commands, checks)\",\n\
                         \"attempt\": 0\n\
                       }}\n\
                     ]}}\n\
                     ```\n\
                     \n\
                     Status values: `pending` (no unmet deps, ready to pick up) | `blocked` (has unmet dependsOn) | `executing` (agent working on it) | `completed` | `failed`\n\
                     \n\
                     Rules:\n\
                     - Set `dependsOn` accurately — list ticket IDs that MUST be completed before this ticket can start.\n\
                     - Tickets whose `dependsOn` are all `completed` should be `pending` (available for pickup).\n\
                     - Tickets with unresolved deps should be `blocked`.\n\
                     - When you START working on a ticket, read the file, set that ticket's status to `executing`, and write it back.\n\
                     - When you FINISH a ticket, set status to `completed` (or `failed`), increment `attempt`, and write it back. \
                       Then check if any `blocked` tickets now have all deps met — flip those to `pending`.\n\
                     - Always read-modify-write the WHOLE file to avoid clobbering other agents' updates.\n\
                     \n\
                     ### Decisions\n\
                     When making architectural or design decisions during planning, write each as a separate JSON file in:\n\
                     `{decisions}/`\n\
                     \n\
                     Format:\n\
                     ```json\n\
                     {{\"decisionId\": \"D-<timestamp>\", \"title\": \"...\", \"description\": \"...\", \
                     \"rationale\": \"why this approach\", \"alternatives\": [\"alt1\", \"alt2\"], \
                     \"decidedByName\": \"Claude\", \"createdAt\": \"<ISO 8601>\"}}\n\
                     ```\n\
                     \n\
                     Create directories if they don't exist. These paths are read by the TUI Board and Decisions tabs, \
                     and by other agents for coordination.",
                    tickets = tickets_path, decisions = decisions_dir
                ));
            }

            if !system_parts.is_empty() {
                args.push("--append-system-prompt".to_string());
                args.push(system_parts.join("\n"));
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
                                                            let desc = describe_tool_use(tool_name, input);
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

/// Build a human-readable one-liner describing what a tool call is doing.
fn describe_tool_use(name: &str, input: &serde_json::Value) -> String {
    let get_str = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("");

    match name {
        "Read" => {
            let path = get_str("file_path");
            let short = path.rsplit('/').next().unwrap_or(path);
            format!("Reading {}", short)
        }
        "Edit" => {
            let path = get_str("file_path");
            let short = path.rsplit('/').next().unwrap_or(path);
            format!("Editing {}", short)
        }
        "Write" => {
            let path = get_str("file_path");
            let short = path.rsplit('/').next().unwrap_or(path);
            format!("Writing {}", short)
        }
        "Bash" => {
            let cmd = get_str("command");
            let short = if cmd.len() > 50 { &cmd[..50] } else { cmd };
            format!("$ {}", short)
        }
        "Grep" => {
            let pattern = get_str("pattern");
            format!("Searching for '{}'", if pattern.len() > 40 { &pattern[..40] } else { pattern })
        }
        "Glob" => {
            let pattern = get_str("pattern");
            format!("Finding files: {}", pattern)
        }
        "Agent" => {
            let desc = get_str("description");
            if desc.is_empty() {
                "Spawning agent".to_string()
            } else {
                format!("Agent: {}", desc)
            }
        }
        "WebSearch" => {
            let query = get_str("query");
            format!("Web search: {}", if query.len() > 40 { &query[..40] } else { query })
        }
        "WebFetch" => {
            let url = get_str("url");
            format!("Fetching {}", if url.len() > 40 { &url[..40] } else { url })
        }
        "LSP" => {
            let method = get_str("method");
            format!("LSP {}", method)
        }
        "Skill" => {
            let skill = get_str("skill");
            format!("/{}", skill)
        }
        _ => name.to_string(),
    }
}

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

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;

    let (general_tx, general_rx) = spawn_claude_worker(auto_approve, None, None);
    let mut app = App::new(general_tx, general_rx, auto_approve);
    app.refresh();
    app.ensure_workers_for_channel();
    app.load_chat_for_channel();

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
    stdout().execute(DisableMouseCapture)?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}
