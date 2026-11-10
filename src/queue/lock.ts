/**
 * A place's Studio lock and the list of clients waiting for it (Spec "Fila do Studio no Quack",
 * decisions 1, 6, 7, 8 and 13). One client holds the place's Studio at a time; the queue's own
 * runner is a holder like any other, except that a free Studio goes to it without waiting its
 * turn (its jobs are a queue of their own) and no cap ends it.
 *
 * A client is whatever drives Studio from outside: it has an id, a name, and the pid of the
 * process whose life is its life. That process ending frees the lock and drops its place in line.
 *
 * Who gets a free Studio: rush first, then the priority level, which rises one step for every
 * `agingMin` waited, then the shorter hold asked for, then who came first. A free Studio goes
 * to the head of that list, never to whoever asks first.
 *
 * Pure: the clock, the pid check and the jobs waiting come from outside, so it is tested without
 * processes or timers. The hub ticks it every second.
 */

export const LEVELS = ["critical", "blocking", "update", "normal", "low"] as const;
export type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { critical: 1, blocking: 2, update: 3, normal: 4, low: 5 };

export interface Client {
  id: string;
  name?: string;
  pid?: number;
}

export interface Holder {
  client: Client;
  tool: string;
  acquiredAt: number;
  lastUsed: number;
  /** Minutes the client said it would hold Studio (from its place in line), null when it never waited */
  requestedMin: number | null;
  level?: Level;
  task?: string;
  runner?: boolean;
  /** Holds Studio to publish the place (publish.ts) */
  publish?: PublishWant;
}

/** A place in line that wants the place published, not Studio for itself (publish.ts) */
export interface PublishWant {
  ticket: string;
  commit?: string;
}

export interface Waiter {
  client: Client;
  task: string;
  holdMin: number;
  level: Level;
  rush: boolean;
  since: number;
  /** Wants Studio live: the runner finishes its batch and hands Studio over */
  exclusive: boolean;
  /** Wants the place published: one publish answers every such entry it covers */
  publish?: PublishWant;
}

export interface Cap {
  clientId: string;
  at: number;
  waitedMs: number;
  capMs: number;
}

/** Why a hold ended, for the history */
export type EndReason = "release" | "force" | "idle" | "idle-waiting" | "cap" | "gone" | "restart";

export interface GrantRecord {
  kind: "grant";
  client: Client;
  runner: boolean;
  acquiredAt: number;
  endedAt: number;
  heldMs: number;
  requestedMin: number | null;
  level?: Level;
  task?: string;
  endedBy: EndReason;
}

export interface LockState {
  holder: Holder | null;
  waiters: Waiter[];
  /** The latest cap, for what the app shows */
  cap: Cap | null;
  /** Every client capped since the last batch: a second cap never frees the first client early */
  capped: Cap[];
  /** When the runner last finished a batch: a capped client may take Studio again after it */
  lastBatchAt: number;
}

export interface LockDeps {
  now: () => number;
  alive: (pid: number) => boolean;
  settings: () => { lockIdleMin: number; lockIdleWaitingMin: number; capMin: number; agingMin: number };
  /** Jobs waiting in the place's queue, and when the oldest was submitted */
  pending: () => { count: number; oldest: number | null };
  onGrantEnd?: (record: GrantRecord) => void;
  /** `clockOnly`: only the holder's last-call time and tool moved (saved lazily) */
  onChange?: (clockOnly?: boolean) => void;
}

export const RUNNER: Client = { id: "quack-queue", name: "the Studio queue" };

export type ClaimResult =
  | { ok: true; fresh: boolean; holder: Holder }
  | { ok: false; holder?: Holder; queue?: Waiter[]; capped?: Cap & { pending: number } };

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function effectiveRank(waiter: Pick<Waiter, "level" | "since">, now: number, agingMin: number): number {
  const steps = Math.floor((now - waiter.since) / 60_000 / agingMin);
  return Math.max(1, (RANK[waiter.level] ?? 4) - steps);
}

export function levelOfRank(rank: number): Level {
  return LEVELS[Math.min(Math.max(rank, 1), 5) - 1];
}

export function rankWaiters(list: Waiter[], now: number, agingMin: number): Waiter[] {
  return [...list].sort(
    (a, b) =>
      Number(b.rush === true) - Number(a.rush === true) ||
      effectiveRank(a, now, agingMin) - effectiveRank(b, now, agingMin) ||
      (a.holdMin ?? 10) - (b.holdMin ?? 10) ||
      a.since - b.since,
  );
}

export class StudioLock {
  state: LockState = { holder: null, waiters: [], cap: null, capped: [], lastBatchAt: 0 };

  constructor(private readonly deps: LockDeps) {}

  private changed(clockOnly = false): void {
    this.deps.onChange?.(clockOnly);
  }

  private live(client: Client): boolean {
    return !client.pid || this.deps.alive(client.pid);
  }

  /** The cap that keeps `clientId` out while it stands: jobs still waiting and no batch since */
  activeCap(clientId: string): (Cap & { pending: number }) | null {
    const cap = this.state.capped.find((c) => c.clientId === clientId);
    if (!cap) return null;
    const { count } = this.deps.pending();
    return count > 0 && cap.at > this.state.lastBatchAt ? { ...cap, pending: count } : null;
  }

  /** The waiting list as it would be served, dead clients left out */
  ranked(): Waiter[] {
    const now = this.deps.now();
    return rankWaiters(this.state.waiters.filter((w) => this.live(w.client)), now, this.deps.settings().agingMin);
  }

  /** The clients that asked for Studio live and are not capped: the runner hands Studio over to them */
  exclusiveWaiters(): Waiter[] {
    return this.ranked().filter((w) => w.exclusive && !this.activeCap(w.client.id));
  }

  /** Takes the lock for `client`, or refreshes it when the client holds it already */
  claim(client: Client, tool: string): ClaimResult {
    const now = this.deps.now();
    const holder = this.state.holder;
    if (holder) {
      if (holder.client.id === client.id) {
        holder.lastUsed = now;
        holder.tool = tool;
        const newPid = Boolean(client.pid && !holder.client.pid);
        if (newPid) holder.client.pid = client.pid;
        this.changed(!newPid);
        return { ok: true, fresh: false, holder };
      }
      return { ok: false, holder };
    }
    const runner = client.id === RUNNER.id;
    if (!runner) {
      const capped = this.activeCap(client.id);
      if (capped) return { ok: false, capped };
      const ranked = this.ranked();
      const at = ranked.findIndex((w) => w.client.id === client.id);
      const ahead = at < 0 ? ranked : ranked.slice(0, at);
      if (ahead.length) return { ok: false, queue: ahead };
    }
    const mine = this.state.waiters.find((w) => w.client.id === client.id);
    this.state.holder = {
      client: { ...client },
      tool,
      acquiredAt: now,
      lastUsed: now,
      requestedMin: mine ? mine.holdMin : null,
      ...(mine ? { level: mine.level, task: mine.task } : {}),
      ...(mine?.publish ? { publish: mine.publish } : {}),
      ...(runner ? { runner: true } : {}),
    };
    // Served: its place in line is done (the waiting process leaving later changes nothing)
    this.state.waiters = this.state.waiters.filter((w) => w.client.id !== client.id);
    if (!runner) {
      this.state.capped = this.state.capped.filter((c) => c.clientId !== client.id);
      if (this.state.cap?.clientId === client.id) this.state.cap = null;
    }
    this.changed();
    return { ok: true, fresh: true, holder: this.state.holder };
  }

  /** A read by the holder keeps its lock from idling out; nobody else is touched */
  touch(clientId: string, tool?: string): boolean {
    const holder = this.state.holder;
    if (!holder || holder.client.id !== clientId) return false;
    holder.lastUsed = this.deps.now();
    if (tool) holder.tool = tool;
    this.changed(true);
    return true;
  }

  /** Frees the lock when `clientId` holds it, or whoever holds it with `force` */
  release(clientId: string | null, force = false): Holder | null {
    const holder = this.state.holder;
    if (!holder) return null;
    if (!force && holder.client.id !== clientId) return null;
    this.end(force && holder.client.id !== clientId ? "force" : "release");
    return holder;
  }

  /** The client is done (its turn ended, it closed): its lock and its place in line go */
  releaseAll(clientId: string): boolean {
    const held = this.state.holder?.client.id === clientId;
    if (held) this.end("release");
    const before = this.state.waiters.length;
    this.state.waiters = this.state.waiters.filter((w) => w.client.id !== clientId);
    if (before !== this.state.waiters.length) this.changed();
    return held;
  }

  join(waiter: Omit<Waiter, "since"> & { since?: number }): Waiter {
    const entry: Waiter = { ...waiter, since: waiter.since ?? this.deps.now() };
    // One place per client: a newer wait replaces the older one and keeps its time in line
    const old = this.state.waiters.find((w) => w.client.id === waiter.client.id);
    if (old && waiter.since === undefined) entry.since = old.since;
    this.state.waiters = [...this.state.waiters.filter((w) => w.client.id !== waiter.client.id), entry];
    this.changed();
    return entry;
  }

  /** Only the entry of that process: a newer wait of the same client keeps its place */
  leave(clientId: string, pid?: number): void {
    const before = this.state.waiters.length;
    this.state.waiters = this.state.waiters.filter((w) => !(w.client.id === clientId && (pid === undefined || w.client.pid === pid)));
    if (before !== this.state.waiters.length) this.changed();
  }

  /** Only the place in line of that publish ticket: a newer entry of the same client stays */
  leaveTicket(ticket: string): void {
    const before = this.state.waiters.length;
    this.state.waiters = this.state.waiters.filter((w) => w.publish?.ticket !== ticket);
    if (before !== this.state.waiters.length) this.changed();
  }

  /** Someone waits for this Studio: another live client in line, or a job in the queue */
  othersWaiting(): boolean {
    const holderId = this.state.holder?.client.id;
    if (this.state.waiters.some((w) => w.client.id !== holderId && this.live(w.client))) return true;
    return this.deps.pending().count > 0;
  }

  private end(reason: EndReason): void {
    const holder = this.state.holder;
    if (!holder) return;
    const now = this.deps.now();
    this.state.holder = null;
    this.deps.onGrantEnd?.({
      kind: "grant",
      client: holder.client,
      runner: holder.runner === true,
      acquiredAt: holder.acquiredAt,
      endedAt: now,
      heldMs: now - holder.acquiredAt,
      requestedMin: holder.requestedMin,
      ...(holder.level ? { level: holder.level } : {}),
      ...(holder.task ? { task: holder.task } : {}),
      endedBy: reason,
    });
    this.changed();
  }

  /** A hub that starts again: a runner's hold is the old hub's, gone with it */
  dropRunnerHold(): void {
    if (this.state.holder?.runner) this.end("restart");
  }

  /** Every second: dead clients out, an idle hold ended, a hold past the cap ended. Resolves to what ended */
  tick(): EndReason | null {
    const now = this.deps.now();
    const before = this.state.waiters.length;
    this.state.waiters = this.state.waiters.filter((w) => this.live(w.client));
    if (before !== this.state.waiters.length) this.changed();
    const holder = this.state.holder;
    if (!holder) return null;
    if (!this.live(holder.client)) {
      this.end("gone");
      return "gone";
    }
    const settings = this.deps.settings();
    const idle = now - holder.lastUsed;
    if (idle > settings.lockIdleMin * 60_000) {
      this.end("idle");
      return "idle";
    }
    if (holder.runner) return null;
    if (idle > settings.lockIdleWaitingMin * 60_000 && this.othersWaiting()) {
      this.end("idle-waiting");
      return "idle-waiting";
    }
    // The cap counts from when the oldest job began waiting behind this hold
    const { oldest } = this.deps.pending();
    if (oldest !== null) {
      const waited = now - Math.max(oldest, holder.acquiredAt);
      const capMs = settings.capMin * 60_000;
      if (waited > capMs) {
        this.state.cap = { clientId: holder.client.id, at: now, waitedMs: waited, capMs };
        this.state.capped = [...this.state.capped.filter((c) => c.clientId !== holder.client.id), this.state.cap];
        this.end("cap");
        return "cap";
      }
    }
    return null;
  }

  /** The runner finished a batch: a capped client may take Studio again */
  batchDone(): void {
    this.state.lastBatchAt = this.deps.now();
    // Every cap so far is spent: their clients may take Studio again
    this.state.capped = this.state.capped.filter((c) => c.at > this.state.lastBatchAt);
    this.changed();
  }

  /** A cap lifted by hand: its client may take Studio at once */
  liftCap(): void {
    if (!this.state.cap && !this.state.capped.length) return;
    this.state.cap = null;
    this.state.capped = [];
    this.changed();
  }

  /** What is saved to disk: the runner's hold is not (it belongs to the hub that made it) */
  serialize(): LockState {
    return {
      holder: this.state.holder?.runner ? null : this.state.holder,
      waiters: this.state.waiters,
      cap: this.state.cap,
      capped: this.state.capped,
      lastBatchAt: this.state.lastBatchAt,
    };
  }

  restore(saved: Partial<LockState> | null | undefined): void {
    if (!saved) return;
    const holder = saved.holder && typeof saved.holder === "object" && typeof saved.holder.client?.id === "string" && !saved.holder.runner ? saved.holder : null;
    this.state = {
      holder,
      waiters: Array.isArray(saved.waiters) ? saved.waiters.filter((w) => w && typeof w.client?.id === "string" && isLevel(w.level)) : [],
      cap: saved.cap && typeof saved.cap.clientId === "string" ? saved.cap : null,
      // A state saved before the list kept its one cap
      capped: Array.isArray(saved.capped)
        ? saved.capped.filter((c) => c && typeof c.clientId === "string")
        : saved.cap && typeof saved.cap.clientId === "string"
          ? [saved.cap]
          : [],
      lastBatchAt: Number(saved.lastBatchAt) || 0,
    };
  }
}
