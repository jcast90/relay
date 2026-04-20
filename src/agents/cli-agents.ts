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
    // When the user sets RELAY_AUTO_APPROVE=1 (or launched with --auto-approve
    // / --yolo), internal dispatched agents run fully unattended. Otherwise
    // we stay on the default permission mode and users will be prompted.
    const autoApprove =
      process.env.RELAY_AUTO_APPROVE === "1" ||
      process.env.RELAY_AUTO_APPROVE === "true" ||
      process.env.RELAY_AUTO_APPROVE === "yes";

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
    "If this is planning work (kind=draft_plan), include a phasePlan object matching the harness phase-plan schema.",
    "If this is classification work (kind=classify_request), return a classification object with: tier (trivial|bugfix|feature_small|feature_large|architectural|multi_repo), rationale, suggestedSpecialties, estimatedTicketCount, needsDesignDoc, needsUserApproval, crosslinkRepos.",
    "If this is ticket decomposition work (kind=decompose_tickets), return a ticketPlan object with parallelizable tickets and dependsOn edges.",
    "If this is design doc work (kind=generate_design_doc), provide the design document in your summary.",
    "Otherwise, omit phasePlan, classification, and ticketPlan."
  ];

  return lines.join("\n");
}
