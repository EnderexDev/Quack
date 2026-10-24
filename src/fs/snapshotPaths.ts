import type { InstanceData } from "../ipc/messages.js";

/** An instance as a snapshot carries it: without `path` when the daemon asked for omitPaths */
export type SnapshotInstance = Omit<InstanceData, "path"> & { path?: string[] };

/**
 * Gives every instance of a full snapshot its path. A plugin asked for omitPaths sends none: in a
 * 261k-instance place the paths were 25 of the snapshot's 64 MB (measured 20/10/26), and each one
 * is its parent's plus its own name. Services have parentGuid "root". An instance that already
 * has a path (an older plugin) keeps it. One whose parent is not in the snapshot cannot be placed
 * and is dropped, as Studio would not have sent it under an excluded parent.
 */
export function fillSnapshotPaths(instances: SnapshotInstance[]): { filled: InstanceData[]; dropped: number } {
  const byGuid = new Map<string, SnapshotInstance>();
  for (const instance of instances) byGuid.set(instance.guid, instance);
  const paths = new Map<string, string[] | null>();

  const pathOf = (start: SnapshotInstance): string[] | null => {
    // Walk up to the first ancestor whose path is known, then come back down: no recursion, so a
    // deep tree cannot overflow the stack, and a parent loop ends as "cannot be placed"
    const chain: SnapshotInstance[] = [];
    const seen = new Set<string>();
    let current: SnapshotInstance | undefined = start;
    let base: string[] | null = null;
    while (current) {
      const known = current.path ?? paths.get(current.guid);
      if (known !== undefined) {
        base = known;
        break;
      }
      if (seen.has(current.guid)) break;
      seen.add(current.guid);
      chain.push(current);
      const parentGuid: string | null | undefined = current.parentGuid;
      if (!parentGuid || parentGuid === "root") {
        base = [];
        break;
      }
      current = byGuid.get(parentGuid);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const next = base === null ? null : [...base, chain[i].name];
      paths.set(chain[i].guid, next);
      base = next;
    }
    return start.path ?? paths.get(start.guid) ?? null;
  };

  const filled: InstanceData[] = [];
  let dropped = 0;
  for (const instance of instances) {
    const path = pathOf(instance);
    if (path === null) {
      dropped++;
      continue;
    }
    // Set on the parsed message itself: copying 261k objects would cost what dropping paths saved
    instance.path = path;
    filled.push(instance as InstanceData);
  }
  return { filled, dropped };
}
