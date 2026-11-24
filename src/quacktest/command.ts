import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../analyze/command.js";
import { executeTests } from "./execute.js";
import { reportFailed, reportText, type TestReport } from "./report.js";

/**
 * `quack test` (and the MCP tool `test`): the specs of tests/ run in Lune against the place's
 * tree, with no Studio. The hub runs them when it is up (its process has the tree loaded
 * already); with no hub this process starts Lune for the run. Exit 0 when every test passed, 1
 * when one failed, did not run outside Studio, or the run could not happen.
 */
export interface TestCommand {
  cwd: string;
  /** The project folder; default: found from the first file or the cwd */
  root?: string;
  /** Spec files to run, or scripts whose specs to run; none: every spec */
  files: string[];
  filter?: string;
  /** Seconds one test may take (default 10) */
  testTimeout?: number;
  json: boolean;
  verbose: boolean;
  out: (line: string) => void;
  /** Asks the hub to run it; resolves null when there is no hub (or one too old to know /api/test) */
  hub?: (body: { root: string; files: string[]; filter?: string[]; testTimeout?: number }) => Promise<TestReport | null>;
  /** The registered places' folders, for a worktree's sourcemap when the run is local */
  placeFolders?: () => Promise<string[]>;
}

function resolveFile(file: string, root: string, cwd: string): string {
  if (path.isAbsolute(file)) return file;
  for (const base of [cwd, root, path.join(root, "sync")]) {
    const p = path.resolve(base, file);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(cwd, file);
}

export async function runTestCommand(c: TestCommand): Promise<number> {
  const start = c.root ? path.resolve(c.cwd, c.root) : c.files[0] ? path.resolve(c.cwd, c.files[0]) : c.cwd;
  const root = c.root ? path.resolve(c.cwd, c.root) : projectRoot(start);
  if (!root) {
    const message = `No sync folder or readable project file at or above ${start}: run it inside a synced project, or pass --path <project folder>.`;
    c.out(c.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  const files = c.files.map((f) => resolveFile(f, root, c.cwd));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    const message = `Not found: ${missing.join(", ")}`;
    c.out(c.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  if (c.testTimeout !== undefined && !(c.testTimeout > 0 && c.testTimeout <= 600)) {
    const message = "--timeout is each test's limit in seconds: above 0, 600 at most";
    c.out(c.json ? JSON.stringify({ error: message }) : message);
    return 1;
  }
  const filter = c.filter ? c.filter.split(",").map((f) => f.trim()).filter(Boolean) : undefined;
  let report: TestReport | null = null;
  if (c.hub) {
    // null: no hub, or one too old for this; any other error of the hub is the answer, never
    // run a second time here (a timeout means the hub is still running it)
    try {
      report = await c.hub({ root, files, ...(filter ? { filter } : {}), ...(c.testTimeout ? { testTimeout: c.testTimeout } : {}) });
    } catch (error) {
      report = { root, rows: [], stats: { passed: 0, failed: 0, notRun: 0, specs: 0, ms: 0, tree: "" }, error: `the hub could not run it: ${(error as Error).message}` };
    }
  }
  report ??= await executeTests({ root, files, filter, placeFolders: c.placeFolders, testTimeout: c.testTimeout });
  c.out(c.json ? JSON.stringify(report, null, 2) : reportText(report, c.verbose));
  return reportFailed(report) ? 1 : 0;
}
