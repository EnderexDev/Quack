import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../analyze/command.js";
import { fileKey } from "../analyze/tree.js";
import type { AnalysisService } from "../auto/service.js";
import type { AutoFeature } from "../auto/settings.js";
import type { RegisteredPlace } from "../hub/registry.js";
import { executeTests } from "./execute.js";
import { StandbyPool } from "./pool.js";
import { findSpecs, pruneTrees } from "./project.js";
import type { TestReport } from "./report.js";

/**
 * Quack Test in the hub: the runs `quack test` and the MCP tool ask for, and the two that run on
 * their own (his call, 23/11/26), each one on or off per place in automation.json:
 *  - tests: after an AI's edit, the specs the edited files reach (found by the analysis thread,
 *    which keeps the project's parses); the answer goes back to the AI with the review's
 *  - playTests: every spec when a play starts (quack play, solo_playtest): a warning, never a
 *    reason not to play
 * The runs use the pool's ready processes, so the place's tree is loaded before they come.
 */
export interface HubTestsOptions {
  places: () => Record<string, RegisteredPlace>;
  analysis: AnalysisService;
  enabled: (feature: AutoFeature, placeId?: string | null) => boolean;
  placeOf: (root: string) => string | undefined;
  log: (line: string) => void;
  /** Stop a ready process nobody used for this long (tests shorten it) */
  idleMs?: number;
}

export class HubTests {
  readonly pool: StandbyPool;

  constructor(private readonly options: HubTestsOptions) {
    this.pool = new StandbyPool({ log: options.log, ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}) });
    // trees no run used for two weeks (a sourcemap rewritten leaves its old .rbxl behind)
    pruneTrees();
  }

  private folders(): string[] {
    return Object.values(this.options.places()).map((p) => p.folder);
  }

  /** Each project's runs, one after the other: two at once would each start a process and build its tree */
  private readonly queues = new Map<string, Promise<unknown>>();

  private execute(root: string, files?: string[], filter?: string[], testTimeout?: number): Promise<TestReport> {
    const key = fileKey(root);
    const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.executeNow(root, files, filter, testTimeout));
    this.queues.set(key, run);
    void run.finally(() => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    }).catch(() => {});
    return run;
  }

  private executeNow(root: string, files?: string[], filter?: string[], testTimeout?: number): Promise<TestReport> {
    return executeTests({
      root,
      ...(files?.length ? { files } : {}),
      ...(filter?.length ? { filter } : {}),
      ...(testTimeout ? { testTimeout } : {}),
      pool: this.pool,
      placeFolders: async () => this.folders(),
      reach: async (r, f) => {
        const specs = new Set((await this.options.analysis.reach({ root: r, files: f, placeFolders: this.folders() })).map((s) => path.resolve(s)));
        return findSpecs(r).filter((s) => specs.has(path.resolve(s.file)));
      },
    });
  }

  /** `quack test` and the MCP tool */
  run(root: string, files?: string[], filter?: string[], testTimeout?: number): Promise<TestReport> {
    return this.execute(path.resolve(root), files, filter, testTimeout);
  }

  /** After an AI's edit: per project, the specs the edited files reach; nothing when none does */
  async afterEdit(files: string[]): Promise<{ disabled?: boolean; reports: TestReport[] }> {
    const byRoot = new Map<string, string[]>();
    for (const f of files) {
      if (!/\.luau?$/i.test(f) || !fs.existsSync(f)) continue;
      const root = projectRoot(f);
      if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), path.resolve(f)]);
    }
    const reports: TestReport[] = [];
    let ran = false;
    for (const [root, mine] of byRoot) {
      if (!this.options.enabled("tests", this.options.placeOf(root))) continue;
      ran = true;
      if (!hasSpecs(root)) continue;
      const report = await this.execute(root, mine);
      // an edit no spec reaches has nothing to say
      if (report.rows.length || report.error) reports.push(report);
    }
    return { ...(byRoot.size && !ran ? { disabled: true } : {}), reports };
  }

  /** When a play starts: every spec of the place's folder (or of the worktree that plays) */
  async beforePlay(placeId: string, folder?: string): Promise<{ disabled?: boolean; report?: TestReport }> {
    if (!this.options.enabled("playTests", placeId)) return { disabled: true };
    const root = folder ?? this.options.places()[placeId]?.folder;
    if (!root || !hasSpecs(root)) return {};
    return { report: await this.execute(root) };
  }

  stop(): void {
    this.pool.stop();
  }
}

/** Whether a project has specs; a tests/ that cannot be read counts, so its run says why */
function hasSpecs(root: string): boolean {
  try {
    return findSpecs(root).length > 0;
  } catch {
    return true;
  }
}
