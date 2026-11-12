import fs from "node:fs";
import path from "node:path";
import { errorPlace, nodeForPath } from "../analyze/probe.js";
import { loadTree } from "../analyze/tree.js";
import { errorCounts, errorDetails, type ProductionError } from "../cloud/analytics.js";
import type { CloudContext } from "../cloud/ops.js";
import type { RegisteredPlace } from "../hub/registry.js";

/**
 * The alert of a new production error (his call, 12/11/26), read-only: once an hour, for each
 * registered place whose experience the saved Open Cloud key can read, the hub counts the live
 * game's errors by MessageHash (one Analytics request) and fetches the message and stack only of
 * the hashes it has not seen (20 a request). The first check of a place only learns what is
 * already there (30 days back); the app is told of each hash that shows up after that, with the
 * file and line it points at in the place's folder. What was seen is kept on disk (one file per
 * flavor, next to the registry), so a hub restarted by an update alerts nothing twice.
 *
 * Cost: one or two requests a place an hour, against the key's 60 a minute. A key without
 * universe.analytics:read for that experience is said once and asked again only a day later; no
 * key at all is no alert, and nothing to say.
 *
 * The counts include warn(): a new hash may be a game's own warning. The alert carries the
 * message and the side (client or server) so the user tells them apart.
 */
export interface NewProductionError extends ProductionError {
  /** The file and line it points at, from the place's folder (`sync/X.luau:12`), or the instance path */
  at?: string;
  /** When this hub first saw it */
  foundAt: number;
}

interface PlaceWatch {
  universeId?: string;
  seen: string[];
  /** When the first check learned what was there */
  baselineAt?: number;
  checkedAt?: number;
  fresh: NewProductionError[];
  problem?: { text: string; at: number };
}

export interface ErrorsView {
  state: "off" | "waiting" | "ready" | "problem";
  fresh: NewProductionError[];
  checkedAt?: number;
  universeId?: string;
  problem?: string;
}

export interface ErrorsWatchOptions {
  file: string;
  env: CloudContext["env"];
  places: () => Record<string, RegisteredPlace>;
  enabled: (placeId: string) => boolean;
  log: (line: string) => void;
  /** Between two checks of a place (default an hour) */
  everyMs?: number;
  /** How often the due places are looked for (default a minute) */
  tickMs?: number;
}

const DAY = 24 * 3600 * 1000;
/** Hashes kept as seen per place (the Analytics answer has at most 100 a check) */
const MAX_SEEN = 5000;
const MAX_FRESH = 50;

export class ErrorsWatch {
  private readonly busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private data: { places: Record<string, PlaceWatch> };

  constructor(private readonly options: ErrorsWatchOptions) {
    this.data = this.load();
  }

  private load(): { places: Record<string, PlaceWatch> } {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.file, "utf8"));
      if (parsed && typeof parsed.places === "object") return { places: parsed.places };
    } catch {
      // first run
    }
    return { places: {} };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      const temp = `${this.options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`);
      fs.renameSync(temp, this.options.file);
    } catch (error) {
      this.options.log(`Production errors: could not save ${this.options.file} (${(error as Error).message})`);
    }
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 60_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Checks every place that is due */
  tick(): void {
    const now = this.options.env.now();
    const every = this.options.everyMs ?? 3600_000;
    for (const placeId of Object.keys(this.options.places())) {
      if (!this.options.enabled(placeId) || this.busy.has(placeId)) continue;
      const w = this.data.places[placeId];
      const wait = w?.problem ? DAY : every;
      if (w?.checkedAt !== undefined && now - w.checkedAt < wait) continue;
      void this.check(placeId);
    }
  }

  view(placeId: string): ErrorsView {
    if (!this.options.enabled(placeId)) return { state: "off", fresh: [] };
    const w = this.data.places[placeId];
    if (!w) return { state: "waiting", fresh: [] };
    return {
      state: w.problem ? "problem" : w.checkedAt === undefined ? "waiting" : "ready",
      fresh: w.fresh,
      ...(w.checkedAt !== undefined ? { checkedAt: w.checkedAt } : {}),
      ...(w.universeId ? { universeId: w.universeId } : {}),
      ...(w.problem ? { problem: w.problem.text } : {}),
    };
  }

  /** For /api/state: each place's new errors not yet dismissed, the latest one, and a problem to say */
  summary(placeId: string): { newErrors?: number; latestError?: { message?: string; at?: string; source?: string }; errorsProblem?: string } {
    if (!this.options.enabled(placeId)) return {};
    const w = this.data.places[placeId];
    if (!w) return {};
    const latest = w.fresh.at(-1);
    return {
      ...(w.fresh.length ? { newErrors: w.fresh.length } : {}),
      ...(latest ? { latestError: { message: latest.message?.slice(0, 200), at: latest.at, source: latest.source } } : {}),
      ...(w.problem ? { errorsProblem: w.problem.text } : {}),
    };
  }

  /** The user saw them in the app */
  dismiss(placeId: string): void {
    const w = this.data.places[placeId];
    if (!w || !w.fresh.length) return;
    w.fresh = [];
    this.save();
  }

  async check(placeId: string): Promise<ErrorsView> {
    if (this.busy.has(placeId)) return this.view(placeId);
    this.busy.add(placeId);
    const place = this.options.places()[placeId];
    const w: PlaceWatch = (this.data.places[placeId] ??= { seen: [], fresh: [] });
    const env = this.options.env;
    try {
      // no key saved: nothing to read and nothing to say, and no request at all
      if (!env.apiKey || !(await env.apiKey())) {
        w.checkedAt = env.now();
        return this.view(placeId);
      }
      w.universeId ??= await this.universeOf(placeId);
      const baseline = w.baselineAt === undefined;
      const { startTime, errors } = await errorCounts(env, w.universeId, baseline ? 30 : 1);
      const now = env.now();
      if (baseline) {
        w.seen = errors.map((e) => e.hash);
        w.baselineAt = now;
      } else {
        const seen = new Set(w.seen);
        const unknown = errors.filter((e) => !seen.has(e.hash));
        if (unknown.length) {
          await errorDetails(env, w.universeId, unknown, startTime);
          for (const e of unknown) {
            w.seen.push(e.hash);
            // out of the 100 most frequent at the baseline, back in now: an old error, not a new one
            if (e.firstSeen && Date.parse(e.firstSeen) < w.baselineAt! - DAY) continue;
            const at = place ? this.fileOf(place.folder, e) : undefined;
            w.fresh.push({ ...e, ...(at ? { at } : {}), foundAt: now });
            this.options.log(`${place?.name ?? placeId}: new production error ${e.hash}${at ? ` at ${at}` : ""}: ${(e.message ?? "").slice(0, 120)}`);
          }
          if (w.seen.length > MAX_SEEN) w.seen = w.seen.slice(-MAX_SEEN);
          if (w.fresh.length > MAX_FRESH) w.fresh = w.fresh.slice(-MAX_FRESH);
        }
      }
      w.checkedAt = now;
      delete w.problem;
    } catch (error) {
      const message = (error as Error).message;
      w.checkedAt = env.now();
      if (/no Open Cloud key|used only inside the Quack hub/.test(message)) {
        // no key saved: nothing to read, nothing to say
      } else if (/refused the key \(HTTP 40[13]/.test(message)) {
        if (!w.problem) this.options.log(`${place?.name ?? placeId}: production errors not read: ${message}`);
        w.problem = { text: message, at: w.checkedAt };
      } else {
        this.options.log(`${place?.name ?? placeId}: production errors check failed (${message}); next try in an hour`);
      }
    } finally {
      this.busy.delete(placeId);
      this.save();
    }
    return this.view(placeId);
  }

  private async universeOf(placeId: string): Promise<string> {
    const response = await this.options.env.fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { signal: AbortSignal.timeout(15_000) });
    const json: any = await response.json().catch(() => undefined);
    const id = Number(json?.universeId);
    if (!response.ok || !Number.isSafeInteger(id) || id <= 0) throw new Error(`Roblox did not say which experience place ${placeId} is in (HTTP ${response.status})`);
    return String(id);
  }

  /** The file and line an error points at, in the place's folder */
  private fileOf(folder: string, e: ProductionError): string | undefined {
    const at = errorPlace({ m: e.message ?? "", t: e.stacktrace ?? "", s: "", g: "" });
    if (!at) return undefined;
    try {
      const tree = loadTree(folder, path.join(folder, "sync"), path.join(folder, "sourcemap.json"));
      const node = nodeForPath(tree, at.path);
      if (node?.file) return `${path.relative(folder, node.file).replace(/\\/g, "/")}:${at.line}`;
    } catch {
      // the instance path is all there is
    }
    return `${at.path}:${at.line}`;
  }
}
