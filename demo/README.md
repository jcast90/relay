# Demo assets

Reproducible recordings + a shot list for the top-level `README.md`.

## Automated (checked in, rebuilt on demand)

### CLI / TUI — [VHS](https://github.com/charmbracelet/vhs)

```bash
brew install vhs          # macOS
# or: go install github.com/charmbracelet/vhs@latest

vhs demo/welcome.tape     # -> demo/welcome.gif
vhs demo/scripted.tape    # -> demo/scripted.gif   (best candidate for hero asset)
vhs demo/tui.tape         # -> demo/tui.gif
```

The `scripted.tape` recording is the one to lean on: it runs `pnpm demo`,
which uses the deterministic scripted invoker, so every render looks
identical. No real API calls, no flaky timing.

Edit the `.tape` files to retime sequences or change keystrokes. VHS
re-renders from scratch every time.

### GUI web view — Playwright

```bash
# Terminal 1
cd gui && pnpm dev        # vite on http://127.0.0.1:1420

# Terminal 2
pnpm --filter relay-gui exec playwright install chromium  # one-time
node demo/screenshot-gui.mjs                               # -> demo/screenshots/
```

This drives the vite dev server (not the native Tauri window), so you
get clean reproducible stills of each screen. Selectors live inline in
`demo/screenshot-gui.mjs`; extend the `shots` array to capture more views.

## Manual — things only a human can do well

These are worth capturing by hand because scripted cursor movement always
looks off, and the native Tauri window chrome doesn't exist in the web view.

1. **Hero GIF / video for README top (30–45s, <10MB for inlining).**
   One continuous run: type a request → plan appears → tickets decomposed
   → agent dispatched → PR link shows up. macOS: `Cmd+Shift+5` → record
   selected portion → export to MP4 → convert with `ffmpeg -i in.mov -vf "fps=12,scale=1200:-1:flags=lanczos" -loop 0 out.gif`.
2. **GUI main window with native chrome.** `screencapture -w ~/Desktop/relay-main.png` (macOS prompts you to click the window).
3. **Plan-approval gate** — the moment a human accepts/rejects a decomposed plan.
4. **Multi-repo crosslink** — two sessions in different repos messaging each other. Split your screen, record both.
5. **Decision log / channel view** showing durable history.

## Shot list for README (priority order)

| # | Asset | Source |
|---|-------|--------|
| 1 | Hero GIF (top of README) | **manual** — real run, macOS screen capture |
| 2 | GUI main window | **manual** — `screencapture -w` for native chrome, or `demo/screenshots/01-main-window.png` for web view |
| 3 | Plan-approval gate | **manual** |
| 4 | TUI dashboard | `vhs demo/tui.tape` |
| 5 | Decision log / channel view | **manual** |
| 6 | Multi-repo crosslink | **manual** |
| 7 | `rly welcome` onboarding | `vhs demo/welcome.tape` |
| 8 | Scripted end-to-end flow | `vhs demo/scripted.tape` — also a hero-asset candidate if you don't want to record a live run |

Host anything over ~10MB on YouTube/Loom and link with a thumbnail;
GitHub won't inline larger files reliably.
