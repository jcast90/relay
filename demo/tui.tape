# VHS tape: Rust TUI dashboard
# Requires the TUI to be built (`./install.sh --with-tui` or `cargo build --bin rly-tui`).
# Render with: vhs demo/tui.tape
# Output: demo/tui.gif

Output demo/tui.gif

Set FontSize 13
Set Width 1400
Set Height 820
Set Theme "Catppuccin Mocha"
Set Padding 16
Set TypingSpeed 40ms

Type "rly tui"
Sleep 400ms
Enter
Sleep 2s

# `rly tui` asks once about auto-approving Claude permission prompts. Decline.
Type "n"
Enter
Sleep 2s

# Cycle through the bottom-tab views (1: Chat, 2: Board, 3: Decisions, 4: PRs, 5: Approvals).
Type "2"
Sleep 2s
Type "3"
Sleep 2s
Type "5"
Sleep 3s

# Leave the final frame showing the TUI — don't type `q` here so README renders
# land on the dashboard, not on a shell prompt.
