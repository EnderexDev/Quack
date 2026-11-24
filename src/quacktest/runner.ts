import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { Engine } from "./lune.js";
import type { PresentScript, SpecFile, TreeSource } from "./project.js";

/**
 * One Lune process of the runtime (runtime/main.luau): it loads the tree, says it is ready, runs
 * the one request it is sent and exits. Started ahead of time it is a standby (the hub's pool),
 * so a run does not wait for the tree; started and fed at once it is a plain run (the CLI with no
 * hub). Its stdin is a pipe: when this process goes, the pipe closes and Lune exits on its own.
 */
export interface Ready {
  ms: number;
  instances: number;
  scripts: number;
  built: boolean;
}

export interface RunRequest {
  root: string;
  specs: SpecFile[];
  setup?: { file: string; rel: string };
  filter?: string[];
  present?: PresentScript[];
  testTimeout?: number;
  waitTimeout?: number;
}

/** A failure as the runtime reports it */
export interface RawFailure {
  message: string;
  expect?: boolean;
  timeout?: boolean;
  line?: number;
  where?: string;
  output?: string[];
  threads?: string[] | Record<string, never>;
}

export interface RawTest {
  name: string;
  ok: boolean;
  ms: number;
  failure?: RawFailure;
  output?: string[] | Record<string, never>;
  threads?: string[] | Record<string, never>;
}

export interface RawResult {
  specs: { rel: string; name: string; load?: RawFailure; tests: RawTest[] | Record<string, never> }[] | Record<string, never>;
  setup?: { rel: string; ok: boolean; failure?: RawFailure; output?: string[] | Record<string, never>; threads?: string[] | Record<string, never> };
  ms: number;
  crashed?: string;
}

/** Processes started by this one: part of each one's temporary file name */
let started = 0;

const READY = "@@quacktest-ready@@ ";
const RESULT = "@@quacktest-result@@ ";
/** A test (or the setup, or a spec's load) finished */
const PROGRESS = "@@quacktest-progress@@";
/** A line of the runtime is never this long; anything longer is the game's and is dropped */
const MAX_LINE = 64 * 1024 * 1024;

/** Lune writes an empty table as {}: a list either way */
export const list = <T>(value: T[] | Record<string, never> | undefined): T[] => (Array.isArray(value) ? value : []);

export class LuneProcess {
  readonly ready: Promise<Ready>;
  private readonly child: ChildProcess;
  /** The pieces of the line not finished yet, and their length; every finished line is read once and dropped */
  private parts: string[] = [];
  private partLength = 0;
  /** It said it was ready (its tree loaded): a failure after this is not the tree's */
  private readied = false;
  /** This process stopped it (kill, the silence limit): an exit then is not the runtime's own */
  private killed = false;
  /** A line past MAX_LINE came: the answer, if it was that line, is lost and the run says why */
  private overflowed = false;
  private stderr = "";
  private exited = false;
  /** Why it exited, for a run asked after that */
  private exitError?: Error;
  private onResult?: (result: RawResult) => void;
  private onExit?: (error: Error) => void;
  /** A line of the runtime came (ready, a test done): the run is alive */
  private onProgress?: () => void;
  private used = false;

  constructor(engine: Engine, tree: TreeSource, options: { waitTimeout?: number } = {}) {
    // tmp: this process's own name for the tree it may build, never another's
    const boot = JSON.stringify({ tree: { source: tree.source, cache: tree.cache }, waitTimeout: options.waitTimeout ?? 2, tmp: `${process.pid}-${++started}-${Math.random().toString(36).slice(2, 8)}` });
    this.child = spawn(engine.lune, ["run", engine.main, boot], {
      cwd: engine.dir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.child.stdin!.on("error", () => {});
    let readyResolve!: (r: Ready) => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // never an unhandled rejection: the caller awaits it when it uses this process
    this.ready.catch(() => {});
    let isReady = false;
    let result: RawResult | undefined;
    const line = (text: string) => {
      if (text.startsWith(READY) && !isReady) {
        isReady = true;
        this.readied = true;
        this.onProgress?.();
        try {
          readyResolve(JSON.parse(text.slice(READY.length)));
        } catch (error) {
          readyReject(error as Error);
        }
      } else if (text.startsWith(PROGRESS)) {
        this.onProgress?.();
      } else if (text.startsWith(RESULT)) {
        try {
          result = JSON.parse(text.slice(RESULT.length));
        } catch (error) {
          this.onExit?.(new Error(`the runtime's answer is not JSON (${(error as Error).message})`));
          return;
        }
        const done = this.onResult;
        this.onResult = undefined;
        done?.(result!);
      }
    };
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      // only the runtime's own lines matter (the game's prints stay inside it): the pieces of an
      // unfinished line are kept apart and joined once, when its end comes (the answer is one long
      // line), and a line past a size no runtime line reaches is dropped
      let from = 0;
      for (let at = chunk.indexOf("\n"); at >= 0; at = chunk.indexOf("\n", from)) {
        this.parts.push(chunk.slice(from, at));
        const whole = this.parts.join("");
        this.parts = [];
        this.partLength = 0;
        line(whole.replace(/\r$/, ""));
        from = at + 1;
      }
      if (from < chunk.length) {
        this.parts.push(chunk.slice(from));
        this.partLength += chunk.length - from;
        if (this.partLength > MAX_LINE) {
          this.parts = [];
          this.partLength = 0;
          this.overflowed = true;
        }
      }
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      if (this.stderr.length < 20_000) this.stderr += chunk;
    });
    const gone = (why: string) => {
      if (this.exited) return;
      this.exited = true;
      const reason = this.overflowed ? `${why}: its answer was over ${MAX_LINE / 1024 / 1024} MB (run fewer specs, or --filter)` : why;
      const error = new Error(`${reason}${this.stderr.trim() ? `: ${tail(this.stderr)}` : ""}`);
      this.exitError = error;
      if (!isReady) readyReject(error);
      this.onExit?.(error);
    };
    this.child.on("error", (error) => gone(`Lune could not start (${error.message})`));
    // close, not exit: it comes once stdout is read to its end, so the answer is never lost
    this.child.on("close", (code) => gone(`Lune exited (code ${code})`));
  }

  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether it got as far as its tree loaded */
  get loaded(): boolean {
    return this.readied;
  }

  /** It exited by itself (a crash, a tree it could not read), not stopped by this process */
  get exitedAlone(): boolean {
    return this.exited && !this.killed;
  }

  /**
   * Sends the request and waits for its answer; a process runs one request only. `idleMs` is how
   * long the run may go with no sign of life (the tree's load, then each test's end): a run of
   * many tests takes as long as they need, and a process stuck anywhere, its load included, is
   * stopped
   */
  run(request: RunRequest, idleMs: number): Promise<RawResult> {
    if (this.used) return Promise.reject(new Error("a Quack Test process runs one request"));
    this.used = true;
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise<RawResult>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(timer);
        this.onProgress = undefined;
        this.onResult = undefined;
        this.onExit = undefined;
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish();
          this.kill();
          reject(new Error(`the run showed no progress for ${Math.round(idleMs / 1000)} s and was stopped`));
        }, idleMs);
      };
      arm();
      this.onProgress = arm;
      this.onResult = (result) => {
        finish();
        resolve(result);
      };
      this.onExit = (error) => {
        finish();
        reject(error);
      };
      // it may have gone between the check above and these handlers
      if (this.exitError) return this.onExit(this.exitError);
      this.ready.then(
        () => {
          if (!this.exited) this.child.stdin!.write(`${JSON.stringify(request)}\n`);
        },
        () => {},
      );
    });
  }

  kill(): void {
    if (this.exited) return;
    this.killed = true;
    this.child.stdin!.end();
    this.child.kill();
  }
}

function tail(text: string): string {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-6).join(" | ");
}

/** The kept tree was read: its time, and its index's, is its last use (pruneTrees drops the ones not used) */
export function touch(file: string | undefined): void {
  if (!file) return;
  const now = new Date();
  for (const f of [file, `${file}.index.json`]) {
    try {
      fs.utimesSync(f, now, now);
    } catch {
      // not written (a full disk): the next run builds it
    }
  }
}
