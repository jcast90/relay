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

abstract class CliAgentBase implements Agent {
  readonly id: string;
  readonly name: string;
  readonly provider: AgentProvider;
  readonly capability: AgentCapability;
  protected readonly cwd: string;
  protected readonly model?: string;
  protected readonly invoker: CommandInvoker;

  constructor(options: CliAgentOptions) {
    this.id = options.id;
    this.name = options.name;
    this.provider = options.provider;
    this.capability = options.capability;
    this.cwd = options.cwd;
    this.model = options.model;
    this.invoker = options.invoker;
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

    try {
      const args = [
        "exec",
        "-C",
        this.cwd,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath
      ];

      if (this.model) {
        args.push("--model", this.model);
      }

      args.push(prompt);

      const result = await this.invoker.exec({
        command: "codex",
        args,
        cwd: this.cwd,
        timeoutMs: 300_000
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
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(agentResultJsonSchema),
      "--permission-mode",
      "default"
    ];

    if (this.model) {
      args.push("--model", this.model);
    }

    args.push(prompt);

    const result = await this.invoker.exec({
      command: "claude",
      args,
      cwd: this.cwd,
      timeoutMs: 300_000
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Claude execution failed.");
    }

    return {
      rawResponse: result.stdout,
      parsed: this.normalizePayload(JSON.parse(result.stdout))
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
    "If this is planning work, include a phasePlan object matching the harness phase-plan schema.",
    "If this is not planning work, omit phasePlan."
  ];

  return lines.join("\n");
}
