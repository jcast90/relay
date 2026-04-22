import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelStore } from "../../src/channels/channel-store.js";
import {
  MAX_HOURS_DEFAULT,
  MAX_HOURS_MAX,
  MAX_HOURS_MIN,
  dispatchRunCommand,
  handleRunAutonomous,
  isAutonomousRun,
  parseAutonomousArgs,
  runAutonomousCommand,
} from "../../src/cli/run-autonomous.js";
import type { TicketLedgerEntry } from "../../src/domain/ticket.js";

/**
 * AL-3 tests. The parser unit tests exercise arg shapes in isolation
 * (pure functions, no disk). The handler tests seed an on-disk channel
 * in a tmp dir and drive `runAutonomousCommand` with a spy driver so we
 * never actually execute the loop-stub body twice over — we assert
 * everything the CLI entrypoint owns: validation errors, decision entry,
 * metadata file, JSON output shape, and lifecycle transitions.
 */

describe("parseAutonomousArgs", () => {
  it("rejects missing channelId", () => {
    const r = parseAutonomousArgs(["--autonomous", "--budget-tokens", "1000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/channelId/i);
  });

  it("rejects missing --budget-tokens", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--budget-tokens is required/);
  });

  it("rejects non-integer --budget-tokens", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "12.5"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positive integer/);
  });

  it("rejects zero / negative --budget-tokens", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "0"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positive integer/);
  });

  it("defaults --max-hours to 8", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "1000"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.maxHours).toBe(MAX_HOURS_DEFAULT);
  });

  it("clamps --max-hours to the minimum", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--max-hours",
      "0.01",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.maxHours).toBe(MAX_HOURS_MIN);
  });

  it("clamps --max-hours to the maximum", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--max-hours",
      "100",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.maxHours).toBe(MAX_HOURS_MAX);
  });

  it("accepts fractional --max-hours inside the range", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--max-hours",
      "2.5",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.maxHours).toBe(2.5);
  });

  it("defaults --trust to supervised", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "1000"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.trust).toBe("supervised");
  });

  it("accepts --trust god", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--trust",
      "god",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.trust).toBe("god");
  });

  it("rejects --trust with an unknown value", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--trust",
      "yolo",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/supervised/);
  });

  it("collects repeated --allow-repo values", () => {
    const r = parseAutonomousArgs([
      "--autonomous",
      "ch-1",
      "--budget-tokens",
      "1000",
      "--allow-repo",
      "ui",
      "--allow-repo",
      "be",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.allowRepos).toEqual(["ui", "be"]);
  });

  it("treats --json as a boolean", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "1000", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.json).toBe(true);
  });

  it("rejects unknown flags", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "--budget-tokens", "1000", "--yolo"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag/);
  });

  it("rejects extra positionals", () => {
    const r = parseAutonomousArgs(["--autonomous", "ch-1", "ch-2", "--budget-tokens", "1000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positional/);
  });
});

describe("runAutonomousCommand", () => {
  let root: string;
  let channelsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "al-3-root-"));
    channelsDir = join(root, "channels");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedChannel(
    options: {
      id?: string;
      assignments?: Array<{ alias: string; workspaceId: string; repoPath: string }>;
      tickets?: TicketLedgerEntry[];
    } = {}
  ): Promise<{ store: ChannelStore; channelId: string }> {
    const store = new ChannelStore(channelsDir);
    const assignments = options.assignments ?? [
      { alias: "ui", workspaceId: "ws-ui", repoPath: "/tmp/ui" },
      { alias: "be", workspaceId: "ws-be", repoPath: "/tmp/be" },
    ];
    const channel = await store.createChannel({
      name: "autonomous-test",
      description: "al-3 test channel",
      repoAssignments: assignments,
    });
    const tickets: TicketLedgerEntry[] = options.tickets ?? [
      {
        ticketId: "t-1",
        title: "first ticket",
        specialty: "general",
        status: "ready",
        dependsOn: [],
        assignedAgentId: null,
        assignedAgentName: null,
        crosslinkSessionId: null,
        verification: "pending",
        lastClassification: null,
        chosenNextAction: null,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        runId: null,
      },
    ];
    await store.writeChannelTickets(channel.channelId, tickets);
    return { store, channelId: channel.channelId };
  }

  it("rejects unknown channel", async () => {
    const store = new ChannelStore(channelsDir);
    const errors: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId: "ch-nope",
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stderr: (l) => errors.push(l),
        stdout: () => {},
      }
    );
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/not found/i);
  });

  it("rejects channel with no repo assignments", async () => {
    const store = new ChannelStore(channelsDir);
    const ch = await store.createChannel({
      name: "empty-repos",
      description: "no repos",
    });
    await store.writeChannelTickets(ch.channelId, [
      {
        ticketId: "t-1",
        title: "t",
        specialty: "general",
        status: "ready",
        dependsOn: [],
        assignedAgentId: null,
        assignedAgentName: null,
        crosslinkSessionId: null,
        verification: "pending",
        lastClassification: null,
        chosenNextAction: null,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        runId: null,
      },
    ]);
    const errors: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId: ch.channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stderr: (l) => errors.push(l),
        stdout: () => {},
      }
    );
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/no repo assignments/);
  });

  it("rejects channel with empty ticket board", async () => {
    const store = new ChannelStore(channelsDir);
    const ch = await store.createChannel({
      name: "empty-board",
      description: "no tickets",
      repoAssignments: [{ alias: "ui", workspaceId: "ws-ui", repoPath: "/tmp/ui" }],
    });
    const errors: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId: ch.channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stderr: (l) => errors.push(l),
        stdout: () => {},
      }
    );
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/empty ticket board/);
  });

  it("rejects unknown --allow-repo aliases", async () => {
    const { store, channelId } = await seedChannel();
    const errors: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: ["bogus"],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stderr: (l) => errors.push(l),
        stdout: () => {},
      }
    );
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown --allow-repo/);
    expect(errors.join("\n")).toMatch(/ui/);
    expect(errors.join("\n")).toMatch(/be/);
  });

  it("happy path: writes metadata, decision, and kills lifecycle", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const stdoutLines: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 5000,
        maxHours: 4,
        maxHoursRequested: 4,
        trust: "supervised",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: (l) => stdoutLines.push(l),
        stderr: () => {},
        startSession: driverSpy,
        command: "rly run --autonomous ch-x --budget-tokens 5000",
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeTruthy();
    const sessionId = result.sessionId!;

    // Metadata file lives under `<root>/sessions/<sessionId>/metadata.json`.
    const metadataRaw = await readFile(join(root, "sessions", sessionId, "metadata.json"), "utf8");
    const metadata = JSON.parse(metadataRaw);
    expect(metadata.sessionId).toBe(sessionId);
    expect(metadata.channelId).toBe(channelId);
    expect(metadata.budgetTokens).toBe(5000);
    expect(metadata.maxHours).toBe(4);
    expect(metadata.trust).toBe("supervised");
    expect(metadata.allowedRepos).toEqual(["ui", "be"]);
    expect(metadata.command).toMatch(/--autonomous/);

    // Decision should be recorded with the autonomous_session_started type.
    const decisions = await store.listDecisions(channelId);
    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    expect(decision.type).toBe("autonomous_session_started");
    expect(decision.metadata).toMatchObject({
      sessionId,
      channelId,
      budgetTokens: 5000,
      maxHours: 4,
      trust: "supervised",
      allowedRepos: ["ui", "be"],
    });
    expect(decision.metadata?.startedAt).toBeTruthy();
    expect(decision.metadata?.command).toMatch(/--autonomous/);
    expect(decision.metadata?.invokedBy).toBeTruthy();

    // Driver spy was called with the constructed bundle.
    expect(driverSpy).toHaveBeenCalledTimes(1);
    const call = driverSpy.mock.calls[0][0];
    expect(call.sessionId).toBe(sessionId);
    expect(call.trust).toBe("supervised");
    expect(call.allowedRepos.map((a: { alias: string }) => a.alias)).toEqual(["ui", "be"]);
    expect(call.channel.channelId).toBe(channelId);

    // Lifecycle file exists and reached `dispatching` before handoff.
    const lifecycleRaw = await readFile(
      join(root, "sessions", sessionId, "lifecycle.json"),
      "utf8"
    );
    const lifecycle = JSON.parse(lifecycleRaw);
    expect(lifecycle.state).toBe("dispatching");
    // First transition should record the AL-3 handoff reason.
    expect(lifecycle.transitions[0].reason).toBe("autonomous-session-started");
  });

  it("happy path with real stub driver: ends lifecycle in killed/al-13-pending", async () => {
    const { store, channelId } = await seedChannel();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runAutonomousCommand(
        {
          channelId,
          budgetTokens: 1000,
          maxHours: 2,
          maxHoursRequested: 2,
          trust: "supervised",
          allowRepos: [],
          json: false,
        },
        {
          rootDir: root,
          channelStore: store,
          stdout: () => {},
          stderr: () => {},
        }
      );
      expect(result.exitCode).toBe(0);
      const sessionId = result.sessionId!;
      const lifecycleRaw = await readFile(
        join(root, "sessions", sessionId, "lifecycle.json"),
        "utf8"
      );
      const lifecycle = JSON.parse(lifecycleRaw);
      expect(lifecycle.state).toBe("killed");
      const final = lifecycle.transitions[lifecycle.transitions.length - 1];
      // AL-12 boots the repo-admin pool before the stub ends, so the
      // terminal reason advanced from "al-4-pending" to "al-13-pending"
      // (the next gap is ticket routing, AL-13).
      expect(final.reason).toBe("al-13-pending");
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("--allow-repo filters the handoff set", async () => {
    const { store, channelId } = await seedChannel({
      assignments: [
        { alias: "ui", workspaceId: "ws-ui", repoPath: "/tmp/ui" },
        { alias: "be", workspaceId: "ws-be", repoPath: "/tmp/be" },
        { alias: "ops", workspaceId: "ws-ops", repoPath: "/tmp/ops" },
      ],
    });
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: ["ui", "ops"],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: () => {},
        stderr: () => {},
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    const call = driverSpy.mock.calls[0][0];
    expect(call.allowedRepos.map((a: { alias: string }) => a.alias)).toEqual(["ui", "ops"]);
  });

  it("--json emits a single machine-readable line with the spec shape", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const stdoutLines: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 7777,
        maxHours: 3,
        maxHoursRequested: 3,
        trust: "supervised",
        allowRepos: ["ui"],
        json: true,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: (l) => stdoutLines.push(l),
        stderr: () => {},
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]);
    expect(parsed).toMatchObject({
      sessionId: result.sessionId,
      channelId,
      budgetTokens: 7777,
      maxHours: 3,
      trust: "supervised",
      allowedRepos: ["ui"],
    });
    expect(typeof parsed.startedAt).toBe("string");
  });

  it("--trust god emits the STOP-file warning", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const errs: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "god",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: () => {},
        stderr: (l) => errs.push(l),
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    expect(errs.join("\n")).toMatch(/warning: --trust god/);
    expect(errs.join("\n")).toMatch(/STOP file/);
    expect(errs.join("\n")).toMatch(new RegExp(result.sessionId!));
  });

  it("--max-hours 0.5 clamps up, warns on stderr, surfaces both values in JSON", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const errs: string[] = [];
    const outs: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: MAX_HOURS_MIN,
        maxHoursRequested: 0.5,
        trust: "supervised",
        allowRepos: [],
        json: true,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: (l) => outs.push(l),
        stderr: (l) => errs.push(l),
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    const combined = errs.join("\n");
    expect(combined).toMatch(new RegExp(`warning: --max-hours 0\\.5 clamped to ${MAX_HOURS_MIN}`));
    expect(combined).toMatch(new RegExp(`valid range ${MAX_HOURS_MIN}.${MAX_HOURS_MAX}`));
    const parsed = JSON.parse(outs[0]);
    expect(parsed.maxHours).toBe(MAX_HOURS_MIN);
    expect(parsed.maxHoursRequested).toBe(0.5);

    const metadataRaw = await readFile(
      join(root, "sessions", result.sessionId!, "metadata.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataRaw);
    expect(metadata.maxHours).toBe(MAX_HOURS_MIN);
    expect(metadata.maxHoursRequested).toBe(0.5);
  });

  it("--max-hours 100 clamps down, warns on stderr, surfaces both values in JSON", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const errs: string[] = [];
    const outs: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: MAX_HOURS_MAX,
        maxHoursRequested: 100,
        trust: "supervised",
        allowRepos: [],
        json: true,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: (l) => outs.push(l),
        stderr: (l) => errs.push(l),
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    const combined = errs.join("\n");
    expect(combined).toMatch(/warning: --max-hours 100 clamped to 48/);
    expect(combined).toMatch(/valid range 1/);
    expect(combined).toMatch(/48/);
    const parsed = JSON.parse(outs[0]);
    expect(parsed.maxHours).toBe(MAX_HOURS_MAX);
    expect(parsed.maxHoursRequested).toBe(100);

    const metadataRaw = await readFile(
      join(root, "sessions", result.sessionId!, "metadata.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataRaw);
    expect(metadata.maxHours).toBe(MAX_HOURS_MAX);
    expect(metadata.maxHoursRequested).toBe(100);
  });

  it("--max-hours 8 (in range) emits no clamp warning and sets requested === final", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const errs: string[] = [];
    const outs: string[] = [];
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 1000,
        maxHours: 8,
        maxHoursRequested: 8,
        trust: "supervised",
        allowRepos: [],
        json: true,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: (l) => outs.push(l),
        stderr: (l) => errs.push(l),
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    // No clamp warning, even though other stderr lines may appear (e.g.
    // god-mode warning isn't set here, so stderr should be empty).
    expect(errs.join("\n")).not.toMatch(/clamped/);
    const parsed = JSON.parse(outs[0]);
    expect(parsed.maxHours).toBe(8);
    expect(parsed.maxHoursRequested).toBe(8);

    const metadataRaw = await readFile(
      join(root, "sessions", result.sessionId!, "metadata.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataRaw);
    expect(metadata.maxHours).toBe(8);
    expect(metadata.maxHoursRequested).toBe(8);
  });

  it("session dir contains tracker + lifecycle + metadata", async () => {
    const { store, channelId } = await seedChannel();
    const driverSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runAutonomousCommand(
      {
        channelId,
        budgetTokens: 500,
        maxHours: 1,
        maxHoursRequested: 1,
        trust: "supervised",
        allowRepos: [],
        json: false,
      },
      {
        rootDir: root,
        channelStore: store,
        stdout: () => {},
        stderr: () => {},
        startSession: driverSpy,
      }
    );
    expect(result.exitCode).toBe(0);
    const files = await readdir(join(root, "sessions", result.sessionId!));
    expect(files.sort()).toContain("metadata.json");
    expect(files.sort()).toContain("lifecycle.json");
  });
});

describe("dispatchRunCommand (run intercept routing)", () => {
  // These tests lock the routing contract used by `src/index.ts`: when
  // `--autonomous` is anywhere in `args`, dispatch MUST go to the
  // autonomous handler even if a positional (channelId) precedes other
  // flags. A refactor that moves the intercept below the feature-request
  // parse would fail these — which is the whole point, per the AL-3
  // review.

  it("routes `run --autonomous ch-1 --budget-tokens 1000000` to the autonomous handler", async () => {
    const autonomousSpy = vi.fn().mockResolvedValue({ exitCode: 0, sessionId: "auto-xyz" });
    const featureSpy = vi.fn().mockResolvedValue({ exitCode: 0 });
    const args = ["--autonomous", "ch-1", "--budget-tokens", "1000000"];
    const result = await dispatchRunCommand(args, {
      autonomous: autonomousSpy,
      featureRequest: featureSpy,
    });
    expect(result.handler).toBe("autonomous");
    expect(result.exitCode).toBe(0);
    expect(autonomousSpy).toHaveBeenCalledTimes(1);
    expect(autonomousSpy).toHaveBeenCalledWith(args);
    expect(featureSpy).not.toHaveBeenCalled();
  });

  it('routes `run "Add auth"` (no --autonomous) to the feature-request handler', async () => {
    const autonomousSpy = vi.fn().mockResolvedValue({ exitCode: 0 });
    const featureSpy = vi.fn().mockResolvedValue({ exitCode: 0 });
    const args = ["Add user authentication"];
    const result = await dispatchRunCommand(args, {
      autonomous: autonomousSpy,
      featureRequest: featureSpy,
    });
    expect(result.handler).toBe("featureRequest");
    expect(featureSpy).toHaveBeenCalledTimes(1);
    expect(autonomousSpy).not.toHaveBeenCalled();
  });

  it("isAutonomousRun returns true when --autonomous appears anywhere in args", () => {
    expect(isAutonomousRun(["--autonomous", "ch-1", "--budget-tokens", "1000"])).toBe(true);
    expect(isAutonomousRun(["ch-1", "--budget-tokens", "1000", "--autonomous"])).toBe(true);
    expect(isAutonomousRun(["Add auth feature"])).toBe(false);
    expect(isAutonomousRun([])).toBe(false);
  });

  it("propagates the autonomous handler's non-zero exit code", async () => {
    const autonomousSpy = vi.fn().mockResolvedValue({ exitCode: 1 });
    const featureSpy = vi.fn().mockResolvedValue({ exitCode: 0 });
    const result = await dispatchRunCommand(
      ["--autonomous", "ch-1", "--budget-tokens", "1000000"],
      { autonomous: autonomousSpy, featureRequest: featureSpy }
    );
    expect(result.handler).toBe("autonomous");
    expect(result.exitCode).toBe(1);
  });
});

describe("handleRunAutonomous (public entrypoint)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "al-3-entry-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints usage + exits 1 on parse failure", async () => {
    const errs: string[] = [];
    const result = await handleRunAutonomous(["--autonomous", "ch-1"], {
      rootDir: root,
      stderr: (l) => errs.push(l),
      stdout: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/--budget-tokens/);
    expect(errs.join("\n")).toMatch(/Usage: rly run --autonomous/);
  });
});
