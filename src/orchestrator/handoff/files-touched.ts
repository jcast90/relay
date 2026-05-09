import { spawn } from "node:child_process";

/**
 * v1 implementation of files-touched-per-ticket enrichment for handoff
 * briefs. Shells out via `git log --name-only` per repo, scans for
 * commits whose subject contains the ticketId substring, and returns
 * the unique file paths from those commits (newest-first preserved by
 * git's reverse-chrono ordering).
 *
 * Per D-02: this is "v1, revisit if briefs feel thin" (RESEARCH Q6/A4).
 * NO schema change in Phase 2; a future phase can add first-class file
 * tracking driven by hooks.
 *
 * NOTE (M3): this is the ONE declared side effect of the otherwise
 * pure-over-declared-inputs `buildBrief`. Two back-to-back calls
 * separated by a `git pull` (or any new commit) can produce different
 * file lists. Tests opt out via `gitLogEnabled: false`, in which case
 * the synthesizer skips this module entirely.
 *
 * Robustness: returns `[]` (never throws) on missing-git (`ENOENT`),
 * non-zero exit, cwd-not-a-git-repo, or any spawn error. Cap result at
 * 30 files per ticket to keep the brief bounded.
 */
export async function getFilesTouchedByTicket(
  channelId: string,
  ticketId: string,
  repoCwds: string[],
  opts: { enabled?: boolean } = {}
): Promise<string[]> {
  // Caller-controlled disable for strict bit-identicality tests (M3).
  if (opts.enabled === false) return [];
  if (repoCwds.length === 0) return [];

  const collected = new Set<string>();
  for (const cwd of repoCwds) {
    const filesForRepo = await runGitLogForTicket(cwd, ticketId);
    for (const f of filesForRepo) {
      if (collected.size >= 30) break;
      collected.add(f);
    }
    if (collected.size >= 30) break;
  }

  // Discard the channelId param from cache-key shaping; it's part of the
  // signature for future per-channel scoping (e.g. only scan repos
  // assigned to this channel). For now we honor `repoCwds` as-given.
  void channelId;

  return Array.from(collected);
}

/**
 * Run `git log --name-only -n 200 --pretty=format:%H%n%s` against `cwd`,
 * parse the commit blocks, and return file paths from blocks whose
 * subject mentions `ticketId`. Best-effort; never throws.
 */
async function runGitLogForTicket(cwd: string, ticketId: string): Promise<string[]> {
  let stdout: string;
  try {
    stdout = await runProcess("git", [
      "-C",
      cwd,
      "log",
      "--name-only",
      "--pretty=format:%H%n%s",
      "-n",
      "200",
    ]);
  } catch {
    return [];
  }

  // Commit block format (after the empty-line separator git inserts):
  //   <40-char SHA>
  //   <subject line>
  //   path/one
  //   path/two
  //   <blank>
  // We do a streaming parse: each block starts at a 40-char hex sha line.
  const lines = stdout.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const sha = lines[i];
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      i += 1;
      continue;
    }
    const subject = lines[i + 1] ?? "";
    const matches = subject.includes(ticketId);
    let j = i + 2;
    while (j < lines.length && lines[j] !== "" && !/^[0-9a-f]{40}$/.test(lines[j])) {
      if (matches) out.push(lines[j]);
      j += 1;
    }
    i = j;
  }
  return out;
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited ${code}: ${stderr}`));
    });
  });
}
