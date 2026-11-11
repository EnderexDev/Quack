// The analyzer against a game's own fixes: for each commit of the repository that looks like a
// fix (its message), the scripts it changed are analyzed as they were before it and after it. A
// finding before the fix, inside the lines the fix changed, that is gone after it, is a bug the
// rule would have caught. Works on any synced project's repository; reads git only (log, diff,
// archive into a temporary folder), never checks anything out.
//
//   node scripts/analyze-battery.mjs <project folder> [--limit 200] [--all] [--grep <regex>] [--json <out>]
//
// --all takes every commit that changed a script, not only the fixes. The place's tree is the
// current sourcemap (git does not keep it): an old commit's paths may differ from it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { analyzeProject } = await import(pathToFileURL(path.join(repo, "dist/analyze/analyze.js")).href);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
/** Flags that take a value: the argument after one of them is not the folder */
const VALUED = new Set(["--limit", "--grep", "--json"]);
const project = path.resolve(args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1])) ?? ".");
const limit = Number(flag("limit", "200"));
const all = args.includes("--all");
/** Words a fix's message carries, in English and Portuguese */
const FIX = new RegExp(flag("grep", "\\b(fix(es|ed)?|bug|crash(es)?|broke(n)?|regress\\w*|error|nil|wrong|corrig\\w*|conserta\\w*|arruma\\w*|quebr\\w*)\\b"), "i");
const sourcemap = path.join(project, "sourcemap.json");

const git = (...a) => execFileSync("git", ["-c", "core.quotepath=off", "-C", project, ...a], { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
const SCRIPT = /^sync\/.*\.luau?$/;

/** sha, parent, subject of the commits that changed a script, newest first (merges left out) */
const commits = git("log", "--no-merges", "--format=%H %P%x09%s", "-n", String(limit * 20), "--", "sync")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [head, subject] = l.split("\t");
    const [sha, parent] = head.split(" ");
    return { sha, parent, subject };
  })
  .filter((c) => c.parent && (all || FIX.test(c.subject)))
  .slice(0, limit);

/** The lines of the parent each changed file's hunks touch */
function touched(c) {
  const out = new Map();
  let file = null;
  for (const line of git("diff", "-U0", c.parent, c.sha, "--", "sync").split("\n")) {
    if (line.startsWith("--- ")) file = line.startsWith("--- a/") ? line.slice(6) : null;
    const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (m && file && SCRIPT.test(file)) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (!out.has(file)) out.set(file, []);
      // an insertion (count 0) touches the line before and after it
      out.get(file).push(count === 0 ? [start, start + 1] : [start, start + count - 1]);
    }
  }
  return out;
}

function extract(sha, dir) {
  const archive = execFileSync("git", ["-C", project, "archive", "--format=tar", sha, "sync"], { maxBuffer: 1 << 30, windowsHide: true });
  fs.mkdirSync(dir, { recursive: true });
  // through stdin, from inside the folder: a "C:" path reads as a remote host to GNU tar
  execFileSync("tar", ["-xf", "-"], { cwd: dir, input: archive, maxBuffer: 1 << 30, windowsHide: true });
}

function findings(root, files) {
  const r = analyzeProject(root, { files, sourcemap: fs.existsSync(sourcemap) ? sourcemap : undefined });
  return r.findings.map((f) => ({ file: path.relative(root, f.file).split(path.sep).join("/"), line: f.line, rule: f.rule, message: f.message }));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quack-battery-"));
const caught = [];
const byRule = {};
let checked = 0;
try {
  for (const c of commits) {
    const hunks = touched(c);
    if (!hunks.size) continue;
    checked++;
    const before = path.join(tmp, `${c.sha.slice(0, 8)}-before`);
    const after = path.join(tmp, `${c.sha.slice(0, 8)}-after`);
    extract(c.parent, before);
    extract(c.sha, after);
    const files = [...hunks.keys()];
    const was = findings(before, files.filter((f) => fs.existsSync(path.join(before, f))).map((f) => path.join(before, f)));
    const key = (f) => `${f.file}|${f.rule}|${f.message}`;
    const tally = (list) => list.reduce((m, f) => m.set(key(f), (m.get(key(f)) ?? 0) + 1), new Map());
    const counted = tally(was);
    const remaining = tally(findings(after, files.filter((f) => fs.existsSync(path.join(after, f))).map((f) => path.join(after, f))));
    // each finding alike that the fix took away: as many as fewer remain, from those in its lines
    const gone = new Map([...counted].map(([k, n]) => [k, Math.max(0, n - (remaining.get(k) ?? 0))]));
    for (const f of was) {
      const inHunk = (hunks.get(f.file) ?? []).some(([a, b]) => f.line >= a - 1 && f.line <= b + 1);
      if (!inHunk || !gone.get(key(f))) continue;
      gone.set(key(f), gone.get(key(f)) - 1);
      caught.push({ sha: c.sha.slice(0, 8), subject: c.subject, ...f });
      byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    }
    fs.rmSync(before, { recursive: true, force: true });
    fs.rmSync(after, { recursive: true, force: true });
    process.stderr.write(`\r${checked} commits, ${caught.length} caught`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.stderr.write("\n");
const summary = { project, commits: checked, mode: all ? "every commit" : "fixes", caught: caught.length, commitsCaught: new Set(caught.map((c) => c.sha)).size, byRule, findings: caught };
const out = flag("json");
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`${checked} ${all ? "commits" : "fix commits"} read; ${summary.commitsCaught} had a finding in the lines they fixed, gone after (${caught.length} findings)`);
console.log(JSON.stringify(byRule));
for (const f of caught) console.log(`${f.sha} ${f.file}:${f.line} ${f.rule} ${f.message}  | ${f.subject.slice(0, 70)}`);
