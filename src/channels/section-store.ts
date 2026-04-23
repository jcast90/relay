/**
 * SectionStore — sidebar grouping for channels.
 *
 * Persistence model: a single `~/.relay/sections.json` file holding an
 * array of `Section` records. Chose a single-file bag over one-file-
 * per-section because (a) ordering is a first-class concern we don't
 * want to scatter across filenames, and (b) the list is small enough
 * (tens of entries, realistically) that one read per sidebar open is
 * cheap and atomic writes are trivial with a temp + rename.
 *
 * Lifecycle operations:
 *  - `create` appends to the list and assigns `order = max + 1`.
 *  - `rename` patches the name field; idempotent.
 *  - `decommission` soft-deletes: flips status to "decommissioned" and
 *    reassigns every active channel pointing at this section to
 *    "Uncategorized" (sectionId cleared). Reversible via `restore`.
 *  - `delete` hard-deletes the entry outright but only if no active
 *    channel still references the id — callers must decommission +
 *    wait-for-no-refs first, or route stragglers themselves.
 *  - `assign` moves a channel between sections.
 *
 * This module only owns the on-disk representation. CLI + GUI layers
 * call into it to service user actions.
 */

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getRelayDir } from "../cli/paths.js";
import { ChannelStore } from "./channel-store.js";
import type { Section } from "../domain/channel.js";

export class SectionStore {
  private readonly path: string;
  private readonly channelStore: ChannelStore;

  constructor(sectionsPath?: string, channelStore?: ChannelStore) {
    this.path = sectionsPath ?? join(getRelayDir(), "sections.json");
    this.channelStore = channelStore ?? new ChannelStore();
  }

  async list(includeDecommissioned = false): Promise<Section[]> {
    const all = await this.readAll();
    const filtered = includeDecommissioned ? all : all.filter((s) => s.status === "active");
    return filtered.slice().sort((a, b) => a.order - b.order);
  }

  async get(sectionId: string): Promise<Section | null> {
    const all = await this.readAll();
    return all.find((s) => s.sectionId === sectionId) ?? null;
  }

  async create(name: string): Promise<Section> {
    if (!name.trim()) throw new Error("section name must not be empty");
    const all = await this.readAll();
    const now = new Date().toISOString();
    const maxOrder = all.reduce((m, s) => Math.max(m, s.order), -1);
    const section: Section = {
      sectionId: buildSectionId(),
      name: name.trim(),
      order: maxOrder + 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.writeAll([...all, section]);
    return section;
  }

  async rename(sectionId: string, name: string): Promise<Section | null> {
    if (!name.trim()) throw new Error("section name must not be empty");
    const all = await this.readAll();
    const idx = all.findIndex((s) => s.sectionId === sectionId);
    if (idx < 0) return null;
    const next: Section = { ...all[idx], name: name.trim(), updatedAt: new Date().toISOString() };
    const copy = [...all];
    copy[idx] = next;
    await this.writeAll(copy);
    return next;
  }

  /**
   * Soft-delete: flips status to "decommissioned" and clears sectionId on
   * every active channel pointing at this id. The section record stays on
   * disk so `restore` can bring it back with the same id (channels that
   * were still pointing at it remain uncategorized — restore doesn't
   * re-assign).
   */
  async decommission(sectionId: string): Promise<Section | null> {
    const all = await this.readAll();
    const idx = all.findIndex((s) => s.sectionId === sectionId);
    if (idx < 0) return null;
    const next: Section = {
      ...all[idx],
      status: "decommissioned",
      updatedAt: new Date().toISOString(),
    };
    const copy = [...all];
    copy[idx] = next;
    await this.writeAll(copy);

    // Move all channels out of this section so the sidebar doesn't
    // render them under a decommissioned group.
    const channels = await this.channelStore.listChannels("active");
    for (const c of channels) {
      if (c.sectionId === sectionId) {
        await this.channelStore.updateChannel(c.channelId, { sectionId: undefined });
      }
    }
    return next;
  }

  async restore(sectionId: string): Promise<Section | null> {
    const all = await this.readAll();
    const idx = all.findIndex((s) => s.sectionId === sectionId);
    if (idx < 0) return null;
    const next: Section = { ...all[idx], status: "active", updatedAt: new Date().toISOString() };
    const copy = [...all];
    copy[idx] = next;
    await this.writeAll(copy);
    return next;
  }

  /**
   * Hard-delete: removes the section record from disk. Only permitted
   * when no active channel still references the id — otherwise you'd
   * silently orphan the reference and the next load would render those
   * channels under a missing section. Callers should decommission first
   * (which auto-moves channels to uncategorized) then delete.
   */
  async delete(sectionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const channels = await this.channelStore.listChannels("active");
    const refs = channels.filter((c) => c.sectionId === sectionId);
    if (refs.length > 0) {
      return {
        ok: false,
        reason: `section has ${refs.length} active channel(s); decommission first`,
      };
    }
    const all = await this.readAll();
    const next = all.filter((s) => s.sectionId !== sectionId);
    if (next.length === all.length) return { ok: false, reason: "section not found" };
    await this.writeAll(next);
    return { ok: true };
  }

  async assignChannel(channelId: string, sectionId: string | null): Promise<void> {
    if (sectionId) {
      const target = await this.get(sectionId);
      if (!target) throw new Error(`section ${sectionId} not found`);
      if (target.status !== "active") {
        throw new Error(`section ${sectionId} is decommissioned; restore it first`);
      }
    }
    await this.channelStore.updateChannel(channelId, { sectionId: sectionId ?? undefined });
  }

  private async readAll(): Promise<Section[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Normalize `status` on read so a hand-edited sections.json with
      // an unexpected value (e.g. "archived") doesn't arrive in the GUI
      // typed as `Section` but containing a string outside the
      // "active" | "decommissioned" union. Unknown values coerce to
      // "active" — the more conservative choice (visible, not dropped).
      return parsed.map((raw) => {
        const s = raw as Section;
        const status: Section["status"] =
          s.status === "active" || s.status === "decommissioned" ? s.status : "active";
        return { ...s, status };
      });
    } catch {
      return [];
    }
  }

  private async writeAll(sections: Section[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const content = JSON.stringify(sections, null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, content, "utf8");
    try {
      await rename(tmp, this.path);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
  }
}

function buildSectionId(): string {
  return `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
