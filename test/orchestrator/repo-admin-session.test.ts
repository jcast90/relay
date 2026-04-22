/**
 * AL-12 — RepoAdminSession unit tests.
 *
 * Covers the single-process lifecycle in isolation:
 *  - boot() wires the child and emits `booted`
 *  - unexpected exit emits `exited-unexpected` with stderr tail
 *  - stop() SIGTERM → SIGKILL escalation
 *  - dispatchTicket() throws (AL-13 stub guard)
 *
 * Uses a FakeSpawner so no real `claude` binary is invoked. The fake
 * exposes hooks for the test to fire onExit / onStderr / onError at the
 * right moment, which is the whole point of the abstraction.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SpawnedProcess } from "../../src/agents/command-invoker.js";
import type { RepoAssignment } from "../../src/domain/channel.js";
import {
  RepoAdminSession,
  STDERR_DIAGNOSTIC_LINES,
  type RepoAdminProcessSpawner,
  type RepoAdminSessionEvent,
  type RepoAdminSpawnArgs,
} from "../../src/orchestrator/repo-admin-session.js";

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type StderrListener = (chunk: string) => void;
type StdoutListener = (chunk: string) => void;
type ErrorListener = (err: Error) => void;

interface FakeChild extends SpawnedProcess {
  readonly killCalls: Array<NodeJS.Signals | undefined>;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(err: Error): void;
  /** True after `kill()` returns. Mirrors `ChildProcess.killed`. */
  killed: boolean;
  /** The spawn args this fake was handed. */
  spawnArgs: RepoAdminSpawnArgs;
}

function makeFakeChild(spawnArgs: RepoAdminSpawnArgs): FakeChild {
  const stdoutListeners: StdoutListener[] = [];
  const stderrListeners: StderrListener[] = [];
  const exitListeners: ExitListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const killCalls: Array<NodeJS.Signals | undefined> = [];

  const fake: FakeChild = {
    pid: 42_000 + Math.floor(Math.random() * 1000),
    killed: false,
    spawnArgs,
    killCalls,
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr(listener) {
      stderrListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    kill(signal) {
      killCalls.push(signal);
      this.killed = true;
      return true;
    },
    emitStdout(chunk) {
      for (const l of stdoutListeners) l(chunk);
    },
    emitStderr(chunk) {
      for (const l of stderrListeners) l(chunk);
    },
    emitExit(code, signal = null) {
      for (const l of exitListeners) l(code, signal);
    },
    emitError(err) {
      for (const l of errorListeners) l(err);
    },
  };
  return fake;
}

class FakeSpawner implements RepoAdminProcessSpawner {
  readonly children: FakeChild[] = [];
  spawn(args: RepoAdminSpawnArgs): SpawnedProcess {
    const child = makeFakeChild(args);
    this.children.push(child);
    return child;
  }
  last(): FakeChild {
    const c = this.children.at(-1);
    if (!c) throw new Error("no child spawned yet");
    return c;
  }
}

const BASE_ASSIGNMENT: RepoAssignment = {
  alias: "frontend",
  workspaceId: "ws-front",
  repoPath: "/tmp/fake-frontend-repo",
};

describe("RepoAdminSession", () => {
  let root: string;
  let sessionIdCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-admin-session-"));
    sessionIdCounter = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function buildSession(
    overrides: {
      spawner?: FakeSpawner;
      fullAccess?: boolean;
    } = {}
  ) {
    const spawner = overrides.spawner ?? new FakeSpawner();
    const logDir = join(root, "repo-admins", BASE_ASSIGNMENT.alias);
    const session = new RepoAdminSession({
      assignment: BASE_ASSIGNMENT,
      fullAccess: overrides.fullAccess ?? false,
      logDir,
      spawner,
      buildSessionId: () => `admin-fake-${++sessionIdCounter}`,
      stopGraceMs: 20, // trim real delay out of tests
    });
    return { session, spawner, logDir };
  }

  it("start() spawns a child and transitions to `ready`", async () => {
    const { session, spawner } = buildSession();
    expect(session.state).toBe("booting");

    const events: RepoAdminSessionEvent[] = [];
    session.onEvent((evt) => events.push(evt));

    await session.start();

    expect(session.state).toBe("ready");
    expect(spawner.children).toHaveLength(1);
    expect(session.sessionId).toBe("admin-fake-1");
    expect(session.spawnCount).toBe(1);
    expect(events).toEqual([{ kind: "booted", sessionId: "admin-fake-1" }]);
  });

  it("writes metadata.json with alias / repoPath / sessionId", async () => {
    const { session, logDir } = buildSession();
    await session.start();

    const metaPath = join(logDir, "metadata.json");
    const parsed = JSON.parse(await readFile(metaPath, "utf8"));
    expect(parsed.alias).toBe(BASE_ASSIGNMENT.alias);
    expect(parsed.repoPath).toBe(BASE_ASSIGNMENT.repoPath);
    expect(parsed.currentSessionId).toBe(session.sessionId);
    expect(parsed.spawnCount).toBe(1);
  });

  it("forwards `fullAccess` into the spawner args", async () => {
    const spawner = new FakeSpawner();
    const { session } = buildSession({ spawner, fullAccess: true });
    await session.start();

    expect(spawner.last().spawnArgs.fullAccess).toBe(true);
  });

  it("double start() is a no-op (doesn't spawn twice)", async () => {
    const { session, spawner } = buildSession();
    await session.start();
    await session.start();
    expect(spawner.children).toHaveLength(1);
  });

  it("unexpected exit emits `exited-unexpected` with stderr tail", async () => {
    const { session, spawner } = buildSession();
    const events: RepoAdminSessionEvent[] = [];
    session.onEvent((evt) => events.push(evt));
    await session.start();

    spawner.last().emitStderr("boom: something broke\n");
    spawner.last().emitExit(7, null);

    expect(session.state).toBe("dead");
    const unexpected = events.find((e) => e.kind === "exited-unexpected");
    expect(unexpected).toBeDefined();
    if (unexpected?.kind === "exited-unexpected") {
      expect(unexpected.exitCode).toBe(7);
      expect(unexpected.stderrTail).toContain("boom: something broke");
      expect(unexpected.previousSessionId).toBe("admin-fake-1");
    }
  });

  it("caps stderr retention to STDERR_DIAGNOSTIC_LINES", async () => {
    const { session, spawner } = buildSession();
    const events: RepoAdminSessionEvent[] = [];
    session.onEvent((evt) => events.push(evt));
    await session.start();

    const total = STDERR_DIAGNOSTIC_LINES + 50;
    for (let i = 0; i < total; i += 1) {
      spawner.last().emitStderr(`line-${i}\n`);
    }
    spawner.last().emitExit(1, null);

    const evt = events.find((e) => e.kind === "exited-unexpected");
    if (!evt || evt.kind !== "exited-unexpected") throw new Error("missing event");
    const lines = evt.stderrTail.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(STDERR_DIAGNOSTIC_LINES);
    // The oldest lines must have been evicted.
    expect(lines).not.toContain("line-0");
    expect(lines.at(-1)).toBe(`line-${total - 1}`);
  });

  it("stop() SIGTERMs first, escalates to SIGKILL after grace", async () => {
    const { session, spawner } = buildSession();
    await session.start();

    // Fire-and-forget stop; resolve by synthesizing the exit AFTER the
    // grace timer has had a chance to fire SIGKILL. Child ignores SIGTERM
    // on purpose.
    const stopP = session.stop("test");

    // Give the microtask + setTimeout(20) enough time to land the
    // SIGKILL. `stopGraceMs` is 20ms in this test.
    await new Promise((r) => setTimeout(r, 60));
    expect(spawner.last().killCalls).toContain("SIGTERM");
    expect(spawner.last().killCalls).toContain("SIGKILL");

    // Synthesize the exit so stop() can resolve.
    spawner.last().emitExit(null, "SIGKILL");
    await stopP;

    expect(session.state).toBe("stopped");
  });

  it("stop() is idempotent — second call resolves once first does", async () => {
    const { session, spawner } = buildSession();
    await session.start();

    const first = session.stop("test");
    const second = session.stop("test");

    // Synthesize exit so both stops resolve.
    spawner.last().emitExit(0, "SIGTERM");
    await Promise.all([first, second]);
    expect(session.state).toBe("stopped");
    // Only one SIGTERM was sent — the second stop waited, didn't re-signal.
    const terms = spawner.last().killCalls.filter((s) => s === "SIGTERM");
    expect(terms).toHaveLength(1);
  });

  it("dispatchTicket throws — AL-13 stub guard", async () => {
    const { session } = buildSession();
    await session.start();
    await expect(session.dispatchTicket({ ticketId: "t-1" })).rejects.toThrow(
      /implemented in AL-13/
    );
  });

  it("spawn error path surfaces in stderr tail + flips to dead", async () => {
    const { session, spawner } = buildSession();
    const events: RepoAdminSessionEvent[] = [];
    session.onEvent((evt) => events.push(evt));
    await session.start();

    spawner.last().emitError(new Error("ENOENT claude not found"));

    const evt = events.find((e) => e.kind === "exited-unexpected");
    expect(evt?.kind).toBe("exited-unexpected");
    if (evt?.kind === "exited-unexpected") {
      expect(evt.stderrTail).toContain("spawn-error");
      expect(evt.stderrTail).toContain("ENOENT");
    }
    expect(session.state).toBe("dead");
  });

  it("pendingDispatches is empty by default (AL-13 populates it later)", async () => {
    const { session } = buildSession();
    await session.start();
    expect(session.getPendingDispatches()).toEqual([]);
  });

  it("start() after stop() throws — session is single-life", async () => {
    const { session, spawner } = buildSession();
    await session.start();
    const stopP = session.stop("test");
    spawner.last().emitExit(0, "SIGTERM");
    await stopP;

    await expect(session.start()).rejects.toThrow(/cannot start\(\) after stop/);
  });
});
