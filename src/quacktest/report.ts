import { classMembers } from "../analyze/analyze.js";
import { list, type RawFailure, type RawResult } from "./runner.js";
import type { TestReport, TestRow, TestStatus } from "./text.js";

export { reportFailed, reportText, type TestReport, type TestRow, type TestStatus } from "./text.js";

/**
 * A run's answer as the user reads it. A test either passed, failed (the code or the spec is
 * wrong) or did not run outside Studio (a piece of Roblox this process does not have: a member
 * Lune lacks, a child the tree never got, a web or physics call). The last one is never a pass:
 * it is red and the command exits 1, with the missing piece named. The cause is read in the
 * whole message, so a game that wraps a module's error in its own text ("Erro ao carregar Util
 * 'X': ...") still shows the inner cause.
 */
const OUTSIDE = "[outside Studio] ";

/** Whether a failure is the code's or a piece of Roblox this run lacks, and which */
export function classify(failure: RawFailure): { status: "failed" | "notRun"; reason?: string } {
  if (failure.expect || failure.timeout) return { status: "failed" };
  const m = failure.message ?? "";
  const marked = m.indexOf(OUTSIDE);
  if (marked >= 0) return { status: "notRun", reason: m.slice(marked + OUTSIDE.length).split("\n")[0] };
  const member = /(?:^|[\s:'"(])([A-Za-z_][\w]*) is not a valid member of ([A-Za-z_]\w*)/.exec(m);
  if (member) {
    const [, name, className] = member;
    if (classMembers(className)?.has(name)) return { status: "notRun", reason: `${className}.${name} does not exist outside Studio` };
    return { status: "notRun", reason: `${className} has no child or member "${name}" in the place's tree (made during the play? make it in tests/setup.luau)` };
  }
  const property = /Failed to get property '(\w+)' - missing default value/.exec(m);
  if (property) return { status: "notRun", reason: `${property[1]} has no value outside Studio (set it in tests/setup.luau)` };
  const service = /'(\w+)' is not a valid service name/.exec(m);
  if (service) return { status: "notRun", reason: `the service ${service[1]} does not exist outside Studio` };
  const className = /'(\w+)' is not a valid class name/.exec(m);
  if (className) return { status: "notRun", reason: `Instance.new("${className[1]}"): a class Lune does not know` };
  if (/to `Instance\.(AddTag|HasTag|RemoveTag|GetTags)`/.test(m)) {
    return { status: "notRun", reason: "CollectionService's tag methods with an instance argument do not exist outside Studio (instance:AddTag(tag) does)" };
  }
  return { status: "failed" };
}

function row(spec: string, test: string | null, failure: RawFailure, extra: { output?: string[]; threads?: string[]; ms?: number }): TestRow {
  const c = classify(failure);
  const output = [...(extra.output ?? []), ...(extra.threads ?? []).map((t) => `[thread error] ${t}`)];
  return {
    spec,
    test,
    status: c.status,
    ...(failure.line !== undefined ? { line: failure.line } : {}),
    ...(failure.where ? { where: failure.where } : {}),
    message: failure.message,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(output.length ? { output } : {}),
    ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
  };
}

export function buildReport(root: string, raw: RawResult, tree: string, warm?: boolean): TestReport {
  const rows: TestRow[] = [];
  if (raw.setup && !raw.setup.ok && raw.setup.failure) {
    rows.push(row(raw.setup.rel, null, raw.setup.failure, { output: list(raw.setup.output), threads: list(raw.setup.threads) }));
  }
  const specs = list(raw.specs);
  for (const spec of specs) {
    if (spec.load) {
      rows.push(row(spec.rel, null, spec.load, { output: list(spec.load.output), threads: list(spec.load.threads) }));
      continue;
    }
    for (const t of list(spec.tests)) {
      const output = list(t.output);
      if (t.ok) rows.push({ spec: spec.rel, test: t.name, status: "passed", ms: t.ms, ...(output.length ? { output } : {}) });
      else rows.push(row(spec.rel, t.name, t.failure ?? { message: "failed" }, { output, threads: list(t.threads), ms: t.ms }));
    }
  }
  const count = (s: TestStatus) => rows.filter((r) => r.status === s).length;
  // the specs that ran something: with a filter, a spec none of whose tests matched is not one,
  // and setup.luau is never one
  const ran = new Set(rows.filter((r) => r.spec !== raw.setup?.rel).map((r) => r.spec)).size;
  return {
    root,
    rows,
    stats: { passed: count("passed"), failed: count("failed"), notRun: count("notRun"), specs: ran, ms: raw.ms, tree, ...(warm !== undefined ? { warm } : {}) },
    ...(raw.crashed ? { error: `the runtime stopped: ${raw.crashed}` } : {}),
  };
}

