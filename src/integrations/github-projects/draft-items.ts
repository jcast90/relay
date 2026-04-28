/**
 * Draft-item CRUD against GitHub Projects v2. Second slice of the v0.2
 * tracker work (PR B / #181). PR A landed the GraphQL transport and the
 * project resolver; this file owns the lifecycle of the draft items
 * that PR C (#182) will use to project channels (Type=epic) and tickets
 * (Type=ticket) into a project.
 *
 * Two id types matter here. Every mutation that operates on a row in
 * the project board takes the **project-item id** (`PVTI_…`). The
 * underlying draft-issue text — title and body — is owned by a sibling
 * **draft-issue id** (`DI_…`) and updated through a separate mutation.
 * `addProjectV2DraftIssue` hands us both at creation time so callers
 * never need to query for the draft id later.
 */
import { githubProjectsGraphql, type ProjectsClientDeps } from "./client.js";

export interface CreateDraftItemInput {
  projectId: string;
  title: string;
  body?: string;
}

export interface DraftItemRef {
  /** Project-item id (PVTI_…) — used for field updates and archival. */
  itemId: string;
  /** Draft-issue id (DI_…) — used for title/body edits. */
  draftIssueId: string;
}

/**
 * Create a draft item on a project. Returns both the project-item id
 * and the underlying draft-issue id; callers should persist whichever
 * matches the operation they expect to perform next (field updates →
 * itemId; text edits → draftIssueId).
 */
export async function createDraftItem(
  input: CreateDraftItemInput,
  deps: ProjectsClientDeps
): Promise<DraftItemRef> {
  const data = await githubProjectsGraphql<{
    addProjectV2DraftIssue: {
      projectItem: {
        id: string;
        content: { id: string } | null;
      };
    };
  }>(
    `mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
        projectItem {
          id
          content { ... on DraftIssue { id } }
        }
      }
    }`,
    { projectId: input.projectId, title: input.title, body: input.body ?? null },
    deps
  );
  const projectItem = data.addProjectV2DraftIssue.projectItem;
  if (!projectItem.content) {
    throw new Error("addProjectV2DraftIssue returned a project item with no draft-issue content");
  }
  return { itemId: projectItem.id, draftIssueId: projectItem.content.id };
}

export interface UpdateDraftIssueInput {
  draftIssueId: string;
  title?: string;
  body?: string;
}

/**
 * Update a draft issue's title and/or body. Either field is optional;
 * GraphQL leaves omitted variables as null and the mutation is a no-op
 * for those. We assert that at least one field is set so callers don't
 * accidentally make pointless network calls.
 */
export async function updateDraftIssue(
  input: UpdateDraftIssueInput,
  deps: ProjectsClientDeps
): Promise<{ draftIssueId: string }> {
  if (input.title === undefined && input.body === undefined) {
    throw new Error("updateDraftIssue requires at least one of { title, body }");
  }
  const data = await githubProjectsGraphql<{
    updateProjectV2DraftIssue: { draftIssue: { id: string } };
  }>(
    `mutation($draftIssueId: ID!, $title: String, $body: String) {
      updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
        draftIssue { id }
      }
    }`,
    {
      draftIssueId: input.draftIssueId,
      title: input.title ?? null,
      body: input.body ?? null,
    },
    deps
  );
  return { draftIssueId: data.updateProjectV2DraftIssue.draftIssue.id };
}

export interface SetSingleSelectValueInput {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}

/**
 * Set the value of a single-select custom field on a project item.
 * This is the workhorse for moving tickets across Status columns and
 * stamping Type=epic / Type=ticket on draft items. PR C calls this from
 * the channel-create hook (Type=epic) and the sync worker in PR D will
 * call it on every status transition.
 */
export async function setSingleSelectValue(
  input: SetSingleSelectValueInput,
  deps: ProjectsClientDeps
): Promise<{ itemId: string }> {
  const data = await githubProjectsGraphql<{
    updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
  }>(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { ...input },
    deps
  );
  return { itemId: data.updateProjectV2ItemFieldValue.projectV2Item.id };
}

export interface ArchiveItemInput {
  projectId: string;
  itemId: string;
}

/**
 * Archive a project item. GitHub's UI calls this "Archive"; the
 * underlying mutation `archiveProjectV2Item` keeps the item in the
 * project but hides it from the default board views — exactly what we
 * want when a channel is archived. Idempotent: calling on an
 * already-archived item is a no-op.
 */
export async function archiveItem(
  input: ArchiveItemInput,
  deps: ProjectsClientDeps
): Promise<{ itemId: string }> {
  const data = await githubProjectsGraphql<{
    archiveProjectV2Item: { item: { id: string } };
  }>(
    `mutation($projectId: ID!, $itemId: ID!) {
      archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
        item { id }
      }
    }`,
    { ...input },
    deps
  );
  return { itemId: data.archiveProjectV2Item.item.id };
}
