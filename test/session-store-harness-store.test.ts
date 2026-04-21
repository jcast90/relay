import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../src/cli/session-store.js";
import { FileHarnessStore } from "../src/storage/file-store.js";
import { STORE_NS } from "../src/storage/namespaces.js";
import type {
  BlobRef,
  ChangeEvent,
  HarnessStore,
  ReadLogOptions
} from "../src/storage/store.js";

class FakeHarnessStore implements HarnessStore {
  readonly docs: Map<string, unknown> = new Map();
  readonly mutateCalls: Array<{ ns: string; id: string }> = [];
  readonly deleteCalls: Array<{ ns: string; id: string }> = [];

  private key(ns: string, id: string): string {
    return `${ns}\u0000${id}`;
  }

  async getDoc<T>(ns: string, id: string): Promise<T | null> {
    const v = this.docs.get(this.key(ns, id));
    return (v as T | undefined) ?? null;
  }

  async putDoc<T>(ns: string, id: string, doc: T): Promise<void> {
    this.docs.set(this.key(ns, id), doc);
  }

  async listDocs<T>(): Promise<T[]> {
    throw new Error("FakeHarnessStore.listDocs is not implemented");
  }

  async deleteDoc(ns: string, id: string): Promise<void> {
    this.deleteCalls.push({ ns, id });
    this.docs.delete(this.key(ns, id));
  }

  async appendLog(): Promise<void> {
    throw new Error("FakeHarnessStore.appendLog is not implemented");
  }

  async readLog<T>(
    _ns: string,
    _id: string,
    _opts?: ReadLogOptions
  ): Promise<T[]> {
    throw new Error("FakeHarnessStore.readLog is not implemented");
  }

  async putBlob(): Promise<BlobRef> {
    throw new Error("FakeHarnessStore.putBlob is not implemented");
  }

  async getBlob(): Promise<Uint8Array> {
    throw new Error("FakeHarnessStore.getBlob is not implemented");
  }

  async mutate<T>(
    ns: string,
    id: string,
    fn: (prev: T | null) => T
  ): Promise<T> {
    this.mutateCalls.push({ ns, id });
    const prev = (this.docs.get(this.key(ns, id)) as T | undefined) ?? null;
    const next = fn(prev);
    this.docs.set(this.key(ns, id), next);
    return next;
  }

  // eslint-disable-next-line require-yield
  async *watch(): AsyncIterable<ChangeEvent> {
    throw new Error("FakeHarnessStore.watch is not implemented");
  }
}

describe("SessionStore with HarnessStore injection", () => {
  let channelsDir: string;
  let fake: FakeHarnessStore;
  let store: SessionStore;

  beforeEach(async () => {
    channelsDir = await mkdtemp(join(tmpdir(), "sess-hs-"));
    fake = new FakeHarnessStore();
    store = new SessionStore(channelsDir, fake);
  });

  afterEach(async () => {
    await rm(channelsDir, { recursive: true, force: true });
  });

  it("routes session creation through HarnessStore.mutate", async () => {
    const session = await store.createSession("channel-1", "New session");

    const expectedId = `channel-1:${session.sessionId}`;
    expect(fake.mutateCalls).toContainEqual({
      ns: STORE_NS.session,
      id: expectedId
    });

    const rec = await fake.getDoc<{ updatedAt: string; messageCount: number }>(
      STORE_NS.session,
      expectedId
    );
    expect(rec).not.toBeNull();
    expect(rec!.messageCount).toBe(0);
    expect(typeof rec!.updatedAt).toBe("string");
  });

  it("bumps the coordination record on appendMessage", async () => {
    const session = await store.createSession("channel-2", "Test");
    const coordId = `channel-2:${session.sessionId}`;

    await store.appendMessage("channel-2", session.sessionId, {
      role: "user",
      content: "hi",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });

    const rec = await fake.getDoc<{ updatedAt: string; messageCount: number }>(
      STORE_NS.session,
      coordId
    );
    expect(rec).not.toBeNull();
    expect(rec!.messageCount).toBe(1);

    // Sanity: at least two mutate calls (create + append → updateSession).
    const calls = fake.mutateCalls.filter(
      (c) => c.ns === STORE_NS.session && c.id === coordId
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the Rust-compat sessions.json + JSONL layout on disk", async () => {
    const session = await store.createSession("channel-rust", "Rust compat");

    await store.appendMessage("channel-rust", session.sessionId, {
      role: "user",
      content: "rust?",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });

    // Sessions index where Rust's `sessions_index_path` expects it.
    const indexPath = join(channelsDir, "channel-rust", "sessions.json");
    const raw = JSON.parse(await readFile(indexPath, "utf8")) as Array<{
      sessionId: string;
      messageCount: number;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].sessionId).toBe(session.sessionId);
    expect(raw[0].messageCount).toBe(1);

    // Chat JSONL where Rust's `session_chat_path` expects it.
    const chatPath = join(
      channelsDir,
      "channel-rust",
      "sessions",
      `${session.sessionId}.jsonl`
    );
    await expect(stat(chatPath)).resolves.toBeTruthy();
    const lines = (await readFile(chatPath, "utf8"))
      .trimEnd()
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("deleteSession removes the coordination record", async () => {
    const session = await store.createSession("channel-3", "To delete");
    const coordId = `channel-3:${session.sessionId}`;

    await store.deleteSession("channel-3", session.sessionId);

    expect(fake.deleteCalls).toContainEqual({
      ns: STORE_NS.session,
      id: coordId
    });

    const rec = await fake.getDoc(STORE_NS.session, coordId);
    expect(rec).toBeNull();
  });

  it("defaults to a real FileHarnessStore when no store is injected", async () => {
    const defaulted = new SessionStore(channelsDir);
    const sessions = await defaulted.listSessions("channel-empty");
    expect(sessions).toEqual([]);
  });

  it("throws on a corrupt sessions.json instead of returning empty", async () => {
    // Silently returning [] on parse failure would let the next write
    // overwrite the damaged file, erasing any recoverable data.
    const channelDir = join(channelsDir, "corrupt-channel");
    await mkdir(channelDir, { recursive: true });
    const indexPath = join(channelDir, "sessions.json");
    await writeFile(indexPath, "this is not JSON", "utf8");

    await expect(store.listSessions("corrupt-channel")).rejects.toThrow(
      /Corrupt sessions index/
    );
    await expect(store.listSessions("corrupt-channel")).rejects.toThrow(
      indexPath
    );
  });

  it("swallows coordination-record mutate failures + logs (disk write still commits)", async () => {
    // The on-disk sessions.json + JSONL chat are authoritative (Rust reader +
    // GUI consume them). The HarnessStore coordination record is advisory —
    // a mutate failure must not surface as a failed createSession, and the
    // on-disk session index must still be committed.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mutateSpy = vi
      .spyOn(fake, "mutate")
      .mockRejectedValueOnce(new Error("coordination store exploded"));

    try {
      const session = await store.createSession(
        "mutate-fails-channel",
        "disk still commits"
      );
      expect(session.sessionId).toBeTruthy();

      // Disk write committed — sessions.json has the entry.
      const indexPath = join(
        channelsDir,
        "mutate-fails-channel",
        "sessions.json"
      );
      const raw = JSON.parse(await readFile(indexPath, "utf8")) as Array<{
        sessionId: string;
      }>;
      expect(raw.map((s) => s.sessionId)).toContain(session.sessionId);

      // Operator-visible diagnostic was emitted.
      const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(
        warnings.some((w) => w.includes("coordination-record mutate failed"))
      ).toBe(true);
      expect(
        warnings.some((w) => w.includes("coordination store exploded"))
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      mutateSpy.mockRestore();
    }
  });

  it("warns with path + line number on a malformed JSONL line instead of silently skipping", async () => {
    const session = await store.createSession("jsonl-warn", "with garbage");
    await store.appendMessage("jsonl-warn", session.sessionId, {
      role: "user",
      content: "valid",
      timestamp: "2025-01-01T00:00:00.000Z",
      agentAlias: null
    });

    // Manually append a garbage line to simulate data corruption /
    // manual edit damage.
    const chatPath = join(
      channelsDir,
      "jsonl-warn",
      "sessions",
      `${session.sessionId}.jsonl`
    );
    await writeFile(
      chatPath,
      (await readFile(chatPath, "utf8")) + "this is not JSON\n",
      "utf8"
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const messages = await store.loadMessages("jsonl-warn", session.sessionId);
      // The valid line still comes back; the garbage one is dropped but
      // operator was told about it.
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("valid");

      const warnings = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(
        warnings.some((w) => w.includes("skipping malformed JSONL line"))
      ).toBe(true);
      expect(warnings.some((w) => w.includes(chatPath))).toBe(true);
      // Line number should be present — 2 (second line is garbage).
      expect(warnings.some((w) => /:2:/.test(w))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SessionStore reads legacy Rust-layout fixtures", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sess-legacy-"));
    const fixtureSrc = fileURLToPath(
      new URL("./fixtures/legacy-session", import.meta.url)
    );
    await cp(fixtureSrc, workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads a pre-migration sessions index and JSONL chat", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "sess-legacy-store-"));
    try {
      const store = new SessionStore(workDir, new FileHarnessStore(storeRoot));

      const sessions = await store.listSessions("channel-abc");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("sess-legacy-1");
      expect(sessions[0].messageCount).toBe(2);

      const messages = await store.loadMessages("channel-abc", "sess-legacy-1");
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
      expect(messages[1].role).toBe("assistant");

      // Legacy-read path must not have written coordination state.
      await expect(
        stat(join(storeRoot, "session"))
      ).rejects.toThrow();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
