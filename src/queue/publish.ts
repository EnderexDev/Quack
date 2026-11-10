import { randomBytes } from "node:crypto";
import type { Client, Level, StudioLock } from "./lock.js";

/**
 * Publishing the place, through the Studio queue (Spec "Fila do Studio no Quack", rodada 4).
 *
 * Studio publishes what it holds, all of it: one publish ships every change synced into it, so
 * several clients waiting to publish need one publish, not one each. A client that wants the place
 * published takes a ticket; the tickets wait in the place's Studio line as clients that want Studio
 * live (the runner finishes its batch and stops its play: Studio publishes nothing during a play).
 * The first ticket served holds Studio and publishes (Quack does not publish: the client runs its
 * own command). When it says the publish went out, every ticket it covered is answered with that
 * publish and leaves the line without ever taking Studio:
 *
 * - a ticket that names a commit is covered when that commit is in the synced checkout's HEAD the
 *   publish shipped (git merge-base --is-ancestor), whenever it joined;
 * - a ticket with no commit ("what Studio holds now") is covered when it joined before the
 *   publisher took Studio.
 *
 * A publish that fails, or a publisher whose hold ends first (its process gone, the idle limit, a
 * forced release), covers nobody: the next ticket in line takes Studio and publishes. A ticket
 * whose commit an earlier publish already shipped is answered at once, when it joins.
 *
 * A commit must be in the synced checkout before it joins: Studio holds that folder, never a
 * worktree, so a commit outside it would never be published by anyone.
 */

export interface PublishGit {
  /** The checkout's HEAD commit, or null when the folder is not a git checkout */
  head(folder: string): Promise<string | null>;
  /** The full id of a commit the checkout knows, or null */
  resolve(folder: string, ref: string): Promise<string | null>;
  /** `commit` is `head` or an ancestor of it */
  isAncestor(folder: string, commit: string, head: string): Promise<boolean>;
}

export type TicketState = "waiting" | "publishing" | "published" | "covered" | "failed" | "left" | "dropped";

export interface Ticket {
  id: string;
  client: Client;
  /** The commit this ticket wants live (full id); none: what Studio holds when it joined */
  commit?: string;
  task?: string;
  joinedAt: number;
  state: TicketState;
  /** While a publish runs: the running publish will cover this ticket if it goes out */
  rides?: boolean;
  /** When it took Studio to publish, and the synced checkout's HEAD then: kept after a lost hold */
  grant?: { head: string | null; since: number };
  /** Its hold ended while its command ran: the command may still say it published */
  holdLost?: boolean;
  /** Ended: when, and the publish that answered it (its publisher's ticket) */
  publish?: PublishRecord;
  endedAt?: number;
  by?: string;
  reason?: string;
}

export interface PublishRecord {
  ticket: string;
  client: Client;
  /** The synced checkout's commit the publish shipped (the client's own, or HEAD when Studio was taken) */
  head: string | null;
  version?: number | string;
  since: number;
  at: number;
  ms: number;
  /** The tickets this publish answered besides its own */
  covered: { ticket: string; client: Client; commit?: string }[];
}

interface Current {
  ticket: string;
  head: string | null;
  since: number;
}

export interface PublishState {
  current: Current | null;
  tickets: Ticket[];
  last: PublishRecord | null;
}

export class PublishError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PublishDeps {
  folder: string;
  lock: StudioLock;
  git: PublishGit;
  now: () => number;
  onChange: () => void;
  history: (entry: Record<string, unknown>) => void;
  log: (line: string) => void;
  /** Wakes the runner: it must see a publish waiter to stand down, and a free Studio after one */
  kick: () => void;
}

/** How long an answered ticket is kept for its client to read the answer */
const KEEP_ENDED_MS = 3600_000;
/** What a publish waiter says it will hold Studio for */
const PUBLISH_HOLD_MIN = 2;

const ENDED: TicketState[] = ["published", "covered", "failed", "left", "dropped"];

export class PublishLine {
  private state: PublishState = { current: null, tickets: [], last: null };

  constructor(private readonly deps: PublishDeps) {}

  private ticket(id: string): Ticket {
    const t = this.state.tickets.find((x) => x.id === id);
    if (!t) throw new PublishError(404, `no publish ticket ${id} in this place's queue`);
    return t;
  }

  private changed(): void {
    this.deps.onChange();
  }

  private end(t: Ticket, state: TicketState, extra: { by?: string; reason?: string } = {}): void {
    t.state = state;
    t.endedAt = this.deps.now();
    delete t.rides;
    if (extra.by) t.by = extra.by;
    if (extra.reason) t.reason = extra.reason;
  }

  /** The record a ticket's answer points at */
  private recordOf(t: Ticket): PublishRecord | null {
    if (t.publish) return t.publish;
    const last = this.state.last;
    if (!last) return null;
    const id = t.state === "covered" ? t.by : t.id;
    return last.ticket === id ? last : null;
  }

  private answer(t: Ticket) {
    return {
      ticket: t.id,
      state: t.state,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.state === "published" || t.state === "covered" ? { publish: this.recordOf(t) } : {}),
    };
  }

  private publisher(): Ticket | null {
    const cur = this.state.current;
    return cur ? (this.state.tickets.find((t) => t.id === cur.ticket) ?? null) : null;
  }

  async join(input: { client: Client; commit?: string; task?: string; level: Level; rush: boolean }) {
    const { folder, git } = this.deps;
    const seenLast = this.state.last;
    let commit: string | undefined;
    if (input.commit) {
      const full = await git.resolve(folder, input.commit);
      if (!full) throw new PublishError(400, `commit ${input.commit} is not in the synced checkout (${folder}): land it there first, Studio publishes only that folder`);
      const head = await git.head(folder);
      if (head && !(await git.isAncestor(folder, full, head))) {
        throw new PublishError(409, `commit ${full.slice(0, 8)} is not in the synced checkout's HEAD (${head.slice(0, 8)}) yet: land it first, Studio publishes only what that folder holds`);
      }
      commit = full;
      const last = this.state.last;
      if (last?.head && (await git.isAncestor(folder, full, last.head))) {
        this.replaceOlder(input.client.id);
        return { state: "published" as const, publish: last, already: true };
      }
    }
    const now = this.deps.now();
    this.replaceOlder(input.client.id);
    const t: Ticket = {
      id: `${now}-${randomBytes(3).toString("hex")}`,
      client: { id: input.client.id, ...(input.client.name ? { name: input.client.name } : {}), ...(input.client.pid ? { pid: input.client.pid } : {}) },
      ...(commit ? { commit } : {}),
      ...(input.task ? { task: input.task } : {}),
      joinedAt: now,
      state: "waiting",
    };
    // Joined while a publish runs: only a commit already in what it ships can ride it
    const cur = this.state.current;
    if (cur?.head && commit) t.rides = await git.isAncestor(folder, commit, cur.head);
    this.state.tickets.push(t);
    this.deps.lock.join({
      client: t.client,
      task: input.task ? `publish: ${input.task}` : "publish",
      holdMin: PUBLISH_HOLD_MIN,
      level: input.level,
      rush: input.rush,
      exclusive: true,
      publish: { ticket: t.id, ...(commit ? { commit } : {}) },
    });
    this.deps.history({ kind: "publish-join", ticket: t.id, client: t.client, ...(commit ? { commit } : {}) });
    this.changed();
    // A publish that ended while git answered above had no chance to cover this ticket
    const last = this.state.last;
    if (commit && last && last !== seenLast && last.head && (await git.isAncestor(folder, commit, last.head).catch(() => false)) && t.state === "waiting") {
      this.end(t, "covered", { by: last.ticket });
      t.publish = last;
      this.deps.lock.leaveTicket(t.id);
      this.changed();
      return { state: "published" as const, publish: last, already: true };
    }
    this.deps.kick();
    return { state: "waiting" as const, ticket: t.id, ...this.position(t) };
  }

  /** One place in line per client: a newer request of the same client replaces the older one */
  private replaceOlder(clientId: string): void {
    for (const old of this.state.tickets) {
      if (old.client.id !== clientId || old.state !== "waiting") continue;
      this.end(old, "left", { reason: "replaced by a newer request of the same client" });
      this.deps.lock.leaveTicket(old.id);
      this.changed();
    }
  }

  /** The publisher still holds Studio; when it does not, its publish ends as lost (what tick does) */
  private stillHolds(t: Ticket): boolean {
    if (this.state.current?.ticket === t.id && t.state === "publishing" && this.deps.lock.state.holder?.client.id === t.client.id) return true;
    if (this.state.current?.ticket === t.id) this.loseHold();
    return false;
  }

  private position(t: Ticket) {
    const ranked = this.deps.lock.ranked();
    const holder = this.deps.lock.state.holder;
    const pub = this.publisher();
    return {
      position: ranked.findIndex((w) => w.publish?.ticket === t.id) + 1 || null,
      holder: holder ? { client: holder.client, tool: holder.tool, runner: holder.runner === true } : null,
      publishing: pub && pub.id !== t.id ? { ticket: pub.id, client: pub.client, since: this.state.current!.since, rides: t.rides === true } : null,
    };
  }

  /** The ticket's turn: Studio is its to publish, or the answer when another publish covered it */
  async claim(id: string) {
    const t = this.ticket(id);
    if (ENDED.includes(t.state)) return this.answer(t);
    const cur = this.state.current;
    if (t.state === "publishing" && cur?.ticket === t.id) {
      if (!this.stillHolds(t)) return this.answer(t);
      this.deps.lock.touch(t.client.id, "publish");
      return { ticket: t.id, state: "yours" as const, head: cur.head, riders: this.riders() };
    }
    // Another ticket of the same client is publishing: this one waits for its answer
    if (cur) return { ticket: t.id, state: "waiting" as const, ...this.position(t) };
    const result = this.deps.lock.claim(t.client, "publish");
    if (!result.ok) return { ticket: t.id, state: "waiting" as const, ...this.position(t), ...(result.capped ? { capped: result.capped } : {}) };
    // A client that held Studio already keeps its hold, and its publish entry would stay in line
    this.deps.lock.leave(t.client.id, t.client.pid);
    const since = this.deps.now();
    this.state.current = { ticket: t.id, head: null, since };
    t.state = "publishing";
    t.grant = { head: null, since };
    delete t.rides;
    this.changed();
    const head = await this.deps.git.head(this.deps.folder).catch(() => null);
    // The hold may have ended while git answered
    if (this.state.current?.ticket !== t.id) return this.answer(t);
    this.state.current.head = head;
    t.grant = { head, since };
    // Its own commit left the synced checkout (a reset there): publishing now would not ship it
    if (t.commit && head && !(await this.deps.git.isAncestor(this.deps.folder, t.commit, head).catch(() => false))) {
      if (this.state.current?.ticket !== t.id) return this.answer(t);
      this.end(t, "failed", { reason: `commit ${t.commit.slice(0, 8)} is no longer in the synced checkout's HEAD (${head.slice(0, 8)}): nothing was published` });
      this.state.current = null;
      this.deps.lock.release(t.client.id);
      this.changed();
      this.deps.kick();
      return this.answer(t);
    }
    const rides = new Map<Ticket, boolean>();
    for (const other of this.waiting()) rides.set(other, await this.covers(other, head, since));
    // The hold may have ended while git answered: never "yours" without Studio, and no riders for a publish that is gone
    if (!this.stillHolds(t)) return this.answer(t);
    for (const [other, rideOn] of rides) if (other.state === "waiting") other.rides = rideOn;
    this.deps.history({ kind: "publish-start", ticket: t.id, client: t.client, head, riders: this.riders().length });
    this.deps.log(`publish: ${t.client.name ?? t.client.id} publishes${head ? ` ${head.slice(0, 8)}` : ""}${this.riders().length ? `, ${this.riders().length} more ride on it` : ""}`);
    this.changed();
    return { ticket: t.id, state: "yours" as const, head, riders: this.riders() };
  }

  private waiting(): Ticket[] {
    return this.state.tickets.filter((t) => t.state === "waiting");
  }

  private riders() {
    return this.waiting()
      .filter((t) => t.rides)
      .map((t) => ({ ticket: t.id, client: t.client, ...(t.commit ? { commit: t.commit } : {}) }));
  }

  private async covers(t: Ticket, head: string | null, since: number): Promise<boolean> {
    if (!t.commit) return t.joinedAt <= since;
    if (!head) return false;
    return this.deps.git.isAncestor(this.deps.folder, t.commit, head).catch(() => false);
  }

  /** The publisher's command is still running: its hold does not idle out */
  touch(id: string): { ok: boolean } {
    const t = this.ticket(id);
    if (t.state !== "publishing" || this.state.current?.ticket !== id) return { ok: false };
    return { ok: this.deps.lock.touch(t.client.id, "publish") };
  }

  /** The publisher's command ended: what it published covers the tickets waiting for it */
  async done(id: string, outcome: { ok: boolean; version?: number | string; commit?: string; reason?: string }) {
    const t = this.ticket(id);
    const cur = this.state.current;
    // Its hold ended (the cap, a forced release) while its command still ran: a publish that went
    // out is still a publish, and it still answers the tickets it covers
    const late = outcome.ok && t.state === "failed" && t.holdLost === true && t.grant !== undefined;
    if (!late && (t.state !== "publishing" || cur?.ticket !== id)) {
      if (ENDED.includes(t.state)) return this.answer(t);
      throw new PublishError(409, `ticket ${id} is not publishing (state ${t.state})`);
    }
    const grant = late ? t.grant! : { head: cur!.head, since: cur!.since };
    const { folder, git } = this.deps;
    const now = this.deps.now();
    if (outcome.ok) {
      // What the command says it shipped wins over HEAD when Studio was taken
      let head = grant.head;
      if (outcome.commit) head = (await git.resolve(folder, outcome.commit).catch(() => null)) ?? head;
      const covered: Ticket[] = [];
      for (const other of this.waiting()) if (await this.covers(other, head, grant.since)) covered.push(other);
      const ownMissing = t.commit && head ? !(await git.isAncestor(folder, t.commit, head).catch(() => false)) : false;
      if (late ? t.state !== "failed" : this.state.current?.ticket !== id) return this.answer(t);
      // Only tickets still waiting: one that left while git answered is not answered, and only its own place goes
      const stillWaiting = covered.filter((other) => other.state === "waiting");
      covered.length = 0;
      covered.push(...stillWaiting);
      for (const other of covered) {
        this.end(other, "covered", { by: id });
        this.deps.lock.leaveTicket(other.id);
      }
      const record: PublishRecord = {
        ticket: id,
        client: t.client,
        head,
        ...(outcome.version !== undefined ? { version: outcome.version } : {}),
        since: grant.since,
        at: now,
        ms: now - grant.since,
        covered: covered.map((c) => ({ ticket: c.id, client: c.client, ...(c.commit ? { commit: c.commit } : {}) })),
      };
      this.state.last = record;
      for (const other of covered) other.publish = record;
      delete t.reason;
      delete t.holdLost;
      if (ownMissing) {
        // The publish went out and answers the others; it did not ship what this ticket asked for
        this.end(t, "failed", { reason: `published ${head!.slice(0, 8)}, which does not hold commit ${t.commit!.slice(0, 8)}` });
      } else {
        this.end(t, "published");
      }
      t.publish = record;
      this.deps.history({ kind: "publish", ...record });
      this.deps.log(`publish: ${t.client.name ?? t.client.id} published${outcome.version !== undefined ? ` version ${outcome.version}` : ""}${covered.length ? `, ${covered.length} more answered by it` : ""}`);
    } else {
      this.end(t, "failed", { reason: outcome.reason ?? "the publish command failed" });
      this.deps.history({ kind: "publish-failed", ticket: id, client: t.client, ms: now - grant.since, reason: t.reason });
      this.deps.log(`publish: ${t.client.name ?? t.client.id} did not publish (${t.reason})`);
    }
    // A late answer holds nothing: Studio and the running publish, if any, are someone else's
    if (!late) {
      this.state.current = null;
      for (const other of this.waiting()) delete other.rides;
      this.deps.lock.release(t.client.id);
    }
    this.changed();
    this.deps.kick();
    return this.answer(t);
  }

  /** The client gave up: its place in line goes, or its publish ends as failed */
  async leave(id: string) {
    const t = this.ticket(id);
    if (t.state === "publishing") return this.done(id, { ok: false, reason: "the publisher left before saying it published" });
    if (t.state === "waiting") {
      this.end(t, "left");
      this.deps.lock.leaveTicket(t.id);
      this.changed();
    }
    return this.answer(t);
  }

  /** The publisher's hold ended before it answered: its publish fails, and a late "published" still counts (done) */
  private loseHold(): void {
    const cur = this.state.current;
    if (!cur) return;
    const pub = this.publisher();
    if (pub) {
      this.end(pub, "failed", { reason: "its Studio hold ended before it said it published (its process ended, the idle limit, the cap, or a forced release)" });
      pub.holdLost = true;
      this.deps.history({ kind: "publish-failed", ticket: pub.id, client: pub.client, ms: this.deps.now() - cur.since, reason: pub.reason });
      this.deps.log(`publish: ${pub.client.name ?? pub.client.id} lost Studio before it said it published`);
    }
    this.state.current = null;
    for (const other of this.waiting()) delete other.rides;
    this.changed();
    this.deps.kick();
  }

  /** Every second: a publisher whose hold ended, tickets whose place in line is gone, old answers */
  tick(): void {
    const now = this.deps.now();
    let dirty = false;
    const pub = this.publisher();
    if (this.state.current && (!pub || this.deps.lock.state.holder?.client.id !== pub.client.id)) {
      this.loseHold();
      dirty = true;
    }
    const inLine = new Set(this.deps.lock.state.waiters.map((w) => w.publish?.ticket).filter(Boolean));
    for (const t of this.waiting()) {
      if (inLine.has(t.id)) continue;
      this.end(t, "dropped", { reason: "its place in line is gone (its process ended)" });
      dirty = true;
    }
    const before = this.state.tickets.length;
    this.state.tickets = this.state.tickets.filter((t) => !t.endedAt || now - t.endedAt < KEEP_ENDED_MS);
    if (dirty || before !== this.state.tickets.length) this.changed();
  }

  status() {
    const now = this.deps.now();
    const cur = this.state.current;
    const pub = this.publisher();
    return {
      current: cur && pub ? { ticket: pub.id, client: pub.client, head: cur.head, ms: now - cur.since, riders: this.riders() } : null,
      waiting: this.waiting().map((t) => ({ ticket: t.id, client: t.client, commit: t.commit, waitedMs: now - t.joinedAt, rides: t.rides === true })),
      last: this.state.last,
    };
  }

  /** How many tickets wait to publish (the app's place list) */
  waitingCount(): number {
    return this.waiting().length + (this.state.current ? 1 : 0);
  }

  serialize(): PublishState {
    return this.state;
  }

  restore(saved: Partial<PublishState> | null | undefined): void {
    if (!saved || typeof saved !== "object") return;
    const tickets = Array.isArray(saved.tickets) ? saved.tickets.filter((t) => t && typeof t.id === "string" && typeof t.client?.id === "string" && typeof t.state === "string") : [];
    const current = saved.current && typeof saved.current.ticket === "string" && tickets.some((t) => t.id === saved.current!.ticket) ? saved.current : null;
    const last = saved.last && typeof saved.last.ticket === "string" ? saved.last : null;
    this.state = { current, tickets, last };
  }
}
