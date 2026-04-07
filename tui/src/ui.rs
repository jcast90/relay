use ratatui::{
    prelude::*,
    widgets::*,
};

use crate::{App, Tab};
use crate::data::TicketLedgerEntry;

pub fn draw(frame: &mut Frame, app: &App) {
    let size = frame.area();

    // Main layout: left sidebar | center content | right panel
    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(28),
            Constraint::Min(30),
            Constraint::Length(36),
        ])
        .split(size);

    draw_sidebar(frame, app, main_chunks[0]);
    draw_center(frame, app, main_chunks[1]);
    draw_right(frame, app, main_chunks[2]);
}

fn draw_sidebar(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(6),
            Constraint::Length(app.agents.len() as u16 + 2),
            Constraint::Length(3),
        ])
        .split(area);

    // Channels list
    let items: Vec<ListItem> = app
        .channels
        .iter()
        .enumerate()
        .map(|(i, ch)| {
            let active = ch.members.iter().filter(|m| m.status == "active").count();
            let label = format!("{} ({})", ch.name, active);
            let style = if i == app.selected_channel {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(label).style(style)
        })
        .collect();

    let channels_list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" Channels ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        )
        .highlight_symbol("▸ ");

    let mut state = ListState::default();
    state.select(Some(app.selected_channel));
    frame.render_stateful_widget(channels_list, chunks[0], &mut state);

    // Agents
    let agent_items: Vec<ListItem> = app
        .agents
        .iter()
        .map(|a| {
            let style = Style::default().fg(Color::Cyan);
            ListItem::new(format!("{} [{}]", a.display_name, a.provider)).style(style)
        })
        .collect();

    let agents_list = List::new(agent_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(" Agents ")
            .title_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
    );
    frame.render_widget(agents_list, chunks[1]);

    // Help
    let help = Paragraph::new(" q:quit j/k:nav tab:switch")
        .style(Style::default().fg(Color::DarkGray))
        .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::DarkGray)));
    frame.render_widget(help, chunks[2]);
}

fn draw_center(frame: &mut Frame, app: &App, area: Rect) {
    let channel_name = app
        .channels
        .get(app.selected_channel)
        .map(|c| c.name.as_str())
        .unwrap_or("No channel");

    // Tab bar
    let tabs = Tabs::new(vec!["1:Feed", "2:Board", "3:Decisions"])
        .select(match app.active_tab {
            Tab::Feed => 0,
            Tab::Board => 1,
            Tab::Decisions => 2,
        })
        .style(Style::default().fg(Color::DarkGray))
        .highlight_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .divider(" │ ");

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    frame.render_widget(tabs, chunks[0]);

    match app.active_tab {
        Tab::Feed => draw_feed(frame, app, channel_name, chunks[1]),
        Tab::Board => draw_board(frame, app, channel_name, chunks[1]),
        Tab::Decisions => draw_decisions(frame, app, channel_name, chunks[1]),
    }
}

fn draw_feed(frame: &mut Frame, app: &App, channel_name: &str, area: Rect) {
    let items: Vec<ListItem> = app
        .feed
        .iter()
        .map(|entry| {
            let from = entry
                .from_display_name
                .as_deref()
                .unwrap_or("system");
            let time = entry
                .created_at
                .get(11..19)
                .unwrap_or("");
            let icon = feed_icon(&entry.entry_type);
            let line = Line::from(vec![
                Span::styled(format!("{} ", time), Style::default().fg(Color::DarkGray)),
                Span::styled(format!("{} ", icon), Style::default()),
                Span::styled(format!("{}: ", from), Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                Span::raw(truncate(&entry.content, area.width as usize - 30)),
            ]);
            ListItem::new(line)
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(format!(" {} ", channel_name))
            .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
    );
    frame.render_widget(list, area);
}

fn draw_board(frame: &mut Frame, app: &App, channel_name: &str, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();

    let status_order = ["executing", "verifying", "ready", "blocked", "pending", "retry", "completed", "failed"];

    for status in status_order {
        let tickets: Vec<&TicketLedgerEntry> = app
            .tickets
            .iter()
            .filter(|t| t.status == status)
            .collect();

        if tickets.is_empty() {
            continue;
        }

        let color = status_color(status);
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {} ", status.to_uppercase()),
                Style::default().fg(Color::Black).bg(color),
            ),
            Span::styled(format!(" ({})", tickets.len()), Style::default().fg(Color::DarkGray)),
        ]));

        for ticket in tickets.iter().take(8) {
            let agent = ticket
                .assigned_agent_name
                .as_deref()
                .unwrap_or("unassigned");
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(&ticket.title, Style::default()),
                Span::styled(format!(" [{}]", agent), Style::default().fg(Color::DarkGray)),
            ]));
        }

        if tickets.len() > 8 {
            lines.push(Line::from(Span::styled(
                format!("  +{} more", tickets.len() - 8),
                Style::default().fg(Color::DarkGray),
            )));
        }

        lines.push(Line::raw(""));
    }

    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "No tickets",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let paragraph = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(format!(" {} — Task Board ", channel_name))
            .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
    );
    frame.render_widget(paragraph, area);
}

fn draw_decisions(frame: &mut Frame, app: &App, channel_name: &str, area: Rect) {
    let items: Vec<ListItem> = app
        .decisions
        .iter()
        .map(|d| {
            let time = d.created_at.get(..10).unwrap_or("");
            let line = Line::from(vec![
                Span::styled(format!("{} ", time), Style::default().fg(Color::DarkGray)),
                Span::styled(format!("⚖ {}", d.title), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
            ]);
            let detail = Line::from(vec![
                Span::raw("  "),
                Span::styled(&d.decided_by_name, Style::default().fg(Color::Cyan)),
                Span::raw(": "),
                Span::raw(truncate(&d.rationale, area.width as usize - 20)),
            ]);
            ListItem::new(vec![line, detail, Line::raw("")])
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(format!(" {} — Decisions ", channel_name))
            .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
    );
    frame.render_widget(list, area);
}

fn draw_right(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(6), Constraint::Length(8)])
        .split(area);

    // Active runs
    let run_items: Vec<ListItem> = app
        .active_runs
        .iter()
        .map(|r| {
            let color = status_color(&r.state);
            let line = Line::from(vec![
                Span::styled(&r.state, Style::default().fg(color)),
                Span::raw(" "),
                Span::styled(
                    truncate(&r.feature_request, 20),
                    Style::default().fg(Color::White),
                ),
            ]);
            let detail = Line::from(vec![
                Span::raw("  "),
                Span::styled(&r.workspace, Style::default().fg(Color::DarkGray)),
            ]);
            ListItem::new(vec![line, detail])
        })
        .collect();

    let runs_list = List::new(run_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(" Active Runs ")
            .title_style(
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ),
    );
    frame.render_widget(runs_list, chunks[0]);

    // Summary
    let summary = format!(
        " {} channels  {} agents\n {} tickets   {} runs",
        app.channels.len(),
        app.agents.len(),
        app.tickets.len(),
        app.active_runs.len(),
    );
    let summary_widget = Paragraph::new(summary)
        .style(Style::default().fg(Color::DarkGray))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" Summary ")
                .title_style(Style::default().fg(Color::Magenta)),
        );
    frame.render_widget(summary_widget, chunks[1]);
}

fn status_color(status: &str) -> Color {
    match status {
        "completed" | "passed" | "active" | "COMPLETE" => Color::Green,
        "executing" | "verifying" | "running" | "TICKETS_EXECUTING" | "PHASE_EXECUTE" => Color::Cyan,
        "ready" | "pending" | "idle" | "DRAFT_PLAN" | "PLAN_REVIEW" => Color::Yellow,
        "blocked" | "retry" | "AWAITING_APPROVAL" => Color::Magenta,
        "failed" | "FAILED" | "BLOCKED" => Color::Red,
        _ => Color::DarkGray,
    }
}

fn feed_icon(entry_type: &str) -> &str {
    match entry_type {
        "message" => "💬",
        "decision" => "⚖️",
        "status_update" => "📊",
        "artifact" => "📎",
        "agent_joined" => "→",
        "agent_left" => "←",
        "run_started" => "▶",
        "run_completed" => "✓",
        "ref_added" => "🔗",
        _ => "·",
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}
