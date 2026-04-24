# VHS tape: end-to-end scripted demo (no real API calls)
# Runs the deterministic ScriptedInvoker via `rly run <request>`.
# With HARNESS_LIVE unset this stays in scripted-simulation mode.
# Render with: vhs demo/scripted.tape
# Output: demo/scripted.gif
#
# This is the best candidate for the README hero asset: reproducible, fast,
# and shows the full classify -> plan -> decompose -> dispatch -> verify flow.

Output demo/scripted.gif

Set FontSize 12
Set Width 1280
Set Height 1100
Set Theme "Catppuccin Mocha"
Set Padding 18
Set TypingSpeed 30ms
Set PlaybackSpeed 1.0

Type `rly run "add a dark-mode toggle"`
Sleep 400ms
Enter

# Run streams classify -> plan -> tickets -> dispatch -> verify -> complete.
# Scripted mode finishes in ~13s; pad for flush + a moment to admire.
Sleep 20s
