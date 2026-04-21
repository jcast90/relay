import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  rewindApply,
  rewindSnapshot,
  type RewindDeps
} from "../src/cli/chat-rewind.js";
import { SessionStore } from "../src/cli/session-store.js";
import type { Channel } from "../src/domain/channel.js";
import type {
  BlobRef,
  ChangeEvent,
  HarnessStore
} from "../src/storage/store.js";

// Minimal HarnessStore stub: the rewind flow only ever touches SessionStore,
// which in turn writes/deletes an advisory coordination record. Anything
// the rewind tests don't call throws so unexpected usage is loud.
class NullHarnessStore implements HarnessStore {
  async getDoc<T>(): Promise<T | null> {
    return null;
  }
  async putDoc(): Promise<void> {}
  async listDocs<T>(): Promise<T[]> {
    return [];
  }
  async deleteDoc(): Promise<void> {}
  async appendLog(): Promise<void> {
    throw new Error("NullHarnessStore.appendLog not used by rewind tests");
  }
  async readLog<T>(): Promise<T[]> {
    throw new Error("NullHarnessStore.readLog not used by rewind tests");
  }
  async putBlob(): Promise<BlobRef> {
    throw new Error("NullHarnessStore.putBlob not used by rewind tests");
  }
  async getBlob(): Promise<Uint8Array> {
    throw new Error("NullHarnessStore.getBlob not used by rewind tests");
  }
  async mutate<T>(
    _ns: string,
    _id: string,
    fn: (prev: T | null) => T
  ): Promise<T> {
    return fn(null);
  }
  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<ChangeEvent> {
    throw new Error("NullHarnessStore.watch not used by rewind tests");
  }
}

/** Fake ChannelStore with just `getChannel` — that's all rewind needs. */
function fakeChannelStore(channel: Channel | null): RewindDeps["channelStore"] {
  return { getChannel: async () => channel };
}

type GitCall = { args: string[]; cwd: string };

interface GitFakeOptions {
  /** Per-cwd stdout scripted by command key (e.g. "rev-parse HEAD"). */
  stdoutByKey?: Record<string, Record<string, string>>;
  /** Throw on a given key (per-cwd) with the provided error message. */
  throwByKey?: Record<string, Record<string, string>>;
}

/**
 * Build a fake `gitExec`. Commands are keyed by `args.join(" ")` so tests
 * can map precise invocations to precise scripted outputs. Any unmatched
 * call succeeds with empty stdout — harmless for no-op writes like
 * `update-ref`.
 */
function makeGit(opts: GitFakeOptions = {}) {
  const calls: GitCall[] = [];
  const stdoutByKey = opts.stdoutByKey ?? {};
  const throwByKey = opts.throwByKey ?? {};
  const exec: RewindDeps["gitExec"] = async (args, { cwd }) => {
    calls.push({ args: [...args], cwd });
    const key = args.join(" ");
    const thrown = throwByKey[cwd]?.[key];
    if (thrown !== undefined) {
      throw new Error(thrown);
    }
    const stdout = stdoutByKey[cwd]?.[key] ?? "";
    return { stdout, stderr: "" };
  };
  return { exec, calls };
}

function makeChannel(repoPaths: string[]): Channel {
  return {
    channelId: "ch-1",
    name: "#test",
    description: "",
    status: "active",
    workspaceIds: [],
    members: [],
    pinnedRefs: [],
    repoAssignments: repoPaths.map((p, i) => ({
      alias: `repo${i + 1}`,
      workspaceId: `ws-${i + 1}`,
      repoPath: p
    })),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z"
  };
}

describe("rewindSnapshot", () => {
  it("writes a rewind ref per repo and returns the captured SHAs", async () => {
    const channel = makeChannel(["/repos/a", "/repos/b"]);
    const git = makeGit({
      stdoutByKey: {
        "/repos/a": { "rev-parse HEAD": "a1b2c3d\n" },
        "/repos/b": { "rev-parse HEAD": "e4f5g6h\n" }
      }
    });
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async () => 0,
        clearClaudeSessionIds: async () => null
      },
      gitExec: git.exec,
      now: () => 1700000000000
    };

    const result = await rewindSnapshot("ch-1", "sess-1", deps);

    expect(result.key).toBe("1700000000000");
    expect(result.snapshots).toEqual([
      {
        alias: "repo1",
        repoPath: "/repos/a",
        sha: "a1b2c3d",
        ref: "refs/harness-rewind/sess-1/1700000000000"
      },
      {
        alias: "repo2",
        repoPath: "/repos/b",
        sha: "e4f5g6h",
        ref: "refs/harness-rewind/sess-1/1700000000000"
      }
    ]);

    // Every repo got exactly one rev-parse HEAD + one update-ref.
    const perRepo = (cwd: string) => git.calls.filter((c) => c.cwd === cwd);
    expect(perRepo("/repos/a").map((c) => c.args[0])).toEqual([
      "rev-parse",
      "update-ref"
    ]);
    expect(perRepo("/repos/b").map((c) => c.args[0])).toEqual([
      "rev-parse",
      "update-ref"
    ]);
  });

  it("throws a clear error when the channel is missing", async () => {
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(null),
      sessionStore: {
        truncateBeforeTimestamp: async () => 0,
        clearClaudeSessionIds: async () => null
      },
      gitExec: makeGit().exec
    };
    await expect(rewindSnapshot("missing", "sess-x", deps)).rejects.toThrow(
      /Channel not found/
    );
  });

  it("throws when `git rev-parse HEAD` produces empty output", async () => {
    const channel = makeChannel(["/repos/a"]);
    const git = makeGit({
      stdoutByKey: { "/repos/a": { "rev-parse HEAD": "" } }
    });
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async () => 0,
        clearClaudeSessionIds: async () => null
      },
      gitExec: git.exec
    };
    await expect(rewindSnapshot("ch-1", "sess-1", deps)).rejects.toThrow(
      /empty output/
    );
  });
});

describe("rewindApply", () => {
  const channel = makeChannel(["/repos/a", "/repos/b"]);
  const refKey = "abc123";
  const refName = `refs/harness-rewind/sess-1/${refKey}`;

  function happyPathGit() {
    return makeGit({
      stdoutByKey: {
        "/repos/a": {
          [`rev-parse --verify ${refName}^{commit}`]: "aaa\n",
          "status --porcelain": ""
        },
        "/repos/b": {
          [`rev-parse --verify ${refName}^{commit}`]: "bbb\n",
          "status --porcelain": ""
        }
      }
    });
  }

  it("pre-flight-verifies every ref + clean worktree before mutating", async () => {
    const git = happyPathGit();
    const truncated: Array<{ channelId: string; sessionId: string; ts: string }> =
      [];
    const cleared: Array<{ channelId: string; sessionId: string }> = [];
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async (channelId, sessionId, ts) => {
          truncated.push({ channelId, sessionId, ts });
          return 3;
        },
        clearClaudeSessionIds: async (channelId, sessionId) => {
          cleared.push({ channelId, sessionId });
          return null;
        }
      },
      gitExec: git.exec
    };

    const result = await rewindApply(
      "ch-1",
      "sess-1",
      refKey,
      "2025-01-01T00:00:05.000Z",
      deps
    );

    // Each reset advertises its SHA.
    expect(result.reset).toEqual([
      { alias: "repo1", repoPath: "/repos/a", sha: "aaa" },
      { alias: "repo2", repoPath: "/repos/b", sha: "bbb" }
    ]);
    expect(result.removedMessages).toBe(3);

    // Critical ordering property: every rev-parse --verify + status must
    // come before any reset --hard. Find the earliest reset index and the
    // latest pre-flight index and make sure pre-flight < resets.
    const kinds = git.calls.map((c) => c.args.join(" "));
    const firstReset = kinds.findIndex((k) => k.startsWith("reset --hard"));
    const lastPreflight = Math.max(
      ...kinds
        .map((k, i) =>
          k.startsWith("rev-parse --verify") || k === "status --porcelain"
            ? i
            : -1
        )
        .filter((i) => i >= 0)
    );
    expect(lastPreflight).toBeLessThan(firstReset);

    expect(truncated).toHaveLength(1);
    expect(cleared).toHaveLength(1);
  });

  it("refuses to rewind when any repo has a dirty worktree", async () => {
    const git = makeGit({
      stdoutByKey: {
        "/repos/a": {
          [`rev-parse --verify ${refName}^{commit}`]: "aaa\n",
          "status --porcelain": ""
        },
        "/repos/b": {
          [`rev-parse --verify ${refName}^{commit}`]: "bbb\n",
          "status --porcelain": " M src/hand-edited.ts\n?? untracked.txt\n"
        }
      }
    });
    let truncated = false;
    let cleared = false;
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async () => {
          truncated = true;
          return 0;
        },
        clearClaudeSessionIds: async () => {
          cleared = true;
          return null;
        }
      },
      gitExec: git.exec
    };

    await expect(
      rewindApply("ch-1", "sess-1", refKey, "2025-01-01T00:00:00.000Z", deps)
    ).rejects.toThrow(/uncommitted or untracked/);

    // Pre-flight must fail BEFORE any reset --hard or session mutation.
    expect(
      git.calls.some((c) => c.args[0] === "reset" && c.args[1] === "--hard")
    ).toBe(false);
    expect(truncated).toBe(false);
    expect(cleared).toBe(false);
  });

  it("refuses to rewind when the target ref is missing in any repo", async () => {
    const git = makeGit({
      stdoutByKey: {
        "/repos/a": {
          [`rev-parse --verify ${refName}^{commit}`]: "aaa\n",
          "status --porcelain": ""
        }
      },
      throwByKey: {
        "/repos/b": {
          [`rev-parse --verify ${refName}^{commit}`]: "fatal: Needed a single revision"
        }
      }
    });
    let truncated = false;
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async () => {
          truncated = true;
          return 0;
        },
        clearClaudeSessionIds: async () => null
      },
      gitExec: git.exec
    };

    await expect(
      rewindApply("ch-1", "sess-1", refKey, "2025-01-01T00:00:00.000Z", deps)
    ).rejects.toThrow(/missing or unresolvable/);

    expect(
      git.calls.some((c) => c.args[0] === "reset" && c.args[1] === "--hard")
    ).toBe(false);
    expect(truncated).toBe(false);
  });

  it("does NOT truncate the session log if a mid-flight reset fails", async () => {
    // Pre-flight passes for both repos, but /repos/b's reset --hard throws
    // (e.g. concurrent lock, disk full, corrupted index). The audit
    // requires the session log remain intact in this case.
    const git = makeGit({
      stdoutByKey: {
        "/repos/a": {
          [`rev-parse --verify ${refName}^{commit}`]: "aaa\n",
          "status --porcelain": ""
        },
        "/repos/b": {
          [`rev-parse --verify ${refName}^{commit}`]: "bbb\n",
          "status --porcelain": ""
        }
      },
      throwByKey: {
        "/repos/b": { "reset --hard bbb": "fatal: Unable to write new index file" }
      }
    });
    let truncated = false;
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore: {
        truncateBeforeTimestamp: async () => {
          truncated = true;
          return 0;
        },
        clearClaudeSessionIds: async () => null
      },
      gitExec: git.exec
    };

    await expect(
      rewindApply("ch-1", "sess-1", refKey, "2025-01-01T00:00:00.000Z", deps)
    ).rejects.toThrow(/Unable to write/);

    // Truncation must NOT have run.
    expect(truncated).toBe(false);
  });
});

describe("SessionStore.truncateBeforeTimestamp + clearClaudeSessionIds", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sess-rewind-"));
    store = new SessionStore(dir, new NullHarnessStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps messages strictly before the timestamp and drops the rest", async () => {
    const session = await store.createSession("ch", "t");
    const makeMsg = (ts: string, content: string) => ({
      role: "user",
      content,
      timestamp: ts,
      agentAlias: null
    });
    await store.appendMessage("ch", session.sessionId, makeMsg("2025-01-01T00:00:00.000Z", "m1"));
    await store.appendMessage("ch", session.sessionId, makeMsg("2025-01-01T00:00:05.000Z", "m2"));
    await store.appendMessage("ch", session.sessionId, makeMsg("2025-01-01T00:00:10.000Z", "m3"));

    const removed = await store.truncateBeforeTimestamp(
      "ch",
      session.sessionId,
      "2025-01-01T00:00:05.000Z"
    );

    // m2 and m3 both have ts >= cutoff, so two were removed.
    expect(removed).toBe(2);
    const after = await store.loadMessages("ch", session.sessionId);
    expect(after.map((m) => m.content)).toEqual(["m1"]);

    // Index is updated to the new count.
    const updated = await store.getSession("ch", session.sessionId);
    expect(updated!.messageCount).toBe(1);
  });

  it("is idempotent when no messages exist (ENOENT path)", async () => {
    const session = await store.createSession("ch", "t");
    const removed = await store.truncateBeforeTimestamp(
      "ch",
      session.sessionId,
      "2099-01-01T00:00:00.000Z"
    );
    expect(removed).toBe(0);
  });

  it("clearClaudeSessionIds wipes the sid map on the session index", async () => {
    const session = await store.createSession("ch", "t");
    await store.updateClaudeSessionId("ch", session.sessionId, "general", "claude-sid-xyz");

    const cleared = await store.clearClaudeSessionIds("ch", session.sessionId);
    expect(cleared).not.toBeNull();
    expect(cleared!.claudeSessionIds).toEqual({});

    // Round-trips through disk — not just in-memory.
    const reloaded = await store.getSession("ch", session.sessionId);
    expect(reloaded!.claudeSessionIds).toEqual({});
  });

  it("clearClaudeSessionIds returns null for an unknown session", async () => {
    const cleared = await store.clearClaudeSessionIds("ch", "does-not-exist");
    expect(cleared).toBeNull();
  });
});

describe("SessionStore.deleteSession prunes rewind refs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sess-rewind-del-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs `update-ref -d` for each discovered rewind ref per repo", async () => {
    const gitCalls: GitCall[] = [];
    const exec = async (
      args: string[],
      opts: { cwd: string }
    ): Promise<{ stdout: string; stderr: string }> => {
      gitCalls.push({ args: [...args], cwd: opts.cwd });
      if (
        args[0] === "for-each-ref" &&
        args[1] === "--format=%(refname)" &&
        typeof args[2] === "string" &&
        args[2].startsWith("refs/harness-rewind/")
      ) {
        const prefix = args[2];
        // Pretend /repos/a has two refs and /repos/b has one.
        if (opts.cwd === "/repos/a") {
          return { stdout: `${prefix}k1\n${prefix}k2\n`, stderr: "" };
        }
        if (opts.cwd === "/repos/b") {
          return { stdout: `${prefix}k3\n`, stderr: "" };
        }
      }
      return { stdout: "", stderr: "" };
    };

    const store = new SessionStore(dir, new NullHarnessStore(), exec);
    const session = await store.createSession("ch", "t");
    await store.appendMessage("ch", session.sessionId, {
      role: "user",
      content: "hi",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });

    await store.deleteSession("ch", session.sessionId, {
      repoPaths: ["/repos/a", "/repos/b"]
    });

    const deletes = gitCalls.filter(
      (c) => c.args[0] === "update-ref" && c.args[1] === "-d"
    );
    const deleted = deletes.map((c) => `${c.cwd}::${c.args[2]}`).sort();
    expect(deleted).toEqual([
      `/repos/a::refs/harness-rewind/${session.sessionId}/k1`,
      `/repos/a::refs/harness-rewind/${session.sessionId}/k2`,
      `/repos/b::refs/harness-rewind/${session.sessionId}/k3`
    ]);
  });

  it("swallows 'missing ref' errors on individual update-ref failures", async () => {
    const exec = async (
      args: string[],
      opts: { cwd: string }
    ): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: `refs/harness-rewind/s/ref1\nrefs/harness-rewind/s/ref2\n`,
          stderr: ""
        };
      }
      if (
        args[0] === "update-ref" &&
        args[1] === "-d" &&
        args[2] === "refs/harness-rewind/s/ref1"
      ) {
        throw new Error("fatal: no ref at refs/harness-rewind/s/ref1");
      }
      return { stdout: "", stderr: "" };
    };

    const store = new SessionStore(dir, new NullHarnessStore(), exec);
    const session = await store.createSession("ch", "t");
    // Should NOT throw despite the per-ref missing error.
    await expect(
      store.deleteSession("ch", session.sessionId, { repoPaths: ["/repos/a"] })
    ).resolves.toBeUndefined();
  });

  it("warns but does not throw if `for-each-ref` itself fails for a repo", async () => {
    const exec = async (
      args: string[],
      _opts: { cwd: string }
    ): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "for-each-ref") {
        throw new Error("fatal: not a git repository");
      }
      return { stdout: "", stderr: "" };
    };

    const store = new SessionStore(dir, new NullHarnessStore(), exec);
    const session = await store.createSession("ch", "t");

    await expect(
      store.deleteSession("ch", session.sessionId, { repoPaths: ["/nope"] })
    ).resolves.toBeUndefined();

    // Disk cleanup still happened.
    const sessionsAfter = await store.listSessions("ch");
    expect(sessionsAfter.map((s) => s.sessionId)).not.toContain(
      session.sessionId
    );
  });

  it("is a no-op (no git calls) when repoPaths is not supplied", async () => {
    const gitCalls: GitCall[] = [];
    const exec = async (
      args: string[],
      opts: { cwd: string }
    ): Promise<{ stdout: string; stderr: string }> => {
      gitCalls.push({ args: [...args], cwd: opts.cwd });
      return { stdout: "", stderr: "" };
    };
    const store = new SessionStore(dir, new NullHarnessStore(), exec);
    const session = await store.createSession("ch", "t");

    await store.deleteSession("ch", session.sessionId);

    expect(gitCalls).toEqual([]);
  });
});

describe("rewindSnapshot + rewindApply end-to-end with a real SessionStore", () => {
  // Exercises the filesystem-backed truncation path (not just the stub) to
  // confirm rewindApply wires SessionStore correctly.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rewind-e2e-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("truncates the on-disk JSONL to match messageTimestamp", async () => {
    const sessionStore = new SessionStore(dir, new NullHarnessStore());
    const session = await sessionStore.createSession("ch-e2e", "t");
    await sessionStore.appendMessage("ch-e2e", session.sessionId, {
      role: "user",
      content: "before",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });
    await sessionStore.appendMessage("ch-e2e", session.sessionId, {
      role: "user",
      content: "cutoff",
      timestamp: "2025-01-01T00:00:05.000Z",
      agentAlias: null,
      metadata: { rewindKey: "k1" }
    });
    await sessionStore.appendMessage("ch-e2e", session.sessionId, {
      role: "assistant",
      content: "after",
      timestamp: "2025-01-01T00:00:10.000Z",
      agentAlias: null
    });

    const channel = makeChannel(["/fake/repo"]);
    const refName = `refs/harness-rewind/${session.sessionId}/k1`;
    const git = makeGit({
      stdoutByKey: {
        "/fake/repo": {
          [`rev-parse --verify ${refName}^{commit}`]: "deadbeef\n",
          "status --porcelain": ""
        }
      }
    });
    const deps: RewindDeps = {
      channelStore: fakeChannelStore(channel),
      sessionStore,
      gitExec: git.exec
    };

    const result = await rewindApply(
      "ch-e2e",
      session.sessionId,
      "k1",
      "2025-01-01T00:00:05.000Z",
      deps
    );

    expect(result.removedMessages).toBe(2);
    const remaining = await sessionStore.loadMessages(
      "ch-e2e",
      session.sessionId
    );
    expect(remaining.map((m) => m.content)).toEqual(["before"]);

    // JSONL file on disk matches what we expect — sanity check.
    const chatPath = join(dir, "ch-e2e", "sessions", `${session.sessionId}.jsonl`);
    const raw = await readFile(chatPath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);

    // Confirm clearClaudeSessionIds ran.
    expect(result.clearedClaudeSessions).toBe(true);
  });

  it("leaves the JSONL untouched when a reset fails mid-way", async () => {
    const sessionStore = new SessionStore(dir, new NullHarnessStore());
    const session = await sessionStore.createSession("ch-fail", "t");
    await sessionStore.appendMessage("ch-fail", session.sessionId, {
      role: "user",
      content: "m1",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });
    await sessionStore.appendMessage("ch-fail", session.sessionId, {
      role: "user",
      content: "m2",
      timestamp: "2025-01-01T00:00:05.000Z",
      agentAlias: null,
      metadata: { rewindKey: "boom" }
    });

    const chatPath = join(dir, "ch-fail", "sessions", `${session.sessionId}.jsonl`);
    const before = await readFile(chatPath, "utf8");

    const channel = makeChannel(["/repos/a", "/repos/b"]);
    const refName = `refs/harness-rewind/${session.sessionId}/boom`;
    const git = makeGit({
      stdoutByKey: {
        "/repos/a": {
          [`rev-parse --verify ${refName}^{commit}`]: "aaa\n",
          "status --porcelain": ""
        },
        "/repos/b": {
          [`rev-parse --verify ${refName}^{commit}`]: "bbb\n",
          "status --porcelain": ""
        }
      },
      throwByKey: {
        "/repos/b": { "reset --hard bbb": "fatal: broken" }
      }
    });

    await expect(
      rewindApply("ch-fail", session.sessionId, "boom", "2025-01-01T00:00:05.000Z", {
        channelStore: fakeChannelStore(channel),
        sessionStore,
        gitExec: git.exec
      })
    ).rejects.toThrow(/broken/);

    const after = await readFile(chatPath, "utf8");
    expect(after).toBe(before);

    // And the sessions index messageCount should also be unchanged.
    const stillThere = await sessionStore.getSession("ch-fail", session.sessionId);
    expect(stillThere!.messageCount).toBe(2);
  });
});

