# Handoff — Relay "Tidewater" GUI

> **Read me first:** this bundle is the design spec for Relay's Slack-style desktop GUI. It's the output of a design exploration; the HTML files are **references, not code to ship**. Your job is to recreate the designs in Relay's Tauri app using its existing patterns.

---

## 1. What Relay is (context)

Relay is a CLI + daemon that runs **coding agents on your repositories**. Each repo becomes a workspace registered with `rly up`; agents spawn inside that workspace, operate on the code, open PRs, and report back. The Tauri GUI in this handoff is the surface humans use to talk to those agents — a Slack-inspired chat app where **channels are scoped to one or more repos** and **the people you message in a channel are both humans and repo-attached agents**.

If you're unfamiliar with Relay, the important thing to internalize is this: **a channel is not just a conversation, it's a repo-scoped execution context.** When you ping `@relay` in `#oauth-api-users`, you are addressing an agent running in the `relay` repo's workspace. That agent can plan tickets, write code, open PRs, and post back — and other attached repos' agents (say `@flowtide`) can be pinged from the same channel to coordinate cross-repo changes.

## 2. What to build — the Tidewater GUI

Recreate **Direction C (Tidewater)** in a new or existing Tauri shell. Tidewater is the final visual/interaction design. The other design files (`direction-a-*.jsx`, the design canvas, the design-only `new-channel` and `settings` artboards) are reference and dependency only — you do not need to ship the design canvas or any of the A/B alternates.

**Stack assumption:** Tauri + a React frontend (the design files are all JSX). If the Tauri project uses a different frontend framework (Svelte, Solid, vanilla web components), port the designs faithfully using that framework's conventions — the design files are the visual source of truth, not the implementation.

**Fidelity: high.** Pixel-accurate colors, typography, spacing, interaction states, and microcopy are intentional. `tokens.json` is the extracted palette + scale; use it to generate CSS vars or a theme object.

---

## 3. The design files

Everything in `design/` can be opened locally — copy the folder somewhere, add the HTML loader below, and you have a working prototype.

```
design/
├── relay-data.jsx          # Mock data: AGENTS, CHANNELS, DMS, ACTIVITY,
│                           #   REPOS (deprecated global list), AVAILABLE_WORKSPACES
├── design-canvas.jsx       # Canvas wrapper for multi-artboard layout (reference only)
├── direction-a-base.jsx    # Tide palette (A object), icon set (I), Avatar, agent color hash,
│                           #   WorkspaceRail — imported by Tidewater
├── direction-a-sidebar.jsx # Left sidebar (Activity / Starred / Channels / DMs) — reused by C
├── direction-a-header.jsx  # A's header (C does NOT use this — C has its own ChannelHeader)
├── direction-a-chat.jsx    # A's MessageList + Composer — C overrides both with its own
├── direction-a-right.jsx   # A's right-pane bodies (PrThread, DecisionDrawer) — reused by C
├── direction-a-app.jsx     # A's top-level App — reference only
├── direction-c-repos.jsx   # ★ C-specific: RepoChipRow, ChannelSettingsDrawer,
│                           #   NewChannelModal, MentionPopover, renderWithMentions
└── direction-c-tidewater.jsx # ★ C's main component: DirectionC, ChannelHeader, BoardView,
                              #   DecisionsView, MessageListC, ComposerC, RightRail, DmView
```

### Loading the reference locally

To view the designs as a working React app, create an `index.html` next to `design/`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin></script>
    <script
      src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"
      crossorigin
    ></script>
    <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin></script>
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <style>
      html,
      body,
      #r {
        margin: 0;
        height: 100%;
        background: #0e1420;
        font-family: Inter, sans-serif;
      }
      * {
        box-sizing: border-box;
      }
    </style>
  </head>
  <body>
    <div id="r" style="width:1480px;height:920px"></div>
    <script type="text/babel" src="design/relay-data.jsx"></script>
    <script type="text/babel" src="design/direction-a-base.jsx"></script>
    <script type="text/babel" src="design/direction-a-sidebar.jsx"></script>
    <script type="text/babel" src="design/direction-a-header.jsx"></script>
    <script type="text/babel" src="design/direction-a-chat.jsx"></script>
    <script type="text/babel" src="design/direction-a-right.jsx"></script>
    <script type="text/babel" src="design/direction-a-app.jsx"></script>
    <script type="text/babel" src="design/direction-c-repos.jsx"></script>
    <script type="text/babel" src="design/direction-c-tidewater.jsx"></script>
    <script type="text/babel">
      ReactDOM.createRoot(document.getElementById("r")).render(
        <DirectionC tweaks={{ avatarStyle: "glyph", density: "medium" }} />
      );
    </script>
  </body>
</html>
```

---

## 4. What's new (critical — read this before implementing)

Tidewater introduces several concepts that don't exist in the current Relay CLI and will need backend support. **This is the part most likely to cause confusion — read all of it.**

### 4.1 Repos are channel-scoped, not global

The earlier iteration had a global "Repos" section in the sidebar. That's gone.

- Workspaces registered via `rly up` live in a **global pool** — see `AVAILABLE_WORKSPACES` in `relay-data.jsx`.
- A workspace only becomes a pingable `@alias` agent **after it's attached to a channel**.
- Each channel has an array `repos: string[]` (aliases) and a single `primaryRepo: string`.
- The **primary repo** hosts the channel's main agent — the one that receives the channel's first message and does classification / ticket planning.

> **Backend contract:** the daemon needs an API to (a) list registered workspaces, (b) attach/detach a workspace to a channel, (c) promote a non-primary attached repo to primary. A repo may be attached to many channels simultaneously. Each (channel, repo) pair spawns its own agent instance with its own working directory state — attaching `@relay` to two channels gives you two independent agents.

### 4.2 `@alias` mentions as a first-class pingable

In Tidewater, typing `@` in the composer opens a Slack-style popover (see `MentionPopover` in `direction-c-repos.jsx`) listing **the channel's attached repos + channel members**. Picking one inserts `@alias` as a styled chip.

- Primary repo mentions render in **coral** (the accent color)
- Non-primary attached repos render in **slate-blue**
- Human mentions (`@jcast`, `@channel`) render in **mint green**
- The `renderWithMentions(text, channel)` helper is the single tokenizer — it handles `@alias`, `**bold**`, and `` `code` ``. Messages from your chat store should flow through it.

> **Backend contract:** messages in channels carry a `mentions: Array<{kind: 'repo'|'human', alias: string}>`. When the daemon receives a message, the primary agent is always addressed by default; non-primary repo mentions trigger a cross-agent ping (the other repo's agent gets the message + a crosslink reference). Crosslinks from other channels/DMs arrive as a `crosslink` message kind.

### 4.3 Channel header is **interactive for repo management**

Open `direction-c-tidewater.jsx` → `ChannelHeader` and `direction-c-repos.jsx` → `RepoChipRow`. The header has:

- **Row 1:** `#` + channel name + tier badge + star + topic (truncates) | agent stack | right-rail toggle
- **Row 2 (tabs):** `Chat | Board | Decisions` tabs | **RepoChipRow** (right-aligned)

The RepoChipRow is where inline repo management lives:

- Each chip is clickable — opens a popover with "Set as primary", "Detach", etc.
- Hovering a non-primary chip reveals an `×` shortcut to detach.
- The primary chip cannot be directly detached; the user must promote another repo first.
- A trailing `+` chip opens `AddRepoPopover`, which lists un-attached workspaces from `AVAILABLE_WORKSPACES`.
- The gear icon next to the chips opens `ChannelSettingsDrawer` (see below).

### 4.4 Channel settings drawer

Gear icon → right-side slide-over (`ChannelSettingsDrawer` in `direction-c-repos.jsx`). Tabs: **Repos | Members | About**. The Repos tab is the full-fidelity version of the header chip controls — useful for managing many repos at once. Members and About are scaffolded but deliberately thin (members are inferred from who's posted; About shows topic + tier).

### 4.5 New-channel modal (3-step)

`NewChannelModal` in `direction-c-repos.jsx`. Three steps:

1. **Basics** — channel name + optional topic. Name is auto-slugged.
2. **Repos** — multi-select from `AVAILABLE_WORKSPACES`. Radio for primary. Shows last-active + open-PR count per workspace. First-selected repo becomes primary by default.
3. **Kick off** — free-text first message. This goes straight to the primary agent; classifier decides tier + ticket plan.

Entry points:

- `+` button next to "CHANNELS" in the sidebar
- A DM can be **promoted** to a channel (`DmView.onPromote` → opens the same modal, prefilled with the DM's agent's repo as primary). This is the "DM as kickoff surface" pattern — users often start informally in a DM, then promote once the work is real.

> **Backend contract:** channel creation is a single atomic operation that (a) creates the channel record, (b) attaches each selected workspace, (c) sets primary, (d) posts the first message and triggers classification. If classification resolves to a `feature_large` or similar, the planner then fans out tickets across attached repos — this already exists in the CLI path, just needs a GUI-facing API.

### 4.6 DMs

DMs are direct-to-agent (not direct-to-human). A yellow banner at the top of a DM explains they're "kickoff surfaces" — you talk 1:1 with an agent; if the conversation becomes real work, promote it to a channel. The composer placeholder hints at `/new` as the slash-command path to promote.

### 4.7 Messaging — markdown + mentions

`renderWithMentions(text, channel)` is the single render path for message body text in channels, DMs, and decisions. It recognises:

- `**bold**` → `<strong>`
- `` `code` `` → inline code chip with paper-alt background
- `@alias` → repo-or-human chip

No other markdown. No links are auto-linkified in bodies (they appear raw) — if you need that, add it to `renderWithMentions` in one place.

---

## 5. Screens and layout

Sizes below are the absolute values in the designs. They're designed against a **1480×920** frame; if the Tauri window can resize, treat the sidebar / rails as fixed-width and let the center pane flex.

### 5.1 Global shell

```
[ 58 Workspace rail ] [ 230 Sidebar ] [ flex Center pane ] [ 360 Right rail (collapsible) ]
```

Min pane height fills viewport. `overflow: auto` only inside the three scroll regions: sidebar channel list, message list, right-rail panes.

### 5.2 Sidebar (left) — `direction-a-sidebar.jsx`

- Workspace header (big R avatar + "Relay" + user subtitle)
- Activity row, Threads row, Running row (badges on the right)
- **Starred** section (collapsible)
- **Channels** section with `+` → new-channel modal
- **Direct messages** section
- **No Repos section** — pass `repos={[]}` to `Sidebar` to hide it

### 5.3 Channel center pane — `direction-c-tidewater.jsx`

- `ChannelHeader` (see §4.3)
- Pane selector tabs inside the header (Chat | Board | Decisions)
- `MessageListC` + `ComposerC` when pane is `chat`
- `BoardView` (dense list: ID, Status pill, Title, Agent, PR link) when `board`
- `DecisionsView` when `decisions`
- `ChannelSettingsDrawer` mounted as an overlay when `settingsOpen`

### 5.4 Right rail — `RightRail`

Tabs: **Threads | Decisions | PRs**. Each tab shows a list; clicking an item opens a detail view reusing A's `PrThread` / `DecisionDrawer` bodies. Auto-switches to "PRs" when the channel has a failing CI.

### 5.5 Composer — `ComposerC`

- Leading `→ @primaryRepo` chip (fixed; indicates where the message routes by default)
- `Auto-approve` toggle
- Hint text (truncates first at narrow widths)
- `⌘⏎` affordance + Send button
- **Mention autocomplete**: type `@` anywhere; popover mounts above the composer, ↑↓ to navigate, Enter/Tab to accept

### 5.6 Modals and drawers

- **NewChannelModal** — centered, 640px wide, 3 steps
- **ChannelSettingsDrawer** — right-side, 460px wide, dimmed backdrop
- **AddRepoPopover**, **MentionPopover**, **RepoChipRow popovers** — anchored floating popovers, dismiss on outside click or Escape

---

## 6. Data shapes (UI-facing contracts)

These are the only contracts the UI cares about. The daemon can have richer internal representations; these are the projections it needs to serve to the GUI.

```ts
type Workspace = {
  workspaceId: string; // stable id
  path: string; // human-readable, e.g. "~/code/relay"
  defaultAlias: string; // basename(path) unless user overrode
  lastActive: string; // humanized, e.g. "2m", "3d"
  openPrs: number;
};

type Channel = {
  id: string;
  name: string; // e.g. "oauth-api-users" (no leading #)
  topic: string;
  tier: "feature_large" | "feature" | "bugfix" | "chore" | "question";
  starred: boolean;
  repos: string[]; // aliases — each an attached workspace
  primaryRepo: string; // must be in repos[]
  agents: string[]; // agent ids sourced from AGENTS
  messages: Message[];
  tickets: Ticket[];
  decisions: Decision[];
  prs: Pr[];
  activeAt: string; // humanized
};

type Message = {
  id: string;
  kind: "user" | "assistant" | "system" | "tool" | "crosslink";
  author: string; // user id or agent id
  text: string; // rendered via renderWithMentions()
  time: string; // humanized or HH:MM
  // Optional: mentions: Array<{ kind: 'repo'|'human', alias: string }>
  //   — the UI can re-derive these from text + channel, but having them
  //     server-side simplifies notification routing.
};

type Ticket = {
  id: string; // e.g. "T-1"
  title: string;
  status:
    | "pending"
    | "ready"
    | "executing"
    | "verifying"
    | "completed"
    | "failed"
    | "blocked"
    | "retry";
  agent: string; // agent id
  pr?: number;
  specialty?: string; // for the Board group-by-specialty view
};

type Pr = {
  number: number;
  title: string;
  branch: string;
  repo: string; // alias
  agent: string; // agent id
  ci: "passing" | "failing" | "pending";
  review: "approved" | "pending" | "changes_requested";
};

type Decision = {
  id: string;
  title: string;
  summary: string;
  madeBy: string; // agent or 'you'
  time: string;
};

type Dm = {
  id: string;
  agentId: string;
  messages: Message[];
};

type Agent = {
  id: string;
  name: string; // e.g. "Saturn"
  glyph: string; // short, e.g. "♄"
  provider: string; // e.g. "claude"
  status: "idle" | "working";
  repoAlias?: string; // which repo alias this agent is attached to
  specialty?: string;
};
```

### 6.1 Backend-facing actions the UI dispatches

| UI action                           | Backend call (suggested)                                        |
| ----------------------------------- | --------------------------------------------------------------- |
| Sidebar `+` → create channel        | `POST /channels { name, topic, repos, primary, firstMessage }`  |
| Attach repo from header `+` popover | `POST /channels/:id/repos { alias }`                            |
| Detach repo from chip popover       | `DELETE /channels/:id/repos/:alias`                             |
| Promote to primary                  | `PATCH /channels/:id { primaryRepo: alias }`                    |
| DM → promote to channel             | same as create, with DM messages as context                     |
| Send message (composer)             | `POST /channels/:id/messages { text, targetRepo, autoApprove }` |
| Toggle auto-approve                 | channel-scoped setting; persists to `PATCH /channels/:id`       |

None of these are implemented — see §8.

---

## 7. Design tokens

See `tokens.json` for the complete palette + scale. Key bindings:

### Colors

| Token              | Hex       | Use                                                                  |
| ------------------ | --------- | -------------------------------------------------------------------- |
| `ink.deepest`      | `#0e1420` | Workspace rail, app frame                                            |
| `ink.deep`         | `#141b2a` | Sidebar background                                                   |
| `ink.panel`        | `#1a2232` | Raised panels on the rail                                            |
| `paper.base`       | `#fbf9f4` | Center pane, drawers, modals                                         |
| `paper.alt`        | `#f3f0e7` | Inputs, chip bg, muted zones                                         |
| `paper.line`       | `#e5e1d5` | Borders on paper                                                     |
| `text.primary`     | `#1b1f2a` | Body text on paper                                                   |
| `text.muted`       | `#5b6579` | Secondary text                                                       |
| `text.dim`         | `#8a93a5` | Tertiary / placeholder                                               |
| **`accent.coral`** | `#e65a4f` | **Primary accent** — active tab, primary repo, CTA, selected channel |
| `accent.coralSoft` | `#fbe1dd` | Coral backgrounds, selected-row bg                                   |
| `accent.amber`     | `#e89a2b` | Executing status, working indicator pulse                            |
| `accent.mint`      | `#3fb984` | Idle/online presence, success                                        |
| `accent.sky`       | `#4a7fd0` | Info / links                                                         |
| `accent.magenta`   | `#c44d8a` | Agent color hash entry                                               |

### Type

- **UI:** Inter — 400/500/600/700
- **Mono:** JetBrains Mono for code, aliases, paths
- Sizes: sidebar items 13px, message body 14.5px, header 16px, section headers 10.5px uppercase

### Spacing + radius

- 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32 px base scale
- Radius: chips 3px, pills 14px, cards 6px, popovers 6–8px, modals 12px

### Shadows

- Popover: `0 6px 18px rgba(0,0,0,0.08)`
- Modal: `0 24px 80px rgba(0,0,0,0.2)`
- Drawer: `-16px 0 48px rgba(0,0,0,0.15)`

---

## 8. Not yet built (open TODOs)

These were scoped but not implemented in the design. The patterns are sketched in the files — finish them in the Tauri app.

1. **`/new` slash command inside DMs** — typing `/new` at the start of a DM composer should surface an inline action to promote the DM to a channel. Currently the user has to click "Promote" or trigger from the DM header. The wire is stubbed (`DmView.onPromote` already opens `NewChannelModal`); just add the slash-command parser to `ComposerC`.
2. **Crosslink DM→channel promote pre-fill** — when promoting, carry over the DM's agent's repo alias as the primary and inject the DM messages into the new channel's history as a crosslink thread. Modal supports an `initial` prop scaffolded for this.
3. **Visual tweaks panel** — the `tweaks` prop on `DirectionC` accepts `{ avatarStyle, density }` but there's no UI to flip them. Add a Tweaks drawer if desired (standard dev-tool pattern) — the design skill has a helper for this but it's not wired in.
4. **Attach-on-command** — when a user types `@foo` and `foo` is a registered workspace but **not attached** to the channel, offer a "Attach @foo to this channel?" inline action instead of falling through to plain text. `MentionPopover` currently only lists already-attached repos; extending the data model is trivial.
5. **Mention notifications for absent repos** — if `@saturn` is pinged in `#release-3-0` but `saturn` isn't attached, the UI currently renders it as a plain text chip. Product decision needed.
6. **Decisions view polish** — the tab exists and renders `DecisionDrawer` bodies but hasn't been stress-tested with long lists.
7. **Board view filters** — sort / group is implemented; adding a search box + status multi-select would help at scale.

---

## 9. Notes for the developer

- **Framework:** if the Tauri shell is already React + TypeScript, split the files roughly the same way — `base` (tokens + primitives), `sidebar`, `header`, `chat`, `right-rail`, `repos` (modal + settings + mentions + chip row), `app`. The design uses inline `style={}` objects — convert to CSS modules or your styling library of choice; the colors and measurements are the important part.
- **Do not copy the IIFE + `window.RELAY_*` pattern.** That's a browser-only thing for loading JSX files without a bundler. Use normal ES imports.
- **Tauri IPC:** all the backend contracts in §6.1 map cleanly to Tauri `invoke()` commands. Keep them typed.
- **Persistence:** channel list, selection, and right-rail open state should survive window restart. The designs have no persistence; add it via Tauri's state manager or a light wrapper around `localStorage`.
- **Accessibility:** the designs are keyboard-friendly for the popovers (arrow keys, Enter, Escape) but not all chips are reachable with Tab. Treat the tab order as a thing to fix during implementation.
- **Fonts:** the designs load Inter + JetBrains Mono from Google Fonts. In Tauri, bundle the fonts locally — offline is a requirement.
- **Window size:** design frame is 1480×920 but the shell should be resizable. Fixed widths: workspace rail 58px, sidebar 230px, right rail 360px. Everything else flexes.

---

## 10. Quick orientation checklist

Open `design/direction-c-tidewater.jsx` and search for:

- `function DirectionC(` — top-level component (§5)
- `function ChannelHeader(` — header layout (§4.3, §5.3)
- `function BoardView(` — list-view alternative to chat pane
- `function MessageListC(` / `function MessageC(` — message rendering
- `function ComposerC(` — composer with mention autocomplete (§5.5)
- `function RightRail(` — tabbed right pane (§5.4)
- `function DmView(` — DM surface (§4.6)

Then open `design/direction-c-repos.jsx`:

- `RepoChipRow` — header chip row (§4.3)
- `AddRepoPopover` — `+` chip popover
- `ChannelSettingsDrawer` — gear icon drawer (§4.4)
- `NewChannelModal` — 3-step modal (§4.5)
- `MentionPopover` — composer `@` autocomplete (§4.2)
- `renderWithMentions` — the single text→React renderer for all message bodies (§4.7)

That's it. Everything else is composition of these primitives.
