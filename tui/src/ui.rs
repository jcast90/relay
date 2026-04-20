use ratatui::{
    prelude::*,
    widgets::*,
};

use crate::{App, ChatRole, CompletionKind, FocusPanel, InputMode, RepoSelectStep, Tab, TextSelection};

pub fn draw(frame: &mut Frame, app: &mut App) {
    let size = frame.area();

    // Input bar is always a fixed 3 lines tall (1 content + 2 border).
    // Multi-line content shows a condensed "[1 of N lines]" indicator.
    let input_height: u16 = 3;

    // Always reserve space at bottom for input bar
    let (main_area, input_area) = {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(input_height)])
            .split(size);
        (chunks[0], chunks[1])
    };

    // Main layout: left sidebar | center content | right panel
    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(26),
            Constraint::Min(30),
            Constraint::Length(34),
        ])
        .split(main_area);

    // Store layout regions for mouse hit-testing
    app.layout.sidebar = main_chunks[0];
    app.layout.center = main_chunks[1];
    app.layout.right = main_chunks[2];
    app.layout.input = input_area;

    draw_sidebar(frame, app, main_chunks[0]);
    draw_center(frame, app, main_chunks[1]);
    draw_right(frame, app, main_chunks[2]);

    // Always-visible input bar
    draw_input_bar(frame, app, input_area);

    // @ completion popup (rendered above input bar)
    if app.completion_visible && app.input_mode == InputMode::Input {
        draw_completion_popup(frame, app, input_area);
    }

    // Detail popup overlay (drawn last, on top)
    if app.show_detail {
        draw_detail_popup(frame, app, size);
    }

    // New channel popup
    if app.input_mode == InputMode::NewChannel {
        draw_new_channel_popup(frame, app, size);
    }

    // Repo selection popup
    if app.input_mode == InputMode::RepoSelect {
        draw_repo_select_popup(frame, app, size);
    }

    // Session history popup
    if app.input_mode == InputMode::SessionSelect {
        draw_session_select_popup(frame, app, size);
    }
}

fn border_style(app: &App, panel: FocusPanel) -> Style {
    if app.focus == panel {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn draw_sidebar(frame: &mut Frame, app: &App, area: Rect) {
    let agent_height = (app.agents.len() as u16 + 2).min(area.height / 3);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(6),
            Constraint::Length(agent_height),
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
            let prefix = if i == app.selected_channel { "▸ " } else { "  " };
            let label = format!("{}# {} ({})", prefix, ch.name, active);
            let style = if i == app.selected_channel {
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            ListItem::new(label).style(style)
        })
        .collect();

    let channels_list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(border_style(app, FocusPanel::Sidebar))
                .title(" Channels ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        );

    let mut state = ListState::default();
    state.select(Some(app.selected_channel));
    frame.render_stateful_widget(channels_list, chunks[0], &mut state);

    // Repo agents for the current channel + registered agents
    let repo_assignments = app.current_repo_assignments();
    let busy_agent_names: std::collections::HashSet<String> = app
        .tickets
        .iter()
        .filter(|t| matches!(t.status.as_str(), "executing" | "verifying"))
        .filter_map(|t| t.assigned_agent_name.clone())
        .collect();

    let mut agent_items: Vec<ListItem> = Vec::new();

    // Show repo agents first (these are the per-repo Claude sessions)
    if !repo_assignments.is_empty() {
        for repo in &repo_assignments {
            let is_streaming = app.is_worker_streaming(&repo.alias);
            let is_active = app.active_worker_alias.as_deref() == Some(&repo.alias);
            let repo_short = repo.repo_path.split('/').last().unwrap_or(&repo.alias);

            let (icon, icon_color) = if is_streaming {
                ("● ", Color::Green)
            } else if is_active {
                ("◉ ", Color::Cyan)
            } else {
                ("○ ", Color::DarkGray)
            };

            let alias_style = if is_active {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Cyan)
            };

            let line = Line::from(vec![
                Span::styled(icon, Style::default().fg(icon_color)),
                Span::styled(format!("@{}", repo.alias), alias_style),
                Span::styled(format!(" {}", repo_short), Style::default().fg(Color::DarkGray)),
            ]);
            agent_items.push(ListItem::new(line));
        }
    }

    // Show harness agents below
    for a in &app.agents {
        let is_busy = busy_agent_names.contains(&a.display_name);
        let (icon, icon_color) = if is_busy {
            ("● ", Color::Green)
        } else {
            ("○ ", Color::DarkGray)
        };
        let line = Line::from(vec![
            Span::styled(icon, Style::default().fg(icon_color)),
            Span::styled(&a.display_name, Style::default().fg(Color::White)),
            Span::styled(format!(" [{}]", a.provider), Style::default().fg(Color::DarkGray)),
        ]);
        agent_items.push(ListItem::new(line));
    }

    let agents_title = if repo_assignments.is_empty() {
        " Agents "
    } else {
        " Repo Agents "
    };
    let agents_list = List::new(agent_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(agents_title)
            .title_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
    );
    frame.render_widget(agents_list, chunks[1]);

    // Context-sensitive help
    let help_text = help_text(app);
    let help = Paragraph::new(help_text)
        .style(Style::default().fg(Color::DarkGray))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)),
        );
    frame.render_widget(help, chunks[2]);
}

fn draw_center(frame: &mut Frame, app: &mut App, area: Rect) {
    let channel_name = app
        .channels
        .get(app.selected_channel)
        .map(|c| c.name.clone())
        .unwrap_or_else(|| "No channel".to_string());

    // All tabs share the same layout: tab bar at bottom of the block border
    match app.active_tab {
        Tab::Chat => draw_chat(frame, app, area),
        Tab::Board => draw_board(frame, app, &channel_name, area),
        Tab::Decisions => draw_decisions(frame, app, &channel_name, area),
    }
}

fn tab_bar_line(app: &App) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            " 1",
            Style::default().fg(if app.active_tab == Tab::Chat { Color::Cyan } else { Color::DarkGray }),
        ),
        Span::styled(
            ":Chat",
            Style::default().fg(if app.active_tab == Tab::Chat { Color::Cyan } else { Color::DarkGray }),
        ),
        Span::styled(" | ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            "2",
            Style::default().fg(if app.active_tab == Tab::Board { Color::Cyan } else { Color::DarkGray }),
        ),
        Span::styled(
            ":Board",
            Style::default().fg(if app.active_tab == Tab::Board { Color::Cyan } else { Color::DarkGray }),
        ),
        Span::styled(" | ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            "3",
            Style::default().fg(if app.active_tab == Tab::Decisions { Color::Cyan } else { Color::DarkGray }),
        ),
        Span::styled(
            ":Decisions ",
            Style::default().fg(if app.active_tab == Tab::Decisions { Color::Cyan } else { Color::DarkGray }),
        ),
    ])
    .right_aligned()
}

/// Chat view — renders the conversation with Claude
fn draw_chat(frame: &mut Frame, app: &mut App, area: Rect) {
    let active_repo_label = app.active_worker_alias.as_ref()
        .map(|a| format!(" @{}", a))
        .unwrap_or_default();
    let streaming_indicator = if app.chat_streaming { " ..." } else { "" };
    let session_label = app.active_session.as_ref()
        .map(|s| {
            let t = if s.title.len() > 30 { format!("{}...", &s.title[..27]) } else { s.title.clone() };
            format!(" — {}", t)
        })
        .unwrap_or_default();
    let title = format!(" Chat{}{}{} ", active_repo_label, session_label, streaming_indicator);

    let inner_block = Block::default()
        .borders(Borders::ALL)
        .border_style(border_style(app, FocusPanel::Center))
        .title(title)
        .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD))
        .title_bottom(tab_bar_line(app));

    let inner = inner_block.inner(area);
    frame.render_widget(inner_block, area);

    if app.chat_messages.is_empty() {
        let empty = Paragraph::new(Line::from(vec![
            Span::styled("  Press ", Style::default().fg(Color::DarkGray)),
            Span::styled("i", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::styled(" to start chatting with Claude.", Style::default().fg(Color::DarkGray)),
        ]));
        frame.render_widget(empty, inner);
        return;
    }

    // Build rendered lines from chat messages
    let mut lines: Vec<Line> = Vec::new();
    let chat_width = inner.width as usize;
    let max_content_width = chat_width.saturating_sub(4);

    for (i, msg) in app.chat_messages.iter().enumerate() {
        // Spacing between messages
        if i > 0 {
            lines.push(Line::raw(""));
        }

        // Agent alias badge
        let alias_badge = msg.agent_alias.as_ref().map(|a| {
            Span::styled(
                format!(" @{} ", a),
                Style::default().fg(Color::Black).bg(Color::Cyan),
            )
        });
        match msg.role {
            ChatRole::User => {
                // User header
                let mut header = vec![
                    Span::styled(
                        "  You",
                        Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
                    ),
                ];
                if let Some(badge) = alias_badge {
                    header.push(Span::raw(" "));
                    header.push(badge);
                }
                header.push(Span::styled(
                    format!("  {}", msg.timestamp),
                    Style::default().fg(Color::DarkGray),
                ));
                lines.push(Line::from(header));
                // User message body
                if max_content_width > 0 {
                    for wrapped in word_wrap(&msg.content, max_content_width) {
                        lines.push(Line::from(vec![
                            Span::raw("    "),
                            Span::styled(wrapped, Style::default().fg(Color::White)),
                        ]));
                    }
                }
            }
            ChatRole::Assistant => {
                // Assistant header with agent badge
                let mut header = vec![
                    Span::styled(
                        "  Claude",
                        Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                    ),
                ];
                if let Some(badge) = alias_badge {
                    header.push(Span::raw(" "));
                    header.push(badge);
                }
                header.push(Span::styled(
                    format!("  {}", msg.timestamp),
                    Style::default().fg(Color::DarkGray),
                ));
                if app.chat_streaming && i == app.chat_messages.len() - 1 {
                    header.push(Span::styled(
                        "  typing...",
                        Style::default().fg(Color::Yellow).add_modifier(Modifier::ITALIC),
                    ));
                }
                lines.push(Line::from(header));
                // Assistant message body — render markdown
                if msg.content.is_empty() && app.chat_streaming && i == app.chat_messages.len() - 1 {
                    lines.push(Line::from(vec![
                        Span::raw("    "),
                        Span::styled("...", Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC)),
                    ]));
                } else if max_content_width > 0 {
                    let md_lines = render_markdown(&msg.content, max_content_width);
                    for ml in md_lines {
                        let mut spans = vec![Span::raw("    ")];
                        spans.extend(ml.spans);
                        lines.push(Line::from(spans));
                    }
                }
            }
            ChatRole::Activity => {
                // Stacked activity: content may have multiple lines
                let activity_lines: Vec<&str> = msg.content.lines().collect();
                let alias_label = msg.agent_alias.as_ref().map(|a| format!("@{}", a)).unwrap_or_else(|| "agent".to_string());
                for (li, aline) in activity_lines.iter().enumerate() {
                    if li == 0 {
                        // First line: show agent badge + icon
                        let mut spans = vec![
                            Span::styled("    ", Style::default()),
                            Span::styled(
                                format!(" {} ", alias_label),
                                Style::default().fg(Color::Black).bg(Color::Rgb(80, 80, 100)),
                            ),
                            Span::styled(" ", Style::default()),
                        ];
                        // Prefix icon for the newest (first) entry
                        spans.push(Span::styled(
                            "⚙ ",
                            Style::default().fg(Color::Rgb(120, 120, 150)),
                        ));
                        spans.push(Span::styled(
                            aline.to_string(),
                            Style::default().fg(Color::Rgb(120, 120, 150)).add_modifier(Modifier::ITALIC),
                        ));
                        lines.push(Line::from(spans));
                    } else {
                        // Subsequent stacked entries (indented)
                        let prefix = if aline.starts_with("  +") {
                            // "+N more" summary
                            "      "
                        } else {
                            "      ⚙ "
                        };
                        lines.push(Line::from(vec![
                            Span::styled(
                                format!("{}{}", prefix, aline),
                                Style::default().fg(Color::Rgb(80, 80, 100)).add_modifier(Modifier::ITALIC),
                            ),
                        ]));
                    }
                }
            }
            ChatRole::System => {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("  ~ {}", msg.content),
                        Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                    ),
                ]));
            }
        }
    }

    // Scroll: line-based scrolling
    let visible_height = inner.height as usize;
    let total_lines = lines.len();
    app.chat_total_lines = total_lines;

    let max_scroll = total_lines.saturating_sub(visible_height);
    // Clamp chat_scroll
    let scroll_offset = app.chat_scroll.min(max_scroll);
    app.chat_scroll = scroll_offset;

    // Capture ALL plain-text lines for text selection copy (not just visible ones)
    if app.selection.panel == Some(FocusPanel::Center) {
        app.selection.inner_area = inner;
        app.selection.rendered_lines = lines.iter()
            .map(|line| {
                line.spans.iter().map(|s| s.content.as_ref()).collect::<String>()
            })
            .collect();
    }

    let paragraph = Paragraph::new(lines)
        .scroll((scroll_offset as u16, 0));
    frame.render_widget(paragraph, inner);

    // Draw selection highlight overlay (content-relative, scroll-aware)
    if app.selection.panel == Some(FocusPanel::Center) {
        draw_selection_highlight(frame, &app.selection, inner, scroll_offset);
    }

    // Scroll indicator
    if total_lines > visible_height {
        let pct = if max_scroll > 0 {
            (scroll_offset * 100) / max_scroll
        } else {
            100
        };
        let indicator = format!(" {}% ", pct);
        let indicator_area = Rect::new(
            area.x + area.width - indicator.len() as u16 - 2,
            area.y,
            indicator.len() as u16,
            1,
        );
        frame.render_widget(
            Paragraph::new(indicator).style(Style::default().fg(Color::DarkGray)),
            indicator_area,
        );
    }
}

fn draw_board(frame: &mut Frame, app: &App, channel_name: &str, area: Rect) {
    let focused = app.focus == FocusPanel::Center && app.active_tab == Tab::Board;

    let sorted_indices = app.sorted_ticket_indices();
    let mut lines: Vec<Line> = Vec::new();
    let mut current_status = "";
    let mut flat_index: usize = 0;

    for &ticket_idx in &sorted_indices {
        let ticket = &app.tickets[ticket_idx];

        if ticket.status != current_status {
            if !current_status.is_empty() {
                lines.push(Line::raw(""));
            }
            current_status = &ticket.status;
            let color = status_color(current_status);
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {} ", current_status.to_uppercase()),
                    Style::default().fg(Color::Black).bg(color),
                ),
            ]));
        }

        let is_selected = focused && flat_index == app.board_scroll;
        let agent = ticket
            .assigned_agent_name
            .as_deref()
            .unwrap_or("unassigned");

        let indicator = if is_selected { "▸ " } else { "  " };
        let title_style = if is_selected {
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };

        lines.push(Line::from(vec![
            Span::styled(indicator, Style::default().fg(Color::Cyan)),
            Span::styled(&ticket.title, title_style),
            Span::styled(format!(" [{}]", agent), Style::default().fg(Color::DarkGray)),
        ]));

        flat_index += 1;
    }

    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "No tickets",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let paragraph = Paragraph::new(lines)
        .scroll((
            if focused && app.board_scroll > 5 {
                (app.board_scroll - 5) as u16
            } else {
                0
            },
            0,
        ))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(border_style(app, FocusPanel::Center))
                .title(format!(" {} -- Task Board ", channel_name))
                .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD))
                .title_bottom(tab_bar_line(app)),
        );
    frame.render_widget(paragraph, area);
}

fn draw_decisions(frame: &mut Frame, app: &App, channel_name: &str, area: Rect) {
    let focused = app.focus == FocusPanel::Center && app.active_tab == Tab::Decisions;

    let items: Vec<ListItem> = app
        .decisions
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let time = d.created_at.get(..10).unwrap_or("");
            let is_selected = focused && i == app.decisions_scroll;

            let indicator = if is_selected { "▸ " } else { "  " };
            let title_style = if is_selected {
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
            } else {
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
            };

            let line = Line::from(vec![
                Span::styled(indicator, Style::default().fg(Color::Cyan)),
                Span::styled(format!("{} ", time), Style::default().fg(Color::DarkGray)),
                Span::styled(format!("# {}", d.title), title_style),
            ]);
            let detail = Line::from(vec![
                Span::raw("    "),
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
            .border_style(border_style(app, FocusPanel::Center))
            .title(format!(" {} -- Decisions ", channel_name))
            .title_style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD))
            .title_bottom(tab_bar_line(app)),
    );

    let mut state = ListState::default();
    if focused {
        state.select(Some(app.decisions_scroll));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_right(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(6), Constraint::Length(8)])
        .split(area);

    let focused = app.focus == FocusPanel::Right;

    // Active runs — more descriptive
    let run_items: Vec<ListItem> = app
        .active_runs
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let color = status_color(&r.state);
            let is_selected = focused && i == app.runs_scroll;
            let indicator = if is_selected { "▸ " } else { "  " };
            let name_style = if is_selected {
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::White)
            };

            let friendly_state = friendly_state_label(&r.state);

            // Line 1: status icon + friendly state + workspace
            let line = Line::from(vec![
                Span::styled(indicator, Style::default().fg(Color::Cyan)),
                Span::styled(state_icon(&r.state), Style::default().fg(color)),
                Span::styled(format!(" {} ", friendly_state), Style::default().fg(color)),
                Span::styled(
                    format!("({})", &r.workspace),
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
            // Line 2: feature request description
            let max_w = (area.width as usize).saturating_sub(6);
            let desc = truncate(&r.feature_request, max_w);
            let detail = Line::from(vec![
                Span::raw("    "),
                Span::styled(desc, name_style),
            ]);
            // Line 3: spacing
            ListItem::new(vec![line, detail, Line::raw("")])
        })
        .collect();

    let runs_list = List::new(run_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(border_style(app, FocusPanel::Right))
            .title(" Active Runs ")
            .title_style(
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD),
            ),
    );

    let mut state = ListState::default();
    if focused {
        state.select(Some(app.runs_scroll));
    }
    frame.render_stateful_widget(runs_list, chunks[0], &mut state);

    // Summary
    let auto_label = if app.auto_approve { "ON" } else { "OFF" };
    let auto_color = if app.auto_approve { Color::Green } else { Color::DarkGray };
    let summary_lines = vec![
        Line::from(vec![
            Span::styled(format!(" {} ", app.channels.len()), Style::default().fg(Color::Cyan)),
            Span::styled("channels  ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{} ", app.agents.len()), Style::default().fg(Color::Cyan)),
            Span::styled("agents", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled(format!(" {} ", app.tickets.len()), Style::default().fg(Color::Cyan)),
            Span::styled("tickets   ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{} ", app.active_runs.len()), Style::default().fg(Color::Cyan)),
            Span::styled("runs", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(vec![
            Span::styled(" Auto-approve: ", Style::default().fg(Color::DarkGray)),
            Span::styled(auto_label, Style::default().fg(auto_color).add_modifier(Modifier::BOLD)),
        ]),
    ];
    let summary_widget = Paragraph::new(summary_lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(" Summary ")
                .title_style(Style::default().fg(Color::Magenta)),
        );
    frame.render_widget(summary_widget, chunks[1]);
}

fn draw_input_bar(frame: &mut Frame, app: &App, area: Rect) {
    let is_active = app.input_mode == InputMode::Input;

    if is_active {
        let available_width = area.width.saturating_sub(5) as usize; // borders + "> "

        // Count total lines in the buffer (newlines + wrapping)
        let total_lines = if available_width > 0 && !app.input_buffer.is_empty() {
            word_wrap(&app.input_buffer, available_width).len()
        } else {
            1
        };

        // Find which line the cursor is on (1-based for display)
        let cursor_line_num = if available_width > 0 && !app.input_buffer.is_empty() {
            let safe_cursor = app.input_cursor.min(app.input_buffer.len());
            // Find nearest char boundary
            let at = app.input_buffer[..safe_cursor]
                .char_indices()
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            let before = &app.input_buffer[..at];
            word_wrap(before, available_width).len()
        } else {
            1
        };

        // Get the current line's text to display
        let wrapped = if available_width > 0 && !app.input_buffer.is_empty() {
            word_wrap(&app.input_buffer, available_width)
        } else {
            vec![app.input_buffer.clone()]
        };
        let display_line_idx = cursor_line_num.saturating_sub(1).min(wrapped.len().saturating_sub(1));
        let display_text = wrapped.get(display_line_idx).cloned().unwrap_or_default();

        // Build the single display line
        let mut spans = vec![
            Span::styled("> ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw(display_text.clone()),
        ];

        // Show line indicator if multi-line
        if total_lines > 1 {
            spans.push(Span::styled(
                format!("  [{} of {} lines]", cursor_line_num, total_lines),
                Style::default().fg(Color::DarkGray),
            ));
        }

        let content = Paragraph::new(Line::from(spans))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(" Chat ")
                    .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            );
        frame.render_widget(content, area);

        // Place cursor within the displayed line
        let col_in_line = if available_width > 0 && !wrapped.is_empty() {
            let safe_cursor = app.input_cursor.min(app.input_buffer.len());
            let at = app.input_buffer[..safe_cursor]
                .char_indices()
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            let before = &app.input_buffer[..at];
            let wb = word_wrap(before, available_width);
            wb.last().map(|l| char_width(l)).unwrap_or(0)
        } else {
            app.input_cursor
        };
        frame.set_cursor_position(Position::new(
            area.x + 3 + col_in_line as u16,
            area.y + 1,
        ));
    } else {
        // Show active agent hint if repos are configured
        let repo_aliases = app.current_repo_aliases();
        let hint = if !repo_aliases.is_empty() {
            let active = app.active_worker_alias.as_deref().unwrap_or("none");
            let aliases_str = repo_aliases
                .iter()
                .map(|a| format!("@{}", a))
                .collect::<Vec<_>>()
                .join(" ");
            format!("  i:chat  ·  n:new channel  ·  agents: {}  ·  active: @{}", aliases_str, active)
        } else {
            format!("  i:chat  ·  n:new channel  ·  m:{}  ·  tab:switch views",
                if app.mouse_captured { "select text" } else { "mouse mode" })
        };
        let content_line = Line::from(vec![
            Span::styled(hint, Style::default().fg(Color::Rgb(60, 60, 70))),
        ]);

        let input = Paragraph::new(content_line)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Rgb(40, 40, 50))),
            );
        frame.render_widget(input, area);
    }
}

fn draw_new_channel_popup(frame: &mut Frame, app: &App, area: Rect) {
    let dim = Block::default().style(Style::default().bg(Color::Black));
    frame.render_widget(dim, area);

    let popup_width = 50.min(area.width - 4);
    let popup_height = 5;
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    let clear = Clear;
    frame.render_widget(clear, popup_area);

    let input = Paragraph::new(Line::from(vec![
        Span::styled("> ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(&app.input_buffer),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .border_type(BorderType::Double)
            .title(" New Channel Name ")
            .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
            .title_bottom(Line::from(" Enter:create  Esc:cancel ").right_aligned())
            .style(Style::default().bg(Color::Rgb(20, 20, 30))),
    );
    frame.render_widget(input, popup_area);

    frame.set_cursor_position(Position::new(
        popup_area.x + 3 + app.input_cursor as u16,
        popup_area.y + 1,
    ));
}

fn draw_repo_select_popup(frame: &mut Frame, app: &App, area: Rect) {
    let state = match &app.repo_select {
        Some(s) => s,
        None => return,
    };

    let dim = Block::default().style(Style::default().bg(Color::Black));
    frame.render_widget(dim, area);

    let popup_width = 70.min(area.width - 4);
    let popup_height = match state.step {
        RepoSelectStep::Picking => 20.min(area.height - 4),
        RepoSelectStep::Aliasing => (state.aliases.len() as u16 * 2 + 6).min(area.height - 4),
    };
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    frame.render_widget(Clear, popup_area);

    match state.step {
        RepoSelectStep::Picking => {
            // Filter repos
            let filter_lower = state.filter.to_lowercase();
            let filtered: Vec<(usize, &harness_data::WorkspaceEntry)> = state.available_repos.iter().enumerate()
                .filter(|(_, ws)| {
                    filter_lower.is_empty() || {
                        let name = ws.repo_path.split('/').last().unwrap_or(&ws.workspace_id);
                        name.to_lowercase().contains(&filter_lower)
                            || ws.repo_path.to_lowercase().contains(&filter_lower)
                    }
                })
                .collect();

            // Viewport: how many repo lines fit (popup height - header(2) - footer(1) - filter(1) - borders(2))
            let viewport_height = popup_height.saturating_sub(6) as usize;

            // Keep cursor in viewport
            let scroll = if state.cursor >= state.scroll_offset + viewport_height {
                state.cursor.saturating_sub(viewport_height.saturating_sub(1))
            } else if state.cursor < state.scroll_offset {
                state.cursor
            } else {
                state.scroll_offset
            };

            let mut lines: Vec<Line> = Vec::new();

            // Header
            lines.push(Line::from(Span::styled(
                format!(" Select repos for \"{}\":", state.channel_name),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
            )));

            // Filter bar
            if state.filtering {
                lines.push(Line::from(vec![
                    Span::styled(" /", Style::default().fg(Color::Yellow)),
                    Span::styled(&state.filter, Style::default().fg(Color::White)),
                    Span::styled("▌", Style::default().fg(Color::Yellow)),
                ]));
            } else if !state.filter.is_empty() {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!(" filter: {}  ({} matches)", state.filter, filtered.len()),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]));
            } else {
                lines.push(Line::from(Span::styled(
                    format!(" {} repos  /:search", filtered.len()),
                    Style::default().fg(Color::DarkGray),
                )));
            }

            // Scroll indicator if needed
            if scroll > 0 {
                lines.push(Line::from(Span::styled(
                    format!("  ↑ {} more above", scroll),
                    Style::default().fg(Color::DarkGray),
                )));
            }

            // Visible repos
            let visible = filtered.iter().skip(scroll).take(viewport_height);
            for (visible_idx, (real_idx, ws)) in visible.enumerate() {
                let display_idx = scroll + visible_idx;
                let is_cursor = display_idx == state.cursor;
                let is_selected = state.selected.get(*real_idx).copied().unwrap_or(false);
                let checkbox = if is_selected { "[x]" } else { "[ ]" };
                let cursor_indicator = if is_cursor { "▸ " } else { "  " };
                let repo_short = ws.repo_path.split('/').last().unwrap_or(&ws.workspace_id);

                let style = if is_cursor {
                    Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
                } else if is_selected {
                    Style::default().fg(Color::Cyan)
                } else {
                    Style::default().fg(Color::DarkGray)
                };

                let max_path_width = popup_width.saturating_sub(12) as usize;
                let path_display = truncate(&ws.repo_path, max_path_width);

                lines.push(Line::from(vec![
                    Span::styled(cursor_indicator, Style::default().fg(Color::Cyan)),
                    Span::styled(
                        checkbox,
                        Style::default().fg(if is_selected { Color::Green } else { Color::DarkGray }),
                    ),
                    Span::styled(format!(" {}", repo_short), style),
                    Span::styled(
                        format!("  {}", path_display),
                        Style::default().fg(Color::Rgb(60, 60, 70)),
                    ),
                ]));
            }

            // Scroll-down indicator
            let remaining_below = filtered.len().saturating_sub(scroll + viewport_height);
            if remaining_below > 0 {
                lines.push(Line::from(Span::styled(
                    format!("  ↓ {} more below", remaining_below),
                    Style::default().fg(Color::DarkGray),
                )));
            }

            let help = if state.filtering {
                " type to filter  enter:apply  esc:clear "
            } else {
                " space:toggle  /:search  enter:next  esc:cancel "
            };

            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .border_type(BorderType::Double)
                .title(" Select Repos ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
                .title_bottom(Line::from(help).right_aligned())
                .style(Style::default().bg(Color::Rgb(20, 20, 30)));

            let paragraph = Paragraph::new(lines).block(block);
            frame.render_widget(paragraph, popup_area);
        }
        RepoSelectStep::Aliasing => {
            let selected_repos: Vec<&harness_data::WorkspaceEntry> = state
                .available_repos
                .iter()
                .zip(state.selected.iter())
                .filter(|(_, &sel)| sel)
                .map(|(ws, _)| ws)
                .collect();

            let mut lines: Vec<Line> = Vec::new();
            lines.push(Line::from(Span::styled(
                " Set @alias for each repo (used in chat to address agents):",
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::raw(""));

            for (i, ws) in selected_repos.iter().enumerate() {
                let repo_short = ws.repo_path.split('/').last().unwrap_or(&ws.workspace_id);
                let is_active = i == state.alias_cursor;

                lines.push(Line::from(vec![
                    Span::styled(
                        format!("  {} ", repo_short),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::styled("→ @", Style::default().fg(Color::Cyan)),
                    Span::styled(
                        state.aliases.get(i).cloned().unwrap_or_default(),
                        if is_active {
                            Style::default().fg(Color::White).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
                        } else {
                            Style::default().fg(Color::Cyan)
                        },
                    ),
                    if is_active {
                        Span::styled("█", Style::default().fg(Color::Cyan))
                    } else {
                        Span::raw("")
                    },
                ]));
            }

            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .border_type(BorderType::Double)
                .title(" Set Agent Aliases ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
                .title_bottom(
                    Line::from(" tab:next  enter:create  esc:back ").right_aligned(),
                )
                .style(Style::default().bg(Color::Rgb(20, 20, 30)));

            let paragraph = Paragraph::new(lines).block(block);
            frame.render_widget(paragraph, popup_area);
        }
    }
}

fn draw_session_select_popup(frame: &mut Frame, app: &App, area: Rect) {
    let dim = Block::default().style(Style::default().bg(Color::Black));
    frame.render_widget(dim, area);

    let popup_width = 64.min(area.width - 4);
    let popup_height = (app.session_list.len() as u16 + 6).min(area.height - 4).max(8);
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    frame.render_widget(Clear, popup_area);

    let mut lines: Vec<Line> = Vec::new();

    if app.session_list.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No sessions yet. Press n to start a new conversation.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        let active_id = app.active_session.as_ref().map(|s| s.session_id.as_str());
        let max_title_w = (popup_width as usize).saturating_sub(30);

        for (i, session) in app.session_list.iter().enumerate() {
            let is_cursor = i == app.session_cursor;
            let is_active = active_id == Some(session.session_id.as_str());

            let cursor_indicator = if is_cursor { "▸ " } else { "  " };
            let active_marker = if is_active { " *" } else { "" };

            // Format date nicely
            let date = session.updated_at.get(..10).unwrap_or(&session.updated_at);

            let title = if session.title.len() > max_title_w {
                format!("{}...", &session.title[..max_title_w.saturating_sub(3)])
            } else {
                session.title.clone()
            };

            let title_style = if is_cursor {
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
            } else if is_active {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default().fg(Color::Gray)
            };

            lines.push(Line::from(vec![
                Span::styled(cursor_indicator, Style::default().fg(Color::Cyan)),
                Span::styled(title, title_style),
                Span::styled(active_marker, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format!("  {} · {}msg", date, session.message_count),
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .border_type(BorderType::Double)
        .title(" Chat History ")
        .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .title_bottom(
            Line::from(" enter:open  n:new  d:delete  esc:close ").right_aligned(),
        )
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));

    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, popup_area);
}

fn draw_completion_popup(frame: &mut Frame, app: &App, input_area: Rect) {
    let items = &app.completion_items;
    if items.is_empty() {
        return;
    }

    let max_visible = 8.min(items.len());
    let popup_height = max_visible as u16 + 2; // +2 for borders
    let popup_width = 40.min(input_area.width.saturating_sub(4));

    // Position above the input bar
    let popup_y = input_area.y.saturating_sub(popup_height);
    let popup_x = input_area.x + 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    frame.render_widget(Clear, popup_area);

    let list_items: Vec<ListItem> = items
        .iter()
        .enumerate()
        .take(max_visible)
        .map(|(i, item)| {
            let is_selected = i == app.completion_cursor;
            let kind_icon = match item.kind {
                CompletionKind::Repo => "  ",
                CompletionKind::Agent => "  ",
                CompletionKind::Channel => "# ",
            };
            let style = if is_selected {
                Style::default().fg(Color::White).bg(Color::Rgb(50, 50, 70)).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            ListItem::new(Line::from(vec![
                Span::styled(kind_icon, style),
                Span::styled(&item.label, style),
            ]))
        })
        .collect();

    let list = List::new(list_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .style(Style::default().bg(Color::Rgb(25, 25, 35)))
            .title(" @ Mentions ")
            .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
    );

    frame.render_widget(list, popup_area);
}

fn draw_detail_popup(frame: &mut Frame, app: &App, area: Rect) {
    let dim = Block::default().style(Style::default().bg(Color::Black));
    frame.render_widget(dim, area);

    let popup_width = (area.width as f32 * 0.65) as u16;
    let popup_height = (area.height as f32 * 0.65) as u16;
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    let clear = Clear;
    frame.render_widget(clear, popup_area);

    let (title, lines) = detail_content(app);

    let paragraph = Paragraph::new(lines)
        .scroll((app.detail_scroll as u16, 0))
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .border_type(BorderType::Double)
                .title(format!(" {} ", title))
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
                .title_bottom(Line::from(" Esc:close  j/k:scroll ").right_aligned())
                .style(Style::default().bg(Color::Rgb(20, 20, 30))),
        );
    frame.render_widget(paragraph, popup_area);
}

fn detail_content<'a>(app: &'a App) -> (String, Vec<Line<'a>>) {
    match app.focus {
        FocusPanel::Sidebar => {
            if let Some(ch) = app.channels.get(app.selected_channel) {
                let mut lines = vec![
                    Line::from(vec![
                        Span::styled("Name: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&ch.name, Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
                    ]),
                    Line::from(vec![
                        Span::styled("Status: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(&ch.status, Style::default().fg(Color::Green)),
                    ]),
                    Line::from(vec![
                        Span::styled("Description: ", Style::default().fg(Color::DarkGray)),
                        Span::raw(&ch.description),
                    ]),
                    Line::raw(""),
                    Line::from(Span::styled("Members:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
                ];
                for m in &ch.members {
                    lines.push(Line::from(vec![
                        Span::raw("  "),
                        Span::styled(&m.display_name, Style::default().fg(Color::Cyan)),
                        Span::styled(format!(" ({})", m.role), Style::default().fg(Color::DarkGray)),
                        Span::raw(" -- "),
                        Span::styled(&m.status, Style::default().fg(if m.status == "active" { Color::Green } else { Color::DarkGray })),
                    ]));
                }
                // Repo assignments
                if !ch.repo_assignments.is_empty() {
                    lines.push(Line::raw(""));
                    lines.push(Line::from(Span::styled("Repos:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))));
                    for r in &ch.repo_assignments {
                        let repo_short = r.repo_path.split('/').last().unwrap_or(&r.repo_path);
                        let is_streaming = app.is_worker_streaming(&r.alias);
                        let status_icon = if is_streaming { "● " } else { "○ " };
                        let status_color = if is_streaming { Color::Green } else { Color::DarkGray };
                        lines.push(Line::from(vec![
                            Span::styled(format!("  {}", status_icon), Style::default().fg(status_color)),
                            Span::styled(format!("@{}", r.alias), Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                            Span::styled(format!("  {}", repo_short), Style::default().fg(Color::White)),
                        ]));
                        lines.push(Line::from(vec![
                            Span::raw("      "),
                            Span::styled(&r.repo_path, Style::default().fg(Color::DarkGray)),
                        ]));
                    }
                } else {
                    lines.push(Line::raw(""));
                    lines.push(Line::from(vec![
                        Span::styled("Repos: ", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
                        Span::styled("none (press ", Style::default().fg(Color::DarkGray)),
                        Span::styled("r", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                        Span::styled(" to add repos)", Style::default().fg(Color::DarkGray)),
                    ]));
                }

                if !ch.pinned_refs.is_empty() {
                    lines.push(Line::raw(""));
                    lines.push(Line::from(Span::styled("Pinned Refs:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))));
                    for r in &ch.pinned_refs {
                        lines.push(Line::from(vec![
                            Span::raw("  "),
                            Span::styled(&r.label, Style::default().fg(Color::Cyan)),
                            Span::styled(format!(" [{}]", r.ref_type), Style::default().fg(Color::DarkGray)),
                        ]));
                    }
                }
                (format!("Channel: {}", ch.name), lines)
            } else {
                ("No channel".to_string(), vec![])
            }
        }
        FocusPanel::Center => match app.active_tab {
            Tab::Chat => {
                if let Some(msg) = app.chat_messages.get(app.chat_scroll) {
                    let role_label = match msg.role {
                        ChatRole::User => "You",
                        ChatRole::Assistant => "Claude",
                        ChatRole::System => "System",
                        ChatRole::Activity => "Activity",
                    };
                    let mut lines = vec![
                        Line::from(vec![
                            Span::styled("From: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(role_label, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                        ]),
                        Line::from(vec![
                            Span::styled("Time: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(&msg.timestamp),
                        ]),
                        Line::raw(""),
                        Line::from(Span::styled("Content:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
                        Line::raw(""),
                    ];
                    // Render markdown in detail popup too
                    let popup_width = 80; // approximate
                    let md_lines = render_markdown(&msg.content, popup_width);
                    lines.extend(md_lines);
                    ("Chat Message".to_string(), lines)
                } else {
                    ("No message".to_string(), vec![])
                }
            }
            Tab::Board => {
                let sorted = app.sorted_ticket_indices();
                if let Some(&idx) = sorted.get(app.board_scroll) {
                    let ticket = &app.tickets[idx];
                    let agent = ticket.assigned_agent_name.as_deref().unwrap_or("unassigned");
                    let status_clr = status_color(&ticket.status);
                    let lines = vec![
                        Line::from(vec![
                            Span::styled("Title: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(&ticket.title, Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
                        ]),
                        Line::from(vec![
                            Span::styled("Status: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(&ticket.status, Style::default().fg(status_clr).add_modifier(Modifier::BOLD)),
                        ]),
                        Line::from(vec![
                            Span::styled("Specialty: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(&ticket.specialty),
                        ]),
                        Line::from(vec![
                            Span::styled("Assigned: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(agent, Style::default().fg(Color::Cyan)),
                        ]),
                        Line::from(vec![
                            Span::styled("Verification: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(&ticket.verification),
                        ]),
                        Line::from(vec![
                            Span::styled("Attempt: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(format!("{}", ticket.attempt)),
                        ]),
                        Line::from(vec![
                            Span::styled("Ticket ID: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(&ticket.ticket_id, Style::default().fg(Color::DarkGray)),
                        ]),
                        Line::raw(""),
                        Line::from(vec![
                            Span::styled("Dependencies: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(if ticket.depends_on.is_empty() {
                                "none".to_string()
                            } else {
                                ticket.depends_on.join(", ")
                            }),
                        ]),
                    ];
                    (format!("Ticket: {}", ticket.title), lines)
                } else {
                    ("No ticket".to_string(), vec![])
                }
            }
            Tab::Decisions => {
                if let Some(d) = app.decisions.get(app.decisions_scroll) {
                    let mut lines = vec![
                        Line::from(vec![
                            Span::styled("Title: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(&d.title, Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
                        ]),
                        Line::from(vec![
                            Span::styled("Decided by: ", Style::default().fg(Color::DarkGray)),
                            Span::styled(&d.decided_by_name, Style::default().fg(Color::Cyan)),
                        ]),
                        Line::from(vec![
                            Span::styled("Date: ", Style::default().fg(Color::DarkGray)),
                            Span::raw(&d.created_at),
                        ]),
                        Line::raw(""),
                        Line::from(Span::styled("Description:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
                        Line::raw(d.description.clone()),
                        Line::raw(""),
                        Line::from(Span::styled("Rationale:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
                        Line::raw(d.rationale.clone()),
                    ];
                    if !d.alternatives.is_empty() {
                        lines.push(Line::raw(""));
                        lines.push(Line::from(Span::styled("Alternatives considered:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))));
                        for alt in &d.alternatives {
                            lines.push(Line::from(vec![
                                Span::raw("  - "),
                                Span::raw(alt.as_str()),
                            ]));
                        }
                    }
                    (format!("Decision: {}", d.title), lines)
                } else {
                    ("No decision".to_string(), vec![])
                }
            }
        },
        FocusPanel::Right => {
            if let Some(r) = app.active_runs.get(app.runs_scroll) {
                let color = status_color(&r.state);
                let lines = vec![
                    Line::from(vec![
                        Span::styled("Run ID: ", Style::default().fg(Color::DarkGray)),
                        Span::raw(&r.run_id),
                    ]),
                    Line::from(vec![
                        Span::styled("State: ", Style::default().fg(Color::DarkGray)),
                        Span::styled(
                            format!("{} ({})", friendly_state_label(&r.state), &r.state),
                            Style::default().fg(color).add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::from(vec![
                        Span::styled("Workspace: ", Style::default().fg(Color::DarkGray)),
                        Span::raw(&r.workspace),
                    ]),
                    Line::raw(""),
                    Line::from(Span::styled("Feature Request:", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))),
                    Line::raw(r.feature_request.clone()),
                ];
                ("Active Run".to_string(), lines)
            } else {
                ("No run".to_string(), vec![])
            }
        }
    }
}

fn help_text(app: &App) -> String {
    if app.input_mode == InputMode::Input {
        return " enter:send  esc:cancel".to_string();
    }
    if app.input_mode == InputMode::NewChannel {
        return " enter:create  esc:cancel".to_string();
    }
    if app.show_detail {
        return " esc:close  j/k:scroll".to_string();
    }
    match app.focus {
        FocusPanel::Sidebar => " j/k:nav  n:new  d:delete  r:repos  s:sessions".to_string(),
        FocusPanel::Center => " j/k:scroll  h/l:panel  s:sessions  m:select".to_string(),
        FocusPanel::Right => " j/k:nav  h:left  enter:detail  m:select".to_string(),
    }
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

/// Map raw state codes to human-readable labels
fn friendly_state_label(state: &str) -> &'static str {
    match state {
        "CLASSIFYING" => "Classifying",
        "DRAFT_PLAN" => "Drafting Plan",
        "PLAN_REVIEW" => "Reviewing Plan",
        "AWAITING_APPROVAL" => "Awaiting Approval",
        "DESIGN_DOC" => "Design Doc",
        "PHASE_READY" => "Ready",
        "PHASE_EXECUTE" => "Executing",
        "TEST_FIX_LOOP" => "Testing",
        "REVIEW_FIX_LOOP" => "In Review",
        "TICKETS_EXECUTING" => "Running Tasks",
        "TICKETS_COMPLETE" => "Tasks Done",
        "COMPLETE" => "Complete",
        "FAILED" => "Failed",
        "BLOCKED" => "Blocked",
        _ => "Active",
    }
}

/// Map state to a small icon
fn state_icon(state: &str) -> &'static str {
    match state {
        "CLASSIFYING" => "◎",
        "DRAFT_PLAN" | "PLAN_REVIEW" => "✎",
        "AWAITING_APPROVAL" => "⏳",
        "DESIGN_DOC" => "📋",
        "PHASE_READY" => "▶",
        "PHASE_EXECUTE" | "TICKETS_EXECUTING" => "⚡",
        "TEST_FIX_LOOP" => "🧪",
        "REVIEW_FIX_LOOP" => "🔍",
        "TICKETS_COMPLETE" | "COMPLETE" => "✓",
        "FAILED" => "✗",
        "BLOCKED" => "⊘",
        _ => "●",
    }
}

// ─── Markdown Rendering ───────────────────────────────────────────────────────

const MD_TEXT: Color = Color::Rgb(200, 200, 210);
const MD_CODE_FG: Color = Color::Rgb(220, 180, 120);
const MD_CODE_BG: Color = Color::Rgb(35, 35, 45);
const MD_QUOTE_FG: Color = Color::Rgb(140, 140, 160);
const MD_QUOTE_BAR: Color = Color::Rgb(80, 80, 100);
const MD_TABLE_BORDER: Color = Color::Rgb(70, 70, 90);
const MD_TABLE_HEADER: Color = Color::Rgb(180, 200, 255);
const MD_LINK_FG: Color = Color::Rgb(100, 160, 255);

/// Render a markdown string into styled ratatui Lines.
fn render_markdown<'a>(text: &str, max_width: usize) -> Vec<Line<'a>> {
    let mut lines: Vec<Line> = Vec::new();
    let mut in_code_block = false;
    let mut code_block_lines: Vec<String> = Vec::new();
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut in_table = false;

    let raw_lines: Vec<&str> = text.split('\n').collect();
    let mut i = 0;

    while i < raw_lines.len() {
        let raw_line = raw_lines[i];
        let trimmed = raw_line.trim();

        // ── Code block fences ──
        if trimmed.starts_with("```") {
            // Flush any pending table
            if in_table {
                render_table(&table_rows, max_width, &mut lines);
                table_rows.clear();
                in_table = false;
            }

            if in_code_block {
                for cl in &code_block_lines {
                    lines.push(Line::from(Span::styled(
                        take_chars(cl, max_width).to_string(),
                        Style::default().fg(Color::Rgb(180, 180, 200)).bg(MD_CODE_BG),
                    )));
                }
                code_block_lines.clear();
                in_code_block = false;
            } else {
                let lang = trimmed.trim_start_matches('`').trim();
                if !lang.is_empty() {
                    lines.push(Line::from(Span::styled(
                        format!("  {}", lang),
                        Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                    )));
                }
                in_code_block = true;
            }
            i += 1;
            continue;
        }

        if in_code_block {
            code_block_lines.push(format!("  {}", raw_line));
            i += 1;
            continue;
        }

        // ── Table detection (line with | separators) ──
        if trimmed.contains('|') && trimmed.starts_with('|') {
            // Skip separator rows like |---|---|
            let is_separator = trimmed.chars().all(|c| c == '|' || c == '-' || c == ':' || c == ' ');
            if !is_separator {
                let cells: Vec<String> = trimmed
                    .split('|')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.trim().to_string())
                    .collect();
                if !cells.is_empty() {
                    table_rows.push(cells);
                    in_table = true;
                }
            }
            i += 1;
            continue;
        }

        // Flush table if we hit a non-table line
        if in_table {
            render_table(&table_rows, max_width, &mut lines);
            table_rows.clear();
            in_table = false;
        }

        // ── Horizontal rule ──
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            let rule = "─".repeat(max_width.min(60));
            lines.push(Line::from(Span::styled(rule, Style::default().fg(Color::DarkGray))));
            i += 1;
            continue;
        }

        // ── Headers ──
        if trimmed.starts_with("#### ") {
            let h = trimmed.trim_start_matches("#### ");
            lines.push(Line::from(Span::styled(
                format!("    {}", h),
                Style::default().fg(Color::Rgb(180, 180, 200)).add_modifier(Modifier::BOLD),
            )));
            i += 1;
            continue;
        }
        if trimmed.starts_with("### ") {
            let h = trimmed.trim_start_matches("### ");
            lines.push(Line::from(Span::styled(
                format!("   {}", h),
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            )));
            i += 1;
            continue;
        }
        if trimmed.starts_with("## ") {
            let h = trimmed.trim_start_matches("## ");
            lines.push(Line::from(Span::styled(
                format!("  {}", h),
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
            i += 1;
            continue;
        }
        if trimmed.starts_with("# ") {
            let h = trimmed.trim_start_matches("# ");
            lines.push(Line::from(Span::styled(
                h.to_string(),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
            i += 1;
            continue;
        }

        // ── Empty line ──
        if trimmed.is_empty() {
            lines.push(Line::raw(""));
            i += 1;
            continue;
        }

        // ── Blockquotes ──
        if trimmed.starts_with("> ") || trimmed == ">" {
            let quote_text = if trimmed.len() > 2 { &trimmed[2..] } else { "" };
            let content_width = max_width.saturating_sub(3);
            let wrapped = word_wrap(quote_text, content_width);
            for wline in &wrapped {
                let mut spans = vec![
                    Span::styled("▎ ", Style::default().fg(MD_QUOTE_BAR)),
                ];
                spans.extend(parse_inline_markdown_with_color(wline, MD_QUOTE_FG));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // ── Task lists ──
        if trimmed.starts_with("- [x] ") || trimmed.starts_with("- [X] ") {
            let rest = &trimmed[6..];
            let content_width = max_width.saturating_sub(5);
            let wrapped = word_wrap(rest, content_width);
            for (wi, wline) in wrapped.iter().enumerate() {
                let prefix = if wi == 0 { "  ☑ " } else { "    " };
                let mut spans: Vec<Span> = vec![Span::styled(prefix, Style::default().fg(Color::Green))];
                spans.extend(parse_inline_markdown(wline));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }
        if trimmed.starts_with("- [ ] ") {
            let rest = &trimmed[6..];
            let content_width = max_width.saturating_sub(5);
            let wrapped = word_wrap(rest, content_width);
            for (wi, wline) in wrapped.iter().enumerate() {
                let prefix = if wi == 0 { "  ☐ " } else { "    " };
                let mut spans: Vec<Span> = vec![Span::styled(prefix, Style::default().fg(Color::DarkGray))];
                spans.extend(parse_inline_markdown(wline));
                lines.push(Line::from(spans));
            }
            i += 1;
            continue;
        }

        // ── Bullet lists ──
        let (indent, rest) = if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            ("  • ".to_string(), &trimmed[2..])
        } else if trimmed.starts_with("  - ") || trimmed.starts_with("  * ") {
            ("    ◦ ".to_string(), &trimmed[4..])
        } else if trimmed.starts_with("    - ") || trimmed.starts_with("    * ") {
            ("      ‣ ".to_string(), &trimmed[6..])
        } else if let Some(rest) = strip_numbered_list(trimmed) {
            ("  ".to_string(), rest)
        } else {
            (String::new(), trimmed)
        };

        let content_width = max_width.saturating_sub(char_width(&indent));
        let wrapped = word_wrap(rest, content_width);

        for (wi, wline) in wrapped.iter().enumerate() {
            let prefix = if wi == 0 { indent.clone() } else { " ".repeat(char_width(&indent)) };
            let mut spans: Vec<Span> = vec![Span::raw(prefix)];
            spans.extend(parse_inline_markdown(wline));
            lines.push(Line::from(spans));
        }

        i += 1;
    }

    // Flush pending table
    if in_table {
        render_table(&table_rows, max_width, &mut lines);
    }

    // Flush any unclosed code block
    if in_code_block {
        for cl in &code_block_lines {
            lines.push(Line::from(Span::styled(
                cl.clone(),
                Style::default().fg(Color::Rgb(180, 180, 200)).bg(MD_CODE_BG),
            )));
        }
    }

    lines
}

/// Render a markdown table as a clean, compact list.
/// Each row shows truncated columns with visual separators.
/// For wide tables that won't fit, drops trailing columns and shows the
/// most important data (first 2-3 columns) clearly.
fn render_table<'a>(rows: &[Vec<String>], max_width: usize, lines: &mut Vec<Line<'a>>) {
    if rows.is_empty() { return; }

    let col_count = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if col_count == 0 { return; }

    // Figure out how many columns we can fit.
    // Give each column: min 6 chars content + 3 overhead (space + separator + space)
    let per_col_overhead = 3usize;
    let min_col_content = 6usize;
    let usable = max_width.saturating_sub(2); // left margin
    let max_cols = (usable / (min_col_content + per_col_overhead)).max(1).min(col_count);

    // Measure ideal widths for the columns we'll show
    let mut ideal_widths: Vec<usize> = vec![0; max_cols];
    for row in rows {
        for j in 0..max_cols {
            if let Some(cell) = row.get(j) {
                ideal_widths[j] = ideal_widths[j].max(char_width(cell));
            }
        }
    }

    // Allocate widths: fit to available space
    let separator_space = if max_cols > 1 { (max_cols - 1) * 3 } else { 0 }; // " · " between cols
    let content_budget = usable.saturating_sub(separator_space);
    let total_ideal: usize = ideal_widths.iter().sum();

    let col_widths: Vec<usize> = if total_ideal <= content_budget {
        ideal_widths
    } else {
        // Proportional distribution with a floor
        let mut widths = vec![0usize; max_cols];
        for (j, &ideal) in ideal_widths.iter().enumerate() {
            let share = if total_ideal > 0 {
                ((ideal as f64 / total_ideal as f64) * content_budget as f64).floor() as usize
            } else {
                content_budget / max_cols
            };
            widths[j] = share.max(min_col_content);
        }
        widths
    };

    // Header row
    if let Some(header) = rows.first() {
        let mut spans: Vec<Span> = Vec::new();
        for j in 0..max_cols {
            if j > 0 {
                spans.push(Span::styled("   ", Style::default().fg(MD_TABLE_BORDER)));
            }
            let cell = header.get(j).map(|s| s.as_str()).unwrap_or("");
            // Strip markdown markers from header text since we style it bold already
            let clean = strip_inline_markdown(cell);
            let display = truncate(&clean, col_widths[j]);
            let pad = col_widths[j].saturating_sub(char_width(&display));
            spans.push(Span::styled(
                format!("{}{}", display, " ".repeat(pad)),
                Style::default().fg(MD_TABLE_HEADER).add_modifier(Modifier::BOLD),
            ));
        }
        if max_cols < col_count {
            spans.push(Span::styled(
                format!("  +{}", col_count - max_cols),
                Style::default().fg(Color::DarkGray),
            ));
        }
        lines.push(Line::from(spans));

        // Separator under header
        let rule_width = col_widths.iter().sum::<usize>() + separator_space;
        lines.push(Line::from(Span::styled(
            "─".repeat(rule_width.min(max_width)),
            Style::default().fg(MD_TABLE_BORDER),
        )));
    }

    // Data rows — parse inline markdown in each cell
    for row in rows.iter().skip(1) {
        let mut spans: Vec<Span> = Vec::new();
        for j in 0..max_cols {
            if j > 0 {
                spans.push(Span::styled(" · ", Style::default().fg(MD_TABLE_BORDER)));
            }
            let cell = row.get(j).map(|s| s.as_str()).unwrap_or("");
            let display = truncate(cell, col_widths[j]);
            let pad = col_widths[j].saturating_sub(char_width(&display));
            // Parse inline markdown so **bold**, `code`, etc. render properly
            spans.extend(parse_inline_markdown(&display));
            if pad > 0 {
                spans.push(Span::raw(" ".repeat(pad)));
            }
        }
        lines.push(Line::from(spans));
    }

    // Spacer after table
    lines.push(Line::raw(""));
}

/// Check if a line is a numbered list item like "1. foo" and return the rest
fn strip_numbered_list(s: &str) -> Option<&str> {
    let s = s.trim_start();
    let dot_pos = s.find(". ")?;
    if dot_pos > 0 && dot_pos <= 3 && s[..dot_pos].chars().all(|c| c.is_ascii_digit()) {
        Some(&s[dot_pos + 2..])
    } else {
        None
    }
}

/// Strip inline markdown markers, returning plain text.
/// e.g. "**bold** and `code`" → "bold and code"
fn strip_inline_markdown(text: &str) -> String {
    text.replace("***", "")
        .replace("**", "")
        .replace('*', "")
        .replace('`', "")
        .replace("~~", "")
}

/// Parse inline markdown with default text color
fn parse_inline_markdown(text: &str) -> Vec<Span<'static>> {
    parse_inline_markdown_with_color(text, MD_TEXT)
}

/// Parse inline markdown: **bold**, *italic*, `code`, ~~strike~~, [link](url)
fn parse_inline_markdown_with_color(text: &str, base_color: Color) -> Vec<Span<'static>> {
    let mut spans: Vec<Span> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut pos = 0;
    let mut plain_buf = String::new();

    let flush_plain = |buf: &mut String, spans: &mut Vec<Span>, color: Color| {
        if !buf.is_empty() {
            spans.push(Span::styled(buf.clone(), Style::default().fg(color)));
            buf.clear();
        }
    };

    while pos < len {
        // ── Inline code ──
        if chars[pos] == '`' {
            if let Some(end) = find_closing(&chars, pos + 1, '`') {
                flush_plain(&mut plain_buf, &mut spans, base_color);
                let inner: String = chars[pos + 1..end].iter().collect();
                spans.push(Span::styled(inner, Style::default().fg(MD_CODE_FG).bg(MD_CODE_BG)));
                pos = end + 1;
                continue;
            }
        }

        // ── Links: [text](url) ──
        if chars[pos] == '[' {
            if let Some(close_bracket) = find_closing(&chars, pos + 1, ']') {
                if close_bracket + 1 < len && chars[close_bracket + 1] == '(' {
                    if let Some(close_paren) = find_closing(&chars, close_bracket + 2, ')') {
                        flush_plain(&mut plain_buf, &mut spans, base_color);
                        let link_text: String = chars[pos + 1..close_bracket].iter().collect();
                        spans.push(Span::styled(
                            link_text,
                            Style::default().fg(MD_LINK_FG).add_modifier(Modifier::UNDERLINED),
                        ));
                        pos = close_paren + 1;
                        continue;
                    }
                }
            }
        }

        // ── Strikethrough ~~ ──
        if pos + 1 < len && chars[pos] == '~' && chars[pos + 1] == '~' {
            if let Some(end) = find_double_closing(&chars, pos + 2, '~') {
                flush_plain(&mut plain_buf, &mut spans, base_color);
                let inner: String = chars[pos + 2..end].iter().collect();
                spans.push(Span::styled(
                    inner,
                    Style::default().fg(Color::DarkGray).add_modifier(Modifier::CROSSED_OUT),
                ));
                pos = end + 2;
                continue;
            }
        }

        // ── Bold-italic *** ──
        if pos + 2 < len && chars[pos] == '*' && chars[pos + 1] == '*' && chars[pos + 2] == '*' {
            if let Some(end) = find_triple_closing(&chars, pos + 3, '*') {
                flush_plain(&mut plain_buf, &mut spans, base_color);
                let inner: String = chars[pos + 3..end].iter().collect();
                spans.push(Span::styled(
                    inner,
                    Style::default().fg(Color::White).add_modifier(Modifier::BOLD | Modifier::ITALIC),
                ));
                pos = end + 3;
                continue;
            }
        }

        // ── Bold ** ──
        if pos + 1 < len && chars[pos] == '*' && chars[pos + 1] == '*' {
            if let Some(end) = find_double_closing(&chars, pos + 2, '*') {
                flush_plain(&mut plain_buf, &mut spans, base_color);
                let inner: String = chars[pos + 2..end].iter().collect();
                spans.push(Span::styled(
                    inner,
                    Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
                ));
                pos = end + 2;
                continue;
            }
        }

        // ── Italic * ──
        if chars[pos] == '*' {
            if let Some(end) = find_closing(&chars, pos + 1, '*') {
                flush_plain(&mut plain_buf, &mut spans, base_color);
                let inner: String = chars[pos + 1..end].iter().collect();
                spans.push(Span::styled(
                    inner,
                    Style::default().fg(base_color).add_modifier(Modifier::ITALIC),
                ));
                pos = end + 1;
                continue;
            }
        }

        // ── Plain character ──
        plain_buf.push(chars[pos]);
        pos += 1;
    }

    flush_plain(&mut plain_buf, &mut spans, base_color);
    spans
}

/// Find the position of a closing single char (not preceded by backslash)
fn find_closing(chars: &[char], start: usize, marker: char) -> Option<usize> {
    for i in start..chars.len() {
        if chars[i] == marker {
            return Some(i);
        }
    }
    None
}

/// Find closing double marker (e.g. ** or ~~)
fn find_double_closing(chars: &[char], start: usize, marker: char) -> Option<usize> {
    let len = chars.len();
    for i in start..len.saturating_sub(1) {
        if chars[i] == marker && chars[i + 1] == marker {
            return Some(i);
        }
    }
    None
}

/// Find closing triple marker (***)
fn find_triple_closing(chars: &[char], start: usize, marker: char) -> Option<usize> {
    let len = chars.len();
    for i in start..len.saturating_sub(2) {
        if chars[i] == marker && chars[i + 1] == marker && chars[i + 2] == marker {
            return Some(i);
        }
    }
    None
}

/// Simple word-wrap that breaks on word boundaries
/// Count display width in characters (not bytes)
fn char_width(s: &str) -> usize {
    s.chars().count()
}

/// Take up to `n` characters from a string (char-safe, no byte-boundary panics)
fn take_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((byte_pos, _)) => &s[..byte_pos],
        None => s,
    }
}

/// Skip the first `n` characters of a string
fn skip_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((byte_pos, _)) => &s[byte_pos..],
        None => "",
    }
}

fn word_wrap(s: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![s.to_string()];
    }

    let mut lines = Vec::new();

    for paragraph in s.split('\n') {
        if paragraph.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current_line = String::new();

        for word in paragraph.split_whitespace() {
            let word_len = char_width(word);
            let line_len = char_width(&current_line);

            if current_line.is_empty() {
                if word_len > max_width {
                    // Hard-wrap long words at character boundaries
                    let mut remaining = word;
                    while char_width(remaining) > max_width {
                        lines.push(take_chars(remaining, max_width).to_string());
                        remaining = skip_chars(remaining, max_width);
                    }
                    current_line = remaining.to_string();
                } else {
                    current_line = word.to_string();
                }
            } else if line_len + 1 + word_len > max_width {
                lines.push(current_line);
                current_line = word.to_string();
            } else {
                current_line.push(' ');
                current_line.push_str(word);
            }
        }

        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }

    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}

fn truncate(s: &str, max: usize) -> String {
    if char_width(s) <= max {
        s.to_string()
    } else {
        format!("{}...", take_chars(s, max.saturating_sub(3)))
    }
}

/// Draw a highlight overlay for the current text selection within a panel's inner area.
/// Selection positions are content-relative (line_index, col); we convert to screen
/// coordinates using the scroll offset so the highlight tracks the text through scrolls.
fn draw_selection_highlight(frame: &mut Frame, selection: &TextSelection, inner: Rect, scroll_offset: usize) {
    if selection.start == selection.end {
        return;
    }

    // Normalize so start <= end
    let (start_line, start_col, end_line, end_col) = if selection.start.0 < selection.end.0
        || (selection.start.0 == selection.end.0 && selection.start.1 <= selection.end.1)
    {
        (selection.start.0, selection.start.1, selection.end.0, selection.end.1)
    } else {
        (selection.end.0, selection.end.1, selection.start.0, selection.start.1)
    };

    let visible_height = inner.height as usize;
    let highlight_style = Style::default().bg(Color::Rgb(60, 80, 120));

    for content_line in start_line..=end_line {
        // Skip lines not currently visible
        if content_line < scroll_offset || content_line >= scroll_offset + visible_height {
            continue;
        }

        let screen_row = inner.y + (content_line - scroll_offset) as u16;

        let col_from = if content_line == start_line {
            inner.x + start_col as u16
        } else {
            inner.x
        };
        let col_to = if content_line == end_line {
            (inner.x + end_col as u16 + 1).min(inner.x + inner.width)
        } else {
            inner.x + inner.width
        };

        if col_from >= col_to {
            continue;
        }

        let area = Rect::new(col_from, screen_row, col_to - col_from, 1);
        frame.render_widget(
            Block::default().style(highlight_style),
            area,
        );
    }
}
