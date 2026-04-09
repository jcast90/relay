use ratatui::{
    prelude::*,
    widgets::*,
};

use crate::{App, ChatRole, CompletionKind, FocusPanel, InputMode, RepoSelectStep, Tab};

pub fn draw(frame: &mut Frame, app: &mut App) {
    let size = frame.area();

    // Calculate input height: wrap the input buffer text
    let input_height = if app.input_mode == InputMode::Input && !app.input_buffer.is_empty() {
        let available_width = size.width.saturating_sub(5) as usize; // 2 border + "> " + pad
        if available_width > 0 {
            let lines = (app.input_buffer.len() as f32 / available_width as f32).ceil() as u16;
            lines.max(1) + 2 // +2 for borders
        } else {
            3
        }
    } else {
        3
    };
    let input_height = input_height.min(8); // cap at 8 lines

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
        let alias_space = if alias_badge.is_some() {
            Span::raw(" ")
        } else {
            Span::raw("")
        };

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

    let paragraph = Paragraph::new(lines)
        .scroll((scroll_offset as u16, 0));
    frame.render_widget(paragraph, inner);

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
        // Wrap input text
        let available_width = area.width.saturating_sub(5) as usize; // borders + "> "
        let wrapped = if available_width > 0 && !app.input_buffer.is_empty() {
            word_wrap(&app.input_buffer, available_width)
        } else {
            vec![app.input_buffer.clone()]
        };

        let mut lines: Vec<Line> = Vec::new();
        for (i, line_text) in wrapped.iter().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled("> ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                    Span::raw(line_text.as_str()),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::raw("  "),
                    Span::raw(line_text.as_str()),
                ]));
            }
        }

        if lines.is_empty() {
            lines.push(Line::from(vec![
                Span::styled("> ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            ]));
        }

        let title = " Chat ".to_string();
        let input = Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Cyan))
                    .title(title)
                    .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            );
        frame.render_widget(input, area);

        // Place cursor at correct wrapped position by walking wrapped lines
        let (cursor_line, cursor_col) = if available_width > 0 && !wrapped.is_empty() {
            let mut remaining = app.input_cursor;
            let mut line_idx = 0;
            for (i, wline) in wrapped.iter().enumerate() {
                let len = wline.len();
                if remaining <= len || i == wrapped.len() - 1 {
                    line_idx = i;
                    break;
                }
                // +1 accounts for the space/break between wrapped segments
                remaining = remaining.saturating_sub(len + 1);
                line_idx = i + 1;
            }
            (line_idx, remaining)
        } else {
            (0, app.input_cursor)
        };
        frame.set_cursor_position(Position::new(
            area.x + 3 + cursor_col as u16,
            area.y + 1 + cursor_line as u16,
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

    let popup_width = 60.min(area.width - 4);
    let popup_height = match state.step {
        RepoSelectStep::Picking => (state.available_repos.len() as u16 + 6).min(area.height - 4),
        RepoSelectStep::Aliasing => (state.aliases.len() as u16 * 2 + 6).min(area.height - 4),
    };
    let popup_x = (area.width - popup_width) / 2;
    let popup_y = (area.height - popup_height) / 2;
    let popup_area = Rect::new(popup_x, popup_y, popup_width, popup_height);

    frame.render_widget(Clear, popup_area);

    match state.step {
        RepoSelectStep::Picking => {
            let mut lines: Vec<Line> = Vec::new();
            lines.push(Line::from(Span::styled(
                format!(" Select repos for \"{}\":", state.channel_name),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::raw(""));

            for (i, ws) in state.available_repos.iter().enumerate() {
                let is_cursor = i == state.cursor;
                let is_selected = state.selected.get(i).copied().unwrap_or(false);
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

                lines.push(Line::from(vec![
                    Span::styled(cursor_indicator, Style::default().fg(Color::Cyan)),
                    Span::styled(
                        checkbox,
                        Style::default().fg(if is_selected { Color::Green } else { Color::DarkGray }),
                    ),
                    Span::styled(format!(" {}", repo_short), style),
                    Span::styled(
                        format!("  {}", ws.repo_path),
                        Style::default().fg(Color::Rgb(60, 60, 70)),
                    ),
                ]));
            }

            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .border_type(BorderType::Double)
                .title(" Select Repos ")
                .title_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
                .title_bottom(
                    Line::from(" space:toggle  enter:next  esc:cancel ").right_aligned(),
                )
                .style(Style::default().bg(Color::Rgb(20, 20, 30)));

            let paragraph = Paragraph::new(lines).block(block);
            frame.render_widget(paragraph, popup_area);
        }
        RepoSelectStep::Aliasing => {
            let selected_repos: Vec<&crate::data::WorkspaceEntry> = state
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
        FocusPanel::Sidebar => " j/k:nav  n:new  r:repos  s:sessions".to_string(),
        FocusPanel::Center => " j/k:scroll  h/l:panel  s:sessions".to_string(),
        FocusPanel::Right => " j/k:nav  h:left  enter:detail".to_string(),
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

/// Render a markdown string into styled ratatui Lines.
/// Handles: headers, bold, italic, code blocks, inline code, lists, horizontal rules.
fn render_markdown<'a>(text: &str, max_width: usize) -> Vec<Line<'a>> {
    let mut lines: Vec<Line> = Vec::new();
    let mut in_code_block = false;
    let mut code_block_lines: Vec<String> = Vec::new();

    for raw_line in text.split('\n') {
        let trimmed = raw_line.trim();

        // Code block fences
        if trimmed.starts_with("```") {
            if in_code_block {
                // End code block — flush accumulated lines
                for cl in &code_block_lines {
                    let display = if cl.len() > max_width {
                        &cl[..max_width]
                    } else {
                        cl.as_str()
                    };
                    lines.push(Line::from(Span::styled(
                        display.to_string(),
                        Style::default().fg(Color::Rgb(180, 180, 200)).bg(Color::Rgb(30, 30, 40)),
                    )));
                }
                code_block_lines.clear();
                in_code_block = false;
            } else {
                // Start code block — show language tag if present
                let lang = trimmed.trim_start_matches('`').trim();
                if !lang.is_empty() {
                    lines.push(Line::from(Span::styled(
                        format!("  {}", lang),
                        Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                    )));
                }
                in_code_block = true;
            }
            continue;
        }

        if in_code_block {
            code_block_lines.push(format!("  {}", raw_line));
            continue;
        }

        // Horizontal rule
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            let rule = "─".repeat(max_width.min(60));
            lines.push(Line::from(Span::styled(
                rule,
                Style::default().fg(Color::DarkGray),
            )));
            continue;
        }

        // Headers
        if trimmed.starts_with("### ") {
            let header_text = trimmed.trim_start_matches("### ");
            lines.push(Line::from(Span::styled(
                format!("   {}", header_text),
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if trimmed.starts_with("## ") {
            let header_text = trimmed.trim_start_matches("## ");
            lines.push(Line::from(Span::styled(
                format!("  {}", header_text),
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
            continue;
        }
        if trimmed.starts_with("# ") {
            let header_text = trimmed.trim_start_matches("# ");
            lines.push(Line::from(Span::styled(
                header_text.to_string(),
                Style::default().fg(Color::White).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
            continue;
        }

        // Empty line
        if trimmed.is_empty() {
            lines.push(Line::raw(""));
            continue;
        }

        // Bullet lists
        let (indent, rest) = if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            ("  • ".to_string(), &trimmed[2..])
        } else if trimmed.starts_with("  - ") || trimmed.starts_with("  * ") {
            ("    ◦ ".to_string(), &trimmed[4..])
        } else if let Some(rest) = strip_numbered_list(trimmed) {
            ("  ".to_string(), rest)
        } else {
            (String::new(), trimmed)
        };

        // Word-wrap the content with inline formatting
        let content_width = max_width.saturating_sub(indent.len());
        let wrapped = word_wrap(rest, content_width);

        for (wi, wline) in wrapped.iter().enumerate() {
            let prefix = if wi == 0 { indent.clone() } else { " ".repeat(indent.len()) };
            let mut spans: Vec<Span> = vec![Span::raw(prefix)];
            spans.extend(parse_inline_markdown(wline));
            lines.push(Line::from(spans));
        }
    }

    // Flush any unclosed code block
    if in_code_block {
        for cl in &code_block_lines {
            lines.push(Line::from(Span::styled(
                cl.clone(),
                Style::default().fg(Color::Rgb(180, 180, 200)).bg(Color::Rgb(30, 30, 40)),
            )));
        }
    }

    lines
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

/// Parse inline markdown: **bold**, *italic*, `code`, ***bold-italic***
fn parse_inline_markdown(text: &str) -> Vec<Span<'static>> {
    let mut spans: Vec<Span> = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        // Find the next markdown marker
        if let Some(pos) = remaining.find(|c: char| c == '*' || c == '`') {
            // Add text before the marker
            if pos > 0 {
                spans.push(Span::styled(
                    remaining[..pos].to_string(),
                    Style::default().fg(Color::Rgb(200, 200, 210)),
                ));
            }
            remaining = &remaining[pos..];

            // Inline code
            if remaining.starts_with('`') {
                if let Some(end) = remaining[1..].find('`') {
                    let code_text = &remaining[1..1 + end];
                    spans.push(Span::styled(
                        code_text.to_string(),
                        Style::default().fg(Color::Rgb(220, 180, 120)).bg(Color::Rgb(35, 35, 45)),
                    ));
                    remaining = &remaining[2 + end..];
                    continue;
                }
            }

            // Bold-italic (*** or ___)
            if remaining.starts_with("***") {
                if let Some(end) = remaining[3..].find("***") {
                    let inner = &remaining[3..3 + end];
                    spans.push(Span::styled(
                        inner.to_string(),
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD | Modifier::ITALIC),
                    ));
                    remaining = &remaining[6 + end..];
                    continue;
                }
            }

            // Bold
            if remaining.starts_with("**") {
                if let Some(end) = remaining[2..].find("**") {
                    let inner = &remaining[2..2 + end];
                    spans.push(Span::styled(
                        inner.to_string(),
                        Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
                    ));
                    remaining = &remaining[4 + end..];
                    continue;
                }
            }

            // Italic
            if remaining.starts_with('*') {
                if let Some(end) = remaining[1..].find('*') {
                    let inner = &remaining[1..1 + end];
                    spans.push(Span::styled(
                        inner.to_string(),
                        Style::default().fg(Color::Rgb(200, 200, 210)).add_modifier(Modifier::ITALIC),
                    ));
                    remaining = &remaining[2 + end..];
                    continue;
                }
            }

            // No matching end marker — treat as literal
            spans.push(Span::styled(
                remaining[..1].to_string(),
                Style::default().fg(Color::Rgb(200, 200, 210)),
            ));
            remaining = &remaining[1..];
        } else {
            // No more markers — rest is plain text
            spans.push(Span::styled(
                remaining.to_string(),
                Style::default().fg(Color::Rgb(200, 200, 210)),
            ));
            break;
        }
    }

    spans
}

/// Simple word-wrap that breaks on word boundaries
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
            if current_line.is_empty() {
                if word.len() > max_width {
                    let mut remaining = word;
                    while remaining.len() > max_width {
                        lines.push(remaining[..max_width].to_string());
                        remaining = &remaining[max_width..];
                    }
                    current_line = remaining.to_string();
                } else {
                    current_line = word.to_string();
                }
            } else if current_line.len() + 1 + word.len() > max_width {
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
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max.saturating_sub(3)])
    }
}
