import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import {
  __resetActiveWatcherForTests,
  createPrWatcherFactory,
  getActiveWatcher,
  parseGithubRemote,
  type ExecGit
} from "../../src/cli/pr-watcher-factory.js";
import type { HarnessRun } from "../../src/domain/run.js";
import type { TicketScheduler } from "../../src/orchestrator/ticket-scheduler.js";

/**
 * Build a minimal `HarnessRun` sufficient for factory invocation.
 * The factory only reads: `channelId`, `classification.suggestedBranch`,
 * `ticketPlan.tickets`, and `ticketLedger`. Everything else can stay empty.
 */
function minimalRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
  const now = new Date().toISOString();
  return {
    id: "run-test",
    featureRequest: "test",
    state: "CLASSIFYING",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    channelId: null,
    classification: null,
    plan: null,
    ticketPlan: null,
    events: [],
    evidence: [],
    artifacts: [],
    phaseLedger: [],
    phaseLedgerPath: null,
    ticketLedger: [],
    ticketLedgerPath: null,
    runIndexPath: null,
    ...overrides
  };
}

function stubScheduler(): Pick<TicketScheduler, "enqueue"> {
  // The factory only passes `scheduler` through to SchedulerFollowUpDispatcher
  // which calls `enqueue` on follow-up events. Factory startup doesn't touch
  // it, so a bare stub is fine for these tests.
  return {
    enqueue: vi.fn(async () => {
      /* no-op */
    })
  } as unknown as Pick<TicketScheduler, "enqueue">;
}

describe("parseGithubRemote", () => {
  it("parses HTTPS remotes with and without .git", () => {
    expect(parseGithubRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo"
    });
    expect(parseGithubRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo"
    });
  });

  it("parses SSH remotes", () => {
    expect(parseGithubRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo"
    });
    expect(parseGithubRemote("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      name: "repo"
    });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGithubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
    expect(parseGithubRemote("not a url")).toBeNull();
  });
});

describe("createPrWatcherFactory", () => {
  let tmpDir: string;
  let channelStore: ChannelStore;
  const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pr-watcher-factory-"));
    channelStore = new ChannelStore(tmpDir);
    __resetActiveWatcherForTests();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    __resetActiveWatcherForTests();
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it("returns a no-op handle when GITHUB_TOKEN is absent", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const execGit: ExecGit = vi.fn();

    const factory = createPrWatcherFactory({
      channelStore,
      repoRoot: "/irrelevant",
      execGit
    });

    const handle = factory({
      run: minimalRun(),
      scheduler: stubScheduler() as TicketScheduler
    });

    expect(handle).not.toBeNull();
    expect(() => handle!.start()).not.toThrow();
    expect(() => handle!.stop()).not.toThrow();
    // Factory should not even try to shell out when token is missing.
    expect(execGit).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[pr-watcher] GITHUB_TOKEN not set — PR watching disabled"
    );
    expect(getActiveWatcher()).toBeNull();

    infoSpy.mockRestore();
  });

  it("posts a channel-level warning entry when GITHUB_TOKEN is absent", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const execGit: ExecGit = vi.fn();

    // Seed a channel and pass its id to the factory so the warning has a
    // home. Without `defaultChannelId` (and `run.channelId`) there is no
    // channel to post to — that case is intentionally silent, covered by
    // the stdout info message above.
    const channel = await channelStore.createChannel({
      name: "#test",
      description: "missing-token test"
    });

    const factory = createPrWatcherFactory({
      channelStore,
      repoRoot: "/irrelevant",
      defaultChannelId: channel.channelId,
      execGit
    });

    factory({
      run: minimalRun(),
      scheduler: stubScheduler() as TicketScheduler
    });

    // Let the fire-and-forget postEntry settle. postEntry awaits mkdir,
    // appendFile, and touchChannel (which re-reads + writes channel.json),
    // so a real timer flush is more reliable than microtask pumping.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await channelStore.readFeed(channel.channelId);
    const warning = entries.find(
      (e) =>
        e.type === "status_update" &&
        e.metadata.warning === "missing_github_token"
    );
    expect(warning).toBeDefined();
    expect(warning!.fromDisplayName).toBe("PR Watcher");
    expect(warning!.content).toContain("GITHUB_TOKEN not set");
    expect(warning!.metadata.component).toBe("pr-watcher");

    infoSpy.mockRestore();
  });

  it("posts the missing-token warning only once per channel per process", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const execGit: ExecGit = vi.fn();

    const channel = await channelStore.createChannel({
      name: "#test-dedupe",
      description: "dedupe test"
    });

    const factory = createPrWatcherFactory({
      channelStore,
      repoRoot: "/irrelevant",
      defaultChannelId: channel.channelId,
      execGit
    });

    // Invoke the factory three times — simulating three back-to-back runs.
    for (let i = 0; i < 3; i += 1) {
      factory({
        run: minimalRun(),
        scheduler: stubScheduler() as TicketScheduler
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await channelStore.readFeed(channel.channelId);
    const warnings = entries.filter(
      (e) =>
        e.type === "status_update" &&
        e.metadata.warning === "missing_github_token"
    );
    expect(warnings).toHaveLength(1);

    infoSpy.mockRestore();
  });

  it("returns a no-op handle when git remote resolution fails", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execGit: ExecGit = vi.fn(async () => {
      throw new Error("fatal: not a git repository");
    });

    const factory = createPrWatcherFactory({
      channelStore,
      repoRoot: "/not/a/repo",
      execGit
    });

    const handle = factory({
      run: minimalRun(),
      scheduler: stubScheduler() as TicketScheduler
    });

    expect(handle).not.toBeNull();
    handle!.start();
    // Let the deferred repo detection settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(execGit).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not determine GitHub repo")
    );
    // Detection failed, so the singleton should never have been populated.
    expect(getActiveWatcher()).toBeNull();
    expect(() => handle!.stop()).not.toThrow();

    warnSpy.mockRestore();
  });

  it("happy path: constructs SCM/poller and exposes the active watcher", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    const execGit: ExecGit = vi.fn(async () => ({
      stdout: "git@github.com:acme/widgets.git\n",
      stderr: ""
    }));

    // Use a large intervalMs so the branch-detection setInterval never fires
    // during the test body — we only want to observe the immediate kick.
    const factory = createPrWatcherFactory({
      channelStore,
      repoRoot: "/repo",
      intervalMs: 60_000,
      execGit
    });

    const handle = factory({
      run: minimalRun(),
      scheduler: stubScheduler() as TicketScheduler
    });

    handle!.start();
    // Let the async repo-detection chain resolve so the watcher publishes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const watcher = getActiveWatcher();
    expect(watcher).not.toBeNull();
    expect(watcher!.repo).toEqual({ owner: "acme", name: "widgets" });
    expect(watcher!.listTracked()).toEqual([]);

    handle!.stop();
    expect(getActiveWatcher()).toBeNull();
  });
});

// Live-network / real-GitHub scenarios are intentionally skipped — covering
// them properly requires a real token and a real repo, which belongs in an
// integration harness, not a unit test.
describe.skip("createPrWatcherFactory — live network (requires GITHUB_TOKEN)", () => {
  it("detects a PR on the branch from a real GitHub remote", () => {
    // Intentionally empty; see block comment above.
  });
});
