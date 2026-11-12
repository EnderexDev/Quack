import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { projectRoot } from "../analyze/command.js";
import { loadRegistry } from "../hub/registry.js";
import { ResidentAnalysis } from "./resident.js";
import { autoEnabled, flavorFile, readAutoSettings } from "./settings.js";

const run = promisify(execFile);

/**
 * The pre-commit check (his call, 12/11/26, off until turned on): a git hook that stops a commit
 * whose Luau files have findings. Quack installs it in the repository of each registered place
 * whose check is on and takes it out when the check goes off; an existing pre-commit is kept and
 * runs first (pre-commit.before-quack). The hook lets the commit through whenever Quack cannot
 * answer: no node, no Quack, an error of its own. Only a finding stops it, with exit code 9.
 *
 * It analyzes the files as they are on disk, not the staged copy: a file staged and then edited
 * again is checked as edited. `git commit --no-verify` skips it once; `-- quack: allow(rule)`
 * silences a finding left on purpose.
 */
export const FINDINGS_EXIT = 9;
const MARK = "# quack-precommit";
const CHAINED = "pre-commit.before-quack";

export interface PrecommitEntry {
  /** node, and the CLI (cli.mjs in the app, dist/control/main.js from the repo) */
  node: string;
  cli: string;
  flavor: "official" | "dev";
}

export type HookStatus = "installed" | "not installed" | "not a git repository" | "core.hooksPath is set" | "another Quack's" | "failed";

export function hookScript(entry: PrecommitEntry): string {
  const q = (s: string) => `"${s.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
  return [
    "#!/bin/sh",
    `${MARK} ${entry.flavor}`,
    `# Quack's pre-commit check: put here by ${entry.flavor === "official" ? "Quack" : "Quack Dev"} and taken out when its setting is off.`,
    "# It stops a commit only when the Luau files of the commit have findings (git commit --no-verify skips it).",
    'here="$(dirname "$0")"',
    `if [ -x "$here/${CHAINED}" ]; then "$here/${CHAINED}" "$@" || exit $?; fi`,
    `node_bin=${q(entry.node)}`,
    `cli=${q(entry.cli)}`,
    '[ -x "$node_bin" ] || node_bin="$(command -v node)" || exit 0',
    '[ -n "$node_bin" ] && [ -f "$cli" ] || exit 0',
    `"$node_bin" "$cli" --flavor ${entry.flavor} precommit`,
    `[ $? -eq ${FINDINGS_EXIT} ] && exit 1`,
    "exit 0",
    "",
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 15_000 });
  return stdout.trim();
}

/** The repository's hooks folder, or why there is none Quack may write */
async function hooksDir(folder: string): Promise<{ dir?: string; status?: HookStatus }> {
  try {
    await git(folder, ["rev-parse", "--git-dir"]);
  } catch {
    return { status: "not a git repository" };
  }
  // a hooks folder of the project's own (husky, .githooks) is committed: Quack does not write there
  const hooksPath = await git(folder, ["config", "--get", "core.hooksPath"]).catch(() => "");
  if (hooksPath) return { status: "core.hooksPath is set" };
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { dir: path.join(common, "hooks") };
}

/** The repository a folder's hook goes in (its common git dir: every worktree shares its hooks), or undefined when it is not one */
export async function hooksRepository(folder: string): Promise<string | undefined> {
  try {
    return await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return undefined;
  }
}

/** Puts the hook in (on) or takes it out (off); whatever else is there stays */
export async function setPrecommitHook(folder: string, on: boolean, entry: PrecommitEntry): Promise<HookStatus> {
  const where = await hooksDir(folder);
  if (!where.dir) return where.status!;
  const file = path.join(where.dir, "pre-commit");
  const chained = path.join(where.dir, CHAINED);
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // none yet
  }
  const ours = current?.includes(`${MARK} ${entry.flavor}`) ?? false;
  const otherQuack = !ours && (current?.includes(MARK) ?? false);
  if (otherQuack) return "another Quack's";
  if (!on) {
    if (!ours) return "not installed";
    fs.rmSync(file, { force: true });
    if (fs.existsSync(chained)) fs.renameSync(chained, file);
    return "not installed";
  }
  const script = hookScript(entry);
  if (ours && current === script) return "installed";
  fs.mkdirSync(where.dir, { recursive: true });
  // the project's own hook keeps running, first
  if (current !== null && !ours) fs.renameSync(file, chained);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return "installed";
}

export interface PrecommitContext {
  cwd: string;
  out: (line: string) => void;
  /** The hub's answer for these files, or null when no hub answers */
  ask: (files: string[]) => Promise<{ disabled?: boolean; findings: Finding[]; elsewhere?: Finding[] } | null>;
  /** This flavor's registry file (the setting and the place, when the hub is down) */
  registry: string;
}

interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

/** A path with its junctions and short names resolved (itself when it does not exist) */
function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** `quack precommit`: the check the hook runs; 9 when the commit's Luau files have findings, else 0 */
export async function runPrecommit(ctx: PrecommitContext): Promise<number> {
  try {
    // git names the real folder: a project reached through a junction or a short 8.3 name
    // (C:\Users\RUNNER~1) is compared by its real path, or no staged file would be its own
    const found = projectRoot(ctx.cwd);
    if (!found) return 0;
    const root = real(found);
    const top = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
    const staged = (await git(ctx.cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])).split("\0").filter(Boolean);
    const files = staged.map((f) => real(path.resolve(top, f))).filter((f) => {
      const own = /\.luau?$/i.test(f) && fs.existsSync(f) ? projectRoot(f) : null;
      return !!own && real(own).toLowerCase() === root.toLowerCase();
    });
    if (!files.length) return 0;
    let answer = await ctx.ask(files).catch(() => null);
    if (!answer) answer = await offline(root, files, ctx.registry);
    if (!answer || answer.disabled || !answer.findings.length) return 0;
    ctx.out(`Quack's pre-commit check found ${answer.findings.length} in the Luau files of this commit:`);
    for (const f of answer.findings) ctx.out(`  ${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.message}`);
    ctx.out("Fix them, or silence one left on purpose with `-- quack: allow(<rule>)` on its line or the one above.");
    ctx.out("`git commit --no-verify` skips the check once; Quack's settings turn it off.");
    return FINDINGS_EXIT;
  } catch (error) {
    ctx.out(`Quack's pre-commit check could not run (${(error as Error).message}): the commit goes on.`);
    return 0;
  }
}

/** With no hub: the setting from its file, and one analysis in this process */
async function offline(root: string, files: string[], registryFile: string) {
  const places = loadRegistry(registryFile).places;
  const placeId = Object.entries(places).find(([, p]) => real(p.folder).toLowerCase() === real(root).toLowerCase())?.[0];
  if (!autoEnabled(readAutoSettings(flavorFile(registryFile, "automation")), "precommit", placeId)) return { disabled: true, findings: [] };
  const answer = await new ResidentAnalysis().run({ root, files, placeFolders: Object.values(places).map((p) => p.folder) });
  return { findings: answer.findings.map((f) => ({ ...f, file: path.relative(root, f.file).replace(/\\/g, "/") })) };
}
