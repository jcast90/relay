import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentResultSchema,
  agentResultJsonSchema,
  type Agent,
  type AgentCapability,
  type FailureClassification,
  type AgentProvider,
  type WorkRequest
} from "../domain/agent.js";
import { parsePhasePlan, type PhasePlan } from "../domain/phase-plan.js";
import type { CommandInvoker } from "./command-invoker.js";

interface CliAgentOptions {
  id: string;
  name: string;
  provider: AgentProvider;
  capability: AgentCapability;
  cwd: string;
  model?: string;
  invoker: CommandInvoker;
  /**
   * Optional streaming observer — when supplied (and the invoker exposes
   * `spawn`), the Claude adapter switches from buffered `--output-format
   * json` to `stream-json --verbose` and feeds every stdout line to this
   * callback so the CLI can render tool-use activity inline as it happens.
   * The TUI and GUI have their own streaming paths; this is how `rly run`
   * achieves the same parity. (OSS-06)
   */
  onStreamLine?: (line: string) => void;
}

interface ParsedProviderResult {
  rawResponse: string;
  parsed: {
    summary: string;
    evidence: string[];
    proposedCommands: string[];
    blockers: string[];
    failureClassification?: FailureClassification;
    phasePlan?: PhasePlan;
  };
}

/**
 * Env vars the Claude CLI subprocess is allowed to read from the parent
 * process. The invoker strips everything outside the default whitelist
 * (OSS-03 — `command-invoker.ts`), so auth-adjacent vars the `claude` binary
 * actually uses need to be opted back in explicitly.
 *
 *  - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`: direct-API auth fallback
 *    when the user hasn't run `claude setup-token`.
 *  - `CLAUDE_CONFIG_DIR` / `CLAUDE_HOME`: user's stored auth config dir.
 *  - `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`: switch the CLI
 *    onto Bedrock / Vertex auth flows.
 *  - AWS / GCP creds: needed when the Bedrock / Vertex flag above is on.
 */
const CLAUDE_PASS_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_HOME",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_PROJECT",
  // Canonical Vertex project vars — `GOOGLE_CLOUD_PROJECT` is what gcloud
  // and the Google Cloud SDKs actually read; `GCLOUD_PROJECT` above is the
  // legacy alias. Keep both so users on either convention work.
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUDSDK_CORE_PROJECT"
];

/**
 * Env vars the Codex CLI subprocess is allowed to read. Same rationale as
 * {@link CLAUDE_PASS_ENV}: the invoker strips by default and Codex reads
 * `OPENAI_API_KEY` (and occasionally `AZURE_OPENAI_*`) for direct-API auth
 * when the user hasn't logged in via `codex login`.
 */
const CODEX_PASS_ENV: readonly string[] = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  // Azure OpenAI routing — both naming conventions seen in the wild.
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
  "CODEX_HOME"
];

abstract class CliAgentBase implements Agent {
  readonly id: string;
  readonly name: string;
  readonly provider: AgentProvider;
  readonly capability: AgentCapability;
  protected readonly cwd: string;
  protected readonly model?: string;
  protected readonly invoker: CommandInvoker;
  protected readonly onStreamLine?: (line: string) => void;

  constructor(options: CliAgentOptions) {
    this.id = options.id;
    this.name = options.name;
    this.provider = options.provider;
    this.capability = options.capability;
    this.cwd = options.cwd;
    this.model = options.model;
    this.invoker = options.invoker;
    this.onStreamLine = options.onStreamLine;
  }

  async run(request: WorkRequest) {
    const response = await this.invokeProvider(buildPrompt(this.name, request));

    return {
      ...response.parsed,
      rawResponse: response.rawResponse
    };
  }

  protected normalizePayload(payload: unknown): ParsedProviderResult["parsed"] {
    const baseResult = AgentResultSchema.parse(payload);

    return {
      summary: baseResult.summary,
      evidence: baseResult.evidence,
      proposedCommands: baseResult.proposedCommands,
      blockers: baseResult.blockers,
      failureClassification: baseResult.failureClassification,
      phasePlan: baseResult.phasePlan
        ? parsePhasePlan(baseResult.phasePlan)
        : undefined
    };
  }

  protected abstract invokeProvider(prompt: string): Promise<ParsedProviderResult>;
}

export class CodexCliAgent extends CliAgentBase {
  protected async invokeProvider(prompt: string): Promise<ParsedProviderResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-harness-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "response.json");

    await writeFile(schemaPath, JSON.stringify(agentResultJsonSchema, null, 2));

    // When RELAY_AUTO_APPROVE is set, drop the read-only sandbox so the
    // dispatched codex agent can actually make changes unattended. Stays
    // read-only by default so nothing surprising happens on a casual run.
    const autoApprove =
      process.env.RELAY_AUTO_APPROVE === "1" ||
      process.env.RELAY_AUTO_APPROVE === "true" ||
      process.env.RELAY_AUTO_APPROVE === "yes";

    try {
      const args = [
        "exec",
        "-C",
        this.cwd,
        "--skip-git-repo-check",
        "--sandbox",
        autoApprove ? "workspace-write" : "read-only",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath
      ];

      if (autoApprove) {
        args.push("--ask-for-approval", "never");
      }

      if (this.model) {
        args.push("--model", this.model);
      }

      args.push(prompt);

      const result = await this.invoker.exec({
        command: "codex",
        args,
        cwd: this.cwd,
        timeoutMs: 300_000,
        // Codex authenticates via its own config or API key env vars. The
        // invoker strips secrets by default (OSS-03); opt these back in so
        // users who rely on env-based auth aren't silently broken.
        passEnv: [...CODEX_PASS_ENV]
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "Codex execution failed.");
      }

      const rawResponse = await readFile(outputPath, "utf8");

      return {
        rawResponse,
        parsed: this.normalizePayload(JSON.parse(rawResponse))
      };
    } finally {
      await rm(tempDir, {
        recursive: true,
        force: true
      });
    }
  }
}

export class ClaudeCliAgent extends CliAgentBase {
  protected async invokeProvider(prompt: string): Promise<ParsedProviderResult> {
    // When the user sets RELAY_AUTO_APPROVE=1 (or launched with --auto-approve
    // / --yolo), internal dispatched agents run fully unattended. Otherwise
    // we stay on the default permission mode and users will be prompted.
    const autoApprove =
      process.env.RELAY_AUTO_APPROVE === "1" ||
      process.env.RELAY_AUTO_APPROVE === "true" ||
      process.env.RELAY_AUTO_APPROVE === "yes";

    // Streaming path: only reachable when the caller wired an onStreamLine
    // hook AND the invoker exposes `spawn`. ScriptedInvoker doesn't
    // implement spawn; live test runs that want streaming must use
    // NodeCommandInvoker. We fall back to the buffered path otherwise so
    // no call site breaks just because streaming wasn't configured.
    if (this.onStreamLine && typeof this.invoker.spawn === "function") {
      return this.invokeStreaming(prompt, autoApprove);
    }

    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(agentResultJsonSchema)
    ];

    if (autoApprove) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "default");
    }

    if (this.model) {
      args.push("--model", this.model);
    }

    args.push(prompt);

    const result = await this.invoker.exec({
      command: "claude",
      args,
      cwd: this.cwd,
      timeoutMs: 300_000,
      // Claude CLI authenticates via its own config dir or API key env vars.
      // The invoker strips secrets by default (OSS-03); opt these back in so
      // users who rely on env-based auth aren't silently broken.
      passEnv: [...CLAUDE_PASS_ENV]
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Claude execution failed.");
    }

    return {
      rawResponse: result.stdout,
      parsed: this.normalizePayload(JSON.parse(result.stdout))
    };
  }

  /**
   * Stream-json variant of the Claude call. Drives the onStreamLine hook on
   * every newline so CLI renderers can visualise tool_use blocks live. The
   * final agent-result JSON (schema-shaped) is reassembled from the
   * concatenated text blocks emitted before the stream closes — this mirrors
   * the TUI worker's logic in tui/src/main.rs.
   */
  private async invokeStreaming(
    prompt: string,
    autoApprove: boolean
  ): Promise<ParsedProviderResult> {
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(agentResultJsonSchema)
    ];
    if (autoApprove) args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "default");
    if (this.model) args.push("--model", this.model);
    args.push(prompt);

    const spawnFn = this.invoker.spawn!;
    const handle = spawnFn({
      command: "claude",
      args,
      cwd: this.cwd,
      timeoutMs: 300_000
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let accumText = "";
    let resultText: string | null = null;
    const onLine = this.onStreamLine!;

    const processLine = (line: string) => {
      if (!line) return;
      onLine(line);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const obj = parsed as Record<string, unknown>;
      if (obj.type === "assistant") {
        const msg = obj.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(msg?.content) ? msg?.content : null;
        if (!blocks) return;
        for (const block of blocks) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              accumText += b.text;
            }
          }
        }
      } else if (obj.type === "result" && typeof obj.result === "string") {
        resultText = obj.result;
      }
    };

    handle.onStdout((chunk) => {
      stdoutBuf += chunk;
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (line) processLine(line);
      }
    });
    handle.onStderr((chunk) => {
      stderrBuf += chunk;
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      handle.onError((err) => reject(err));
      handle.onExit((code) => resolve(code ?? 1));
    });
    const tail = stdoutBuf.trim();
    if (tail) processLine(tail);

    if (exitCode !== 0) {
      throw new Error(stderrBuf || stdoutBuf || "Claude execution failed.");
    }

    const raw = resultText ?? accumText;
    if (!raw) {
      throw new Error("Claude stream produced no parseable JSON body.");
    }
    return {
      rawResponse: raw,
      parsed: this.normalizePayload(JSON.parse(raw))
    };
  }
}

function buildPrompt(agentName: string, request: WorkRequest): string {
  const lines = [
    `You are ${agentName}.`,
    "Work inside a deterministic coding harness.",
    "Return JSON only.",
    "The harness owns state transitions, approvals, and command execution.",
    "Do not claim commands were executed unless they are proposed for the harness to run.",
    "",
    `Run ID: ${request.runId}`,
    `Phase ID: ${request.phaseId}`,
    `Work kind: ${request.kind}`,
    `Specialty: ${request.specialty}`,
    `Attempt: ${request.attempt} of ${request.maxAttempts}`,
    `Title: ${request.title}`,
    `Objective: ${request.objective}`,
    "",
    "Acceptance criteria:",
    ...request.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Allowed commands:",
    ...(request.allowedCommands.length > 0
      ? request.allowedCommands.map((command) => `- ${command}`)
      : ["- None explicitly allowlisted yet."]),
    "",
    "Verification commands:",
    ...(request.verificationCommands.length > 0
      ? request.verificationCommands.map((command) => `- ${command}`)
      : ["- None specified."]),
    "",
    "Docs to update:",
    ...(request.docsToUpdate.length > 0
      ? request.docsToUpdate.map((doc) => `- ${doc}`)
      : ["- None specified."]),
    "",
    "Context:",
    ...request.context.map((item) => `- ${item}`),
    "",
    "Artifact context:",
    ...(request.artifactContext.length > 0
      ? request.artifactContext
      : ["- No artifact contents yet."]),
    "",
    "Prior evidence:",
    ...(request.priorEvidence.length > 0
      ? request.priorEvidence.map((item) => `- ${item}`)
      : ["- None yet."]),
    "",
    "If this is planning work (kind=draft_plan), include a phasePlan object matching the harness phase-plan schema.",
    "If this is classification work (kind=classify_request), return a classification object with: tier (trivial|bugfix|feature_small|feature_large|architectural|multi_repo), rationale, suggestedSpecialties, estimatedTicketCount, needsDesignDoc, needsUserApproval, crosslinkRepos.",
    "If this is ticket decomposition work (kind=decompose_tickets), return a ticketPlan object with parallelizable tickets and dependsOn edges.",
    "If this is design doc work (kind=generate_design_doc), provide the design document in your summary.",
    "Otherwise, omit phasePlan, classification, and ticketPlan."
  ];

  return lines.join("\n");
}
