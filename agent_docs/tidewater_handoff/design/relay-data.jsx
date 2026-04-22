// Shared mock data for both Relay Slack-style directions.
// Exposes RELAY_DATA on window.

const AGENTS = [
  { id: 'saturn',   name: 'Saturn',   glyph: '◆', provider: 'claude', activity: 'editing src/orchestrator/planner.ts', status: 'working' },
  { id: 'titan',    name: 'Titan',    glyph: '▲', provider: 'claude', activity: 'running pnpm test', status: 'working' },
  { id: 'rhea',     name: 'Rhea',     glyph: '●', provider: 'codex',  activity: null, status: 'idle' },
  { id: 'oberon',   name: 'Oberon',   glyph: '■', provider: 'claude', activity: 'reading AGENTS.md', status: 'working' },
  { id: 'miranda',  name: 'Miranda',  glyph: '◈', provider: 'claude', activity: null, status: 'idle' },
  { id: 'phoebe',   name: 'Phoebe',   glyph: '▼', provider: 'codex',  activity: 'opening PR #482', status: 'working' },
  { id: 'janus',    name: 'Janus',    glyph: '◆', provider: 'claude', activity: null, status: 'offline' },
  { id: 'europa',   name: 'Europa',   glyph: '◉', provider: 'claude', activity: 'grepping handlers', status: 'working' },
  { id: 'callisto', name: 'Callisto', glyph: '◇', provider: 'codex',  activity: null, status: 'idle' },
];

// Global pool of repos registered via `rly up`. These are NOT channel-scoped
// on their own — they become pingable agents only when attached to a channel.
// (A's sidebar still renders them in a "Repos" section as a before-state.)
const REPOS = [
  { alias: 'relay',      path: '~/code/relay',         primary: true  },
  { alias: 'flowtide',   path: '~/code/flowtide',      primary: false },
  { alias: 'venture-os', path: '~/code/venture-os',    primary: false },
  { alias: 'bdrift',     path: '~/code/bdrift',        primary: false },
];

// Workspaces the user has registered (via `rly up`). Superset — more than
// what's currently attached to any channel. Used by the new-channel modal
// and the repo-add popover. Each entry carries a friendly path + a default
// alias suggestion (it's just `basename(path)` unless user overrides).
const AVAILABLE_WORKSPACES = [
  { workspaceId: 'ws-relay',     path: '~/code/relay',      defaultAlias: 'relay',      lastActive: '2m',  openPrs: 3 },
  { workspaceId: 'ws-flowtide',  path: '~/code/flowtide',   defaultAlias: 'flowtide',   lastActive: '14m', openPrs: 1 },
  { workspaceId: 'ws-venture',   path: '~/code/venture-os', defaultAlias: 'venture-os', lastActive: '2h',  openPrs: 0 },
  { workspaceId: 'ws-bdrift',    path: '~/code/bdrift',     defaultAlias: 'bdrift',     lastActive: '3d',  openPrs: 0 },
  { workspaceId: 'ws-harmonia',  path: '~/code/harmonia',   defaultAlias: 'harmonia',   lastActive: '1w',  openPrs: 0 },
  { workspaceId: 'ws-gridlab',   path: '~/code/gridlab',    defaultAlias: 'gridlab',    lastActive: '3w',  openPrs: 0 },
];

const CHANNELS = [
  {
    id: 'oauth-api-users',
    name: 'oauth-api-users',
    topic: 'Add OAuth2 flow to /api/users',
    starred: true,
    unread: 3,
    mentions: 1,
    agents: ['saturn', 'titan', 'oberon'],
    repos: ['relay', 'flowtide'],
    primaryRepo: 'relay',
    tier: 'feature_large',
    activeAt: '2m',
    tickets: [
      { id: 'T-1', title: 'Scaffold /auth/oauth endpoint', specialty: 'api_crud', status: 'completed', deps: [], agent: 'saturn' },
      { id: 'T-2', title: 'Add provider adapters (github, google)', specialty: 'business_logic', status: 'executing', deps: ['T-1'], agent: 'titan' },
      { id: 'T-3', title: 'Migration: users.auth_provider column', specialty: 'devops', status: 'verifying', deps: ['T-1'], agent: 'oberon' },
      { id: 'T-4', title: 'Token refresh middleware', specialty: 'business_logic', status: 'ready', deps: ['T-2'], agent: null },
      { id: 'T-5', title: 'Integration tests for /auth/oauth/*', specialty: 'testing', status: 'blocked', deps: ['T-2', 'T-3'], agent: null },
      { id: 'T-6', title: 'Update AGENTS.md with auth patterns', specialty: 'general', status: 'pending', deps: [], agent: null },
    ],
    decisions: [
      {
        id: 'D-1',
        title: 'Store refresh tokens server-side, not in JWTs',
        description: 'Refresh tokens are kept in the `oauth_tokens` table and rotated on each use. JWT access tokens are 15m-lived, stateless, and do not contain refresh material.',
        rationale: 'Revocation becomes possible without a distributed blocklist, and a leaked JWT is only dangerous for 15 minutes. Aligns with the existing session model.',
        alternatives: ['Encode refresh in JWT (rejected — no revocation)', 'Session cookies only (rejected — mobile clients)'],
        by: 'Saturn',
        at: '1h ago',
      },
      {
        id: 'D-2',
        title: 'Use `openid-client` over hand-rolled OAuth',
        description: 'Adopt `openid-client@5` for all provider integrations rather than writing per-provider HTTP glue.',
        rationale: 'Certified OIDC library; discovery + PKCE + ID token verification handled correctly. ~1.2kloc we do not have to maintain.',
        alternatives: ['Hand-roll per provider', 'Use Passport.js (rejected — maintenance concerns)'],
        by: 'Titan',
        at: '47m ago',
      },
    ],
    prs: [
      { number: 482, title: 'feat(auth): scaffold OAuth2 endpoint', branch: 'saturn/oauth-scaffold', ci: 'passing', review: 'approved', state: 'open', url: '#', author: 'Saturn' },
      { number: 483, title: 'feat(auth): github + google adapters', branch: 'titan/oauth-adapters', ci: 'failing', review: 'pending', state: 'open', url: '#', author: 'Titan' },
    ],
    messages: [
      { id: 1, author: 'you',    kind: 'user',      time: '10:12', text: 'Add OAuth2 to /api/users — github and google to start, linear/figma later. Here\'s the issue: https://github.com/jcast90/relay/issues/142' },
      { id: 2, author: 'system', kind: 'system',    time: '10:12', text: 'Classified as **feature_large** · tracker issue resolved · 6 tickets planned across 2 repos' },
      { id: 3, author: 'saturn', kind: 'assistant', time: '10:13', text: 'Looked through `src/auth/`. Current session handling is cookie-based; I\'ll keep that surface and add OAuth as a parallel entry. Planning to put refresh tokens in a new `oauth_tokens` table — want to keep JWTs short-lived and revocable.', activity: null },
      { id: 4, author: 'you',    kind: 'user',      time: '10:14', text: 'Sounds right. Go ahead.' },
      { id: 5, author: 'saturn', kind: 'assistant', time: '10:14', text: '**T-1 complete** — `POST /auth/oauth/:provider` scaffolded with PKCE-ready redirect handler. Tests pass. PR #482 opened.', activity: null },
      { id: 6, author: 'titan',  kind: 'assistant', time: '10:22', text: '@saturn — when you wire token refresh, can you use the same `oauth_tokens` row and not a sibling table? Saves a join on every middleware pass.', activity: null },
      { id: 7, author: 'saturn', kind: 'assistant', time: '10:23', text: '@titan yep, will do. Adding `refresh_token_hash` to the same migration.', activity: null },
      { id: 8, author: 'titan',  kind: 'assistant', time: '10:31', text: null, activity: 'editing src/auth/providers/github.ts · running tsc --noEmit · opening PR #483' },
    ],
  },
  {
    id: 'metrics-dashboard',
    name: 'metrics-dashboard',
    topic: 'Surface p95/p99 in the TUI',
    starred: true,
    unread: 0,
    mentions: 0,
    agents: ['europa', 'miranda'],
    repos: ['relay'],
    primaryRepo: 'relay',
    tier: 'feature_small',
    activeAt: '14m',
    tickets: [
      { id: 'M-1', title: 'Add histogram recorder to scheduler', specialty: 'business_logic', status: 'executing', deps: [], agent: 'europa' },
      { id: 'M-2', title: 'TUI: percentile sparkline widget', specialty: 'ui', status: 'ready', deps: ['M-1'], agent: null },
      { id: 'M-3', title: 'Expose metrics via `rly status --json`', specialty: 'api_crud', status: 'pending', deps: ['M-1'], agent: null },
    ],
    decisions: [],
    prs: [],
    messages: [
      { id: 1, author: 'you',    kind: 'user',      time: '9:40',  text: 'Add p95/p99 latency to `rly status` and a sparkline in the TUI.' },
      { id: 2, author: 'europa', kind: 'assistant', time: '9:41',  text: 'On it. Starting with the histogram recorder — planning to use HDR histogram in the scheduler loop so we don\'t allocate on every sample.', activity: null },
    ],
  },
  {
    id: 'pod-executor',
    name: 'pod-executor',
    topic: 'Wire Kubernetes pod executor end-to-end',
    starred: false,
    unread: 0,
    mentions: 0,
    agents: ['oberon', 'phoebe'],
    repos: ['relay', 'venture-os'],
    primaryRepo: 'relay',
    tier: 'architectural',
    activeAt: '2h',
    tickets: [
      { id: 'P-1', title: 'Design doc: pod lifecycle + failure modes', specialty: 'general', status: 'completed', deps: [], agent: 'oberon' },
      { id: 'P-2', title: 'PodExecutor implements Executor', specialty: 'business_logic', status: 'failed', deps: ['P-1'], agent: 'phoebe' },
      { id: 'P-3', title: 'Sidecar for artifact upload to S3', specialty: 'devops', status: 'blocked', deps: ['P-2'], agent: null },
    ],
    decisions: [
      {
        id: 'D-3',
        title: 'One pod per ticket, not per run',
        description: 'Each ticket gets its own pod. Pods are ephemeral — artifacts stream to S3, logs to the host.',
        rationale: 'Ticket-level isolation makes retry + parallelism trivial, and pod startup is <2s with a warm node pool.',
        alternatives: ['One pod per run (rejected — serializes tickets)', 'Shared pod with workspaces (rejected — noisy neighbor)'],
        by: 'Oberon',
        at: 'yesterday',
      },
    ],
    prs: [],
    messages: [],
  },
  {
    id: 'release-3-0',
    name: 'release-3-0',
    topic: 'v3.0 release prep',
    starred: false,
    unread: 0,
    mentions: 0,
    agents: ['rhea'],
    repos: ['relay'],
    primaryRepo: 'relay',
    tier: 'feature_small',
    activeAt: '1d',
    tickets: [],
    decisions: [],
    prs: [],
    messages: [],
  },
  {
    id: 'crosslink-bugfix',
    name: 'crosslink-bugfix',
    topic: 'Fix heartbeat deadlock on Linux',
    starred: false,
    unread: 0,
    mentions: 0,
    agents: ['callisto'],
    repos: ['relay'],
    primaryRepo: 'relay',
    tier: 'bugfix',
    activeAt: '3d',
    tickets: [],
    decisions: [],
    prs: [],
    messages: [],
  },
];

// DMs — each DM is a direct 1:1 with an agent. Promoting a DM to a channel
// is a core affordance of this design.
const DMS = [
  {
    id: 'dm-saturn',
    agentId: 'saturn',
    unread: 1,
    activeAt: '4m',
    messages: [
      { id: 1, author: 'you',    kind: 'user',      time: '10:40', text: 'Quick one — is the `oauth_tokens` table indexed on `user_id`?' },
      { id: 2, author: 'saturn', kind: 'assistant', time: '10:41', text: 'Yes, composite `(user_id, provider)` unique index. I added it in the T-3 migration.' },
      { id: 3, author: 'saturn', kind: 'crosslink', time: '10:42', text: 'Heads up from `flowtide` — `@phoebe` saw a 429 pattern from github\'s user endpoint. Might want to add backoff before we scale.' },
    ],
  },
  {
    id: 'dm-titan',
    agentId: 'titan',
    unread: 0,
    activeAt: '22m',
    messages: [
      { id: 1, author: 'you',    kind: 'user',      time: '10:18', text: 'What\'s the story on provider-specific scopes?' },
      { id: 2, author: 'titan',  kind: 'assistant', time: '10:18', text: 'Per-provider config in `src/auth/providers/<name>.ts`. github uses `read:user user:email`, google uses `openid email profile`. Drop-in to add more.' },
    ],
  },
  {
    id: 'dm-rhea',
    agentId: 'rhea',
    unread: 0,
    activeAt: '2d',
    messages: [
      { id: 1, author: 'you',   kind: 'user',      time: 'Mon',  text: 'Can you take a look at the v3.0 changelog draft?' },
      { id: 2, author: 'rhea',  kind: 'assistant', time: 'Mon',  text: 'Pulled it. Three nits: "MCP" isn\'t defined on first use, the pod-executor bullet is misleading (still stubbed), and I\'d flip the order of "crosslink" and "channels" — channels is the user-facing term.' },
    ],
  },
  {
    id: 'dm-europa',
    agentId: 'europa',
    unread: 0,
    activeAt: '1h',
    messages: [],
  },
];

// Activity inbox — unified feed of things-that-want-you.
const ACTIVITY = [
  { id: 'a1', kind: 'approval',  channel: 'oauth-api-users', agent: 'saturn', time: '8m',   title: 'Plan awaiting approval', detail: '6 tickets · 2 repos · feature_large' },
  { id: 'a2', kind: 'ci_fail',   channel: 'oauth-api-users', agent: 'titan',  time: '18m',  title: 'CI failing on PR #483', detail: 'feat(auth): github + google adapters · 2 tests failing' },
  { id: 'a3', kind: 'pr_review', channel: 'oauth-api-users', agent: 'saturn', time: '1h',   title: 'Review requested on PR #482', detail: 'feat(auth): scaffold OAuth2 endpoint' },
  { id: 'a4', kind: 'mention',   channel: 'oauth-api-users', agent: 'titan',  time: '1h',   title: '@you in #oauth-api-users', detail: 'Titan: "@you — worth keeping the same row, not a sibling table"' },
  { id: 'a5', kind: 'ticket_fail', channel: 'pod-executor',  agent: 'phoebe', time: '2h',   title: 'Ticket P-2 failed after retry budget', detail: 'PodExecutor implements Executor · 3/3 attempts' },
];

window.RELAY_DATA = { AGENTS, REPOS, AVAILABLE_WORKSPACES, CHANNELS, DMS, ACTIVITY };
