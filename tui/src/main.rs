mod data;
mod ui;

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::prelude::*;
use std::io::stdout;
use std::time::{Duration, Instant};

use data::*;

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
}

#[derive(Clone, Debug)]
pub struct ActiveRun {
    pub run_id: String,
    pub state: String,
    pub feature_request: String,
    pub workspace: String,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    Feed,
    Board,
    Decisions,
}

impl App {
    fn new() -> Self {
        Self {
            channels: Vec::new(),
            selected_channel: 0,
            feed: Vec::new(),
            tickets: Vec::new(),
            active_runs: Vec::new(),
            agents: Vec::new(),
            decisions: Vec::new(),
            active_tab: Tab::Feed,
            should_quit: false,
        }
    }

    fn refresh(&mut self) {
        self.channels = load_channels();
        self.agents = load_agent_names();

        let selected = self.channels.get(self.selected_channel);

        if let Some(ch) = selected {
            self.feed = load_channel_feed(&ch.channel_id, 100);
            self.decisions = load_channel_decisions(&ch.channel_id);

            self.tickets.clear();
            let run_links = load_channel_run_links(&ch.channel_id);
            for link in &run_links {
                let tickets = load_ticket_ledger(&link.workspace_id, &link.run_id);
                self.tickets.extend(tickets);
            }
        } else {
            self.feed.clear();
            self.tickets.clear();
            self.decisions.clear();
        }

        self.active_runs.clear();
        for ws in load_workspaces() {
            for run in load_runs_for_workspace(&ws.workspace_id) {
                if is_active_state(&run.state) {
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
    }

    fn handle_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,
            KeyCode::Char('j') | KeyCode::Down => {
                if self.selected_channel < self.channels.len().saturating_sub(1) {
                    self.selected_channel += 1;
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.selected_channel > 0 {
                    self.selected_channel -= 1;
                }
            }
            KeyCode::Tab => {
                self.active_tab = match self.active_tab {
                    Tab::Feed => Tab::Board,
                    Tab::Board => Tab::Decisions,
                    Tab::Decisions => Tab::Feed,
                };
            }
            KeyCode::Char('1') => self.active_tab = Tab::Feed,
            KeyCode::Char('2') => self.active_tab = Tab::Board,
            KeyCode::Char('3') => self.active_tab = Tab::Decisions,
            _ => {}
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;

    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;
    let mut app = App::new();
    app.refresh();

    let tick_rate = Duration::from_secs(3);
    let mut last_tick = Instant::now();

    loop {
        terminal.draw(|frame| ui::draw(frame, &app))?;

        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or(Duration::ZERO);

        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.handle_key(key.code);
                }
            }
        }

        if last_tick.elapsed() >= tick_rate {
            app.refresh();
            last_tick = Instant::now();
        }

        if app.should_quit {
            break;
        }
    }

    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;
    Ok(())
}
