/**
 * Channel ↔ Epic lifecycle orchestration. Third slice of the v0.2
 * tracker work (PR C / #182). Composes the lower-level primitives from
 * `client.ts`, `fields.ts`, and `draft-items.ts` into three high-level
 * operations that match the Channel lifecycle: provision, rename,
 * archive.
 *
 * This module is **pure orchestration** — it neither reads from nor
 * writes to `~/.relay/`. Callers (the eventual MCP tool handlers) are
 * responsible for persisting the returned `ChannelGitHubProjectsLink`
 * onto the channel via `ChannelStore.updateChannel`. Keeping the
 * persistence concern at the call site means tests can exercise the
 * orchestration without standing up a full channel store, and the
 * tracker integration can be opted in/out per call site without
 * threading new flags through `channel-store.ts`.
 *
 * The MCP-handler wiring (channel_create / channel_update /
 * channel_archive) is deliberately deferred to a follow-up PR. PR C
 * ships the orchestration + types; the wiring lands behind `tracker`
 * config (PR G, #186) so it can be feature-flagged without churning
 * this module.
 */
import type { ChannelGitHubProjectsLink } from "../../domain/channel.js";
import {
  archiveItem,
  createDraftItem,
  ensureCustomFields,
  listProjectFields,
  resolveProject,
  setSingleSelectValue,
  updateDraftIssue,
  type ProjectOwnerRef,
  type ProjectsClientDeps,
} from "./client.js";

export interface ProvisionEpicInput {
  /** Display name for the channel — becomes the epic draft-issue title. */
  channelName: string;
  /** Channel description — becomes the epic draft-issue body. Optional. */
  channelDescription?: string;
  /** Owner login + type that hosts the project. */
  ownerRef: ProjectOwnerRef;
  /**
   * Project title to find or create. Per the design doc the convention
   * is the channel's primary repo alias (so a channel rooted at
   * `relay-core-ui` lives in a Project titled "relay-core-ui").
   * Callers compute this — keeping the rule out of this module lets PR
   * G's config block override it without code changes here.
   */
  projectTitle: string;
}

/**
 * Provision a GitHub Projects v2 epic for a channel. Idempotent on the
 * project-resolution and field-bootstrap legs (both `resolveProject`
 * and `ensureCustomFields` are designed to be safe on re-run); the
 * draft-item creation is **not** idempotent and will produce a
 * duplicate epic if called twice. Callers must check
 * `channel.trackerLinks?.githubProjects` before invoking and skip if
 * an epic already exists.
 *
 * Sequence:
 *   1. resolveProject(ownerRef, projectTitle) — find or create
 *   2. ensureCustomFields(projectId, ["Status", "Type", "Priority"]) — bootstrap
 *   3. createDraftItem({ projectId, title: channelName, body: channelDescription })
 *   4. setSingleSelectValue(Type=epic) on the new item
 *
 * Step 4 is best-effort: if the Type field can't be located or the
 * `epic` option doesn't exist (because the user manually customized the
 * field), provisioning still succeeds and the epic is left untyped.
 * The sync worker (PR D, #183) will surface a warning then. We don't
 * abort here because the most useful state is "epic exists" — a missing
 * Type tag is recoverable by hand.
 */
export async function provisionEpicForChannel(
  input: ProvisionEpicInput,
  deps: ProjectsClientDeps
): Promise<ChannelGitHubProjectsLink> {
  const project = await resolveProject(input.ownerRef, input.projectTitle, deps);
  await ensureCustomFields(project.id, ["Status", "Type", "Priority"], deps);

  const epic = await createDraftItem(
    {
      projectId: project.id,
      title: input.channelName,
      body: input.channelDescription,
    },
    deps
  );

  // Best-effort Type=epic stamp. See the JSDoc above for the rationale.
  const fields = await listProjectFields(project.id, deps);
  const typeField = fields.find((f) => f.name === "Type");
  const epicOption = typeField?.options?.find((o) => o.name === "epic");
  if (typeField && epicOption) {
    await setSingleSelectValue(
      {
        projectId: project.id,
        itemId: epic.itemId,
        fieldId: typeField.id,
        optionId: epicOption.id,
      },
      deps
    );
  }

  return {
    projectId: project.id,
    projectNumber: project.number,
    projectUrl: project.url,
    epicItemId: epic.itemId,
    epicDraftIssueId: epic.draftIssueId,
  };
}

/**
 * Rename the epic draft issue for a channel. Called from the
 * channel_update hook when `name` changes. Pure pass-through to
 * `updateDraftIssue` — kept as its own function so the call site reads
 * intent ("rename the epic") rather than mechanism ("edit a draft
 * issue"), and so the Linear parity work in PR F can pattern-match the
 * same shape.
 */
export async function renameEpicForChannel(
  link: ChannelGitHubProjectsLink,
  newName: string,
  deps: ProjectsClientDeps
): Promise<void> {
  await updateDraftIssue({ draftIssueId: link.epicDraftIssueId, title: newName }, deps);
}

/**
 * Archive the epic for a channel. Called from the channel_archive
 * hook. Idempotent: archiving an already-archived item is a no-op on
 * GitHub's side. The project itself is intentionally left alone — it
 * may host other channels' epics under a future "shared project" model
 * even though today every channel maps to its own project.
 */
export async function archiveEpicForChannel(
  link: ChannelGitHubProjectsLink,
  deps: ProjectsClientDeps
): Promise<void> {
  await archiveItem({ projectId: link.projectId, itemId: link.epicItemId }, deps);
}
