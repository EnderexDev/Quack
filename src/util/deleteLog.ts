/**
 * Quack: one log line per deleted tree, saying who deleted it.
 *
 * The plugin sends one "deleted" per instance of a removed tree, in table order and in batches
 * of 200, so the root often comes after its descendants. The daemon printed every one of them:
 * Workspace.Worlds.0 of the Anime Astral (82 instances) was 82 red lines, the one that mattered
 * last, and nothing told a delete made in Studio from one the daemon ordered (07/11/26: three
 * logs had to be crossed to learn Quack had sent none).
 *
 * Deletes are held for a short window and printed grouped under the topmost path, with the count.
 */

import { log } from "./log.js";

/** studio: Studio (a person, a plugin, Team Create) removed it. disk: Quack removed it, its file or folder left the disk */
export type DeleteOrigin = "studio" | "disk";

interface Pending {
  path: string[];
  count: number;
  origin: DeleteOrigin;
}

/** Quiet time after the last delete before the lines go out; the batches of one tree come ms apart */
const WINDOW_MS = 300;
/** A steady stream of deletes still prints at least this often */
const MAX_WAIT_MS = 2000;

const LABEL: Record<DeleteOrigin, string> = {
  studio: "Deleted in Studio",
  disk: "Deleted by Quack (its file or folder left the disk)",
};

class DeleteLog {
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;

  /** A tree of `count` instances (itself included) removed at `path` */
  public note(path: string[], count: number, origin: DeleteOrigin): void {
    if (this.pending.length === 0) this.firstAt = Date.now();
    this.pending.push({ path: [...path], count, origin });
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(WINDOW_MS, this.firstAt + MAX_WAIT_MS - Date.now()));
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  /** Prints what is held, grouped; called by the timer, by a stopping daemon and by tests */
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const held = this.pending;
    this.pending = [];

    // Shortest paths first, so a root takes in every descendant noted before or after it
    const order = held.map((entry, index) => ({ entry, index }));
    order.sort((a, b) => a.entry.path.length - b.entry.path.length || a.index - b.index);
    // Groups by origin and path; each entry looks up its own prefixes (a path is a few segments
    // deep), so thousands of unrelated deletes cost no more than a scan each
    const groups: Pending[] = [];
    const byKey = new Map<string, Pending>();
    const keyOf = (origin: DeleteOrigin, path: string[], length: number) =>
      `${origin}\u0000${path.slice(0, length).join("\u0000")}`;
    for (const { entry } of order) {
      // A descendant noted on its own left the tree before its root did, so the root's count
      // does not hold it (when the root comes first, the descendants are never noted). The same
      // path twice adds up too
      let group: Pending | undefined;
      for (let length = 1; length <= entry.path.length && !group; length++) {
        group = byKey.get(keyOf(entry.origin, entry.path, length));
      }
      if (group) {
        group.count += entry.count;
        continue;
      }
      const created = { ...entry };
      groups.push(created);
      byKey.set(keyOf(entry.origin, entry.path, entry.path.length), created);
    }

    for (const group of groups) {
      const where = group.path.join("/");
      const size = group.count > 1 ? ` (${group.count} instances)` : "";
      log.script(`${LABEL[group.origin]}: ${where}${size}`, "deleted");
    }
  }
}

export const deleteLog = new DeleteLog();
