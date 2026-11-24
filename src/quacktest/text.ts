/**
 * A Quack Test report as text, apart from report.ts so the review hook (review.mjs, which runs
 * after every edit and stays small) shows the same lines as `quack test` without loading the
 * analyzer.
 */
export type TestStatus = "passed" | "failed" | "notRun";

export interface TestRow {
  /** The spec's file, from the project folder */
  spec: string;
  /** The test's name; null when the spec itself (or setup.luau) did not load */
  test: string | null;
  status: TestStatus;
  /** The spec's line the failure went through */
  line?: number;
  /** The innermost script line it came from (a game module's file:line) */
  where?: string;
  message?: string;
  /** Why it did not run outside Studio */
  reason?: string;
  /** What the game printed during the test, and errors of threads it started */
  output?: string[];
  ms?: number;
}

export interface TestReport {
  root: string;
  rows: TestRow[];
  stats: {
    passed: number;
    failed: number;
    notRun: number;
    specs: number;
    ms: number;
    /** Which tree the specs ran against */
    tree: string;
    /** Whether a standby had the tree ready (the hub) or this run loaded it */
    warm?: boolean;
  };
  /** Why nothing ran (no specs is not an error: rows is empty and this says so) */
  note?: string;
  error?: string;
}

/** Whether the command exits 1: a failure, a test that did not run, or a run that could not happen */
export function reportFailed(r: TestReport): boolean {
  return !!r.error || r.stats.failed > 0 || r.stats.notRun > 0;
}

const n = (x: number, word: string) => `${x} ${word}${x === 1 ? "" : "s"}`;

/** A test's line: the spec's file:line, what happened, and the innermost script line it came from */
export function rowLine(t: TestRow): string {
  const at = `${t.spec}${t.line !== undefined ? `:${t.line}` : ""}`;
  const name = t.test === null ? (t.spec.endsWith("setup.luau") ? "setup.luau did not load" : "the spec did not load") : t.test;
  if (t.status === "passed") return `${at}  passed  ${name}${t.ms !== undefined ? ` (${t.ms} ms)` : ""}`;
  const inner = t.where && !at.startsWith(t.where) ? ` (${t.where})` : "";
  const what = t.status === "notRun" ? `did not run outside Studio  ${name}: ${t.reason}` : `failed  ${name}: ${t.message}`;
  return `${at}  ${what}${inner}`;
}

/** The summary line: how many passed, failed and did not run, and against which tree */
export function summaryLine(r: TestReport): string {
  const s = r.stats;
  const total = s.passed + s.failed + s.notRun;
  const parts = [`${s.passed} passed`, `${s.failed} failed`, `${s.notRun} did not run outside Studio`];
  return `${parts.join(", ")}: ${n(total, "test")} in ${n(s.specs, "spec")}, ${(s.ms / 1000).toFixed(1)} s, ${s.tree}${s.warm === false ? " (tree loaded for this run)" : ""}.`;
}

/** One line per test that failed or did not run, then the summary; verbose lists every test and what each printed */
export function reportText(r: TestReport, verbose = false): string {
  const lines: string[] = [];
  if (r.error) lines.push(`Quack Test could not run: ${r.error}`);
  for (const t of r.rows) {
    if (t.status === "passed" && !verbose) continue;
    lines.push(rowLine(t));
    if (verbose) for (const o of t.output ?? []) lines.push(`    | ${o}`);
  }
  if (r.note) lines.push(r.note);
  else if (!r.error) lines.push(summaryLine(r));
  return lines.join("\n");
}

const MAX_ROWS = 20;
const QUACK_TEST = "`quack test`";

/**
 * What an AI reads after its edit (the review hook): what the specs the edit reaches say, a line
 * when they all passed; "" when it reached none
 */
export function editText(reports: TestReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    if (r.error) {
      lines.push(`Quack Test could not run the specs this edit reaches: ${r.error}`);
      continue;
    }
    if (!r.rows.length) continue;
    const bad = r.rows.filter((t) => t.status !== "passed");
    if (!bad.length) {
      lines.push(`Quack Test: the ${n(r.stats.passed, "test")} of the ${n(r.stats.specs, "spec")} this edit reaches passed (${(r.stats.ms / 1000).toFixed(1)} s).`);
      continue;
    }
    lines.push(`Quack Test, the specs this edit reaches: ${summaryLine(r)}`, ...bad.slice(0, MAX_ROWS).map(rowLine));
    if (bad.length > MAX_ROWS) lines.push(`(${bad.length - MAX_ROWS} more: ${QUACK_TEST} lists every one)`);
    lines.push("Fix what this edit broke. A test that did not run outside Studio needs a piece of the play: tests/setup.luau can make it, or test it in a playtest.");
  }
  return lines.join("\n");
}

/** The warning when a play starts with specs that do not pass; "" when they all pass. It never stops the play */
export function playText(r: TestReport): string {
  if (r.error) return `Quack Test could not run before this play: ${r.error}`;
  const bad = r.rows.filter((t) => t.status !== "passed");
  if (!bad.length) return "";
  return [`Quack Test before this play: ${summaryLine(r)}`, ...bad.slice(0, MAX_ROWS).map(rowLine), `The play started anyway; ${QUACK_TEST} runs them again.`].join("\n");
}
