import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { BUNDLED } from "../bundled.js";
import type { ResidentAnswer, ResidentRequest } from "./resident.js";

/**
 * The hub's side of the resident analysis: one worker thread (worker.ts), started on the first
 * run and stopped after a while with no run, which frees the parses it keeps (~340 MB for a
 * place the size of the Astral). Runs queue in the worker one at a time.
 */
export interface AnalysisServiceOptions {
  /** The worker's file; default: next to this one (analysis-worker.mjs in the app's bundle) */
  workerFile?: string;
  /** Stop the worker after this long with no run (default 10 minutes) */
  idleMs?: number;
  log?: (line: string) => void;
}

export function defaultWorkerFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return BUNDLED ? path.join(here, "analysis-worker.mjs") : path.join(here, "worker.js");
}

interface Waiting {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class AnalysisService {
  private worker?: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private idleTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: AnalysisServiceOptions = {}) {}

  /** Whether the worker is running (holding parses) */
  get loaded(): boolean {
    return !!this.worker;
  }

  run(request: ResidentRequest, timeoutMs = 60_000): Promise<ResidentAnswer> {
    return this.send({ request }, timeoutMs);
  }

  /** Forgets one project's parses (its place was unregistered), or every one */
  drop(root?: string): Promise<void> {
    if (!this.worker) return Promise.resolve();
    return this.send({ drop: root ?? true }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    this.terminate("the hub is stopping");
  }

  private send(message: object, timeoutMs: number): Promise<any> {
    if (this.stopped) return Promise.reject(new Error("the hub is stopping"));
    const worker = this.ensure();
    const id = this.nextId++;
    this.touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // a run that never ends would hold every later one: the worker starts over
        this.waiting.delete(id);
        reject(new Error(`the analysis took over ${Math.round(timeoutMs / 1000)} s`));
        this.terminate("a run timed out");
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ id, ...message });
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerFile ?? defaultWorkerFile());
    worker.unref();
    worker.on("message", (m: { id: number; ok: boolean; answer?: unknown; error?: string }) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.ok) w.resolve(m.answer);
      else w.reject(new Error(m.error ?? "the analysis failed"));
      this.touch();
    });
    worker.on("error", (error) => {
      this.options.log?.(`Analysis thread failed: ${error.message}`);
      this.terminate(error.message);
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.terminate("the analysis thread exited");
    });
    this.worker = worker;
    return worker;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.waiting.size) this.terminate();
    }, this.options.idleMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }

  private terminate(why?: string): void {
    const worker = this.worker;
    this.worker = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const w of this.waiting.values()) w.reject(new Error(why ?? "the analysis thread stopped"));
    this.waiting.clear();
    void worker?.terminate();
  }
}
