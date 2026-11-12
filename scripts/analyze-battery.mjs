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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { analyzeProject } = await import(pathToFileURL(path.join(repo, "dist/analyze/analyze.js")).href);
const { projectFileOf, treeFromProject } = await import(pathToFileURL(path.join(repo, "dist/analyze/project.js")).href);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
/** Flags that take a value: the argument after one of them is not the folder */
const VALUED = new Set(["--limit", "--grep", "--json", "--sync", "--sourcemap"]);
const project = path.resolve(args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1])) ?? ".");
const limit = Number(flag("limit", "200"));
const all = args.includes("--all");
/** Words a fix's message carries, in English and Portuguese */
const FIX = new RegExp(flag("grep", "\\b(fix(es|ed)?|bug|crash(es)?|broke(n)?|regress\\w*|error|nil|wrong|corrig\\w*|conserta\\w*|arruma\\w*|quebr\\w*)\\b"), "i");
const sourcemap = path.resolve(project, flag("sourcemap", "sourcemap.json"));

const git = (...a) => execFileSync("git", ["-c", "core.quotepath=off", "-C", project, ...a], { encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
/** The scripts' folder in the repository: sync/ in a Quack project, src/ (or another) in a Rojo one */
// as git writes paths: forward slashes, no "./" in front, no "/" at the end; "." (the whole repository) is ""
const NORMAL = path.posix.normalize(flag("sync", "sync").replace(/\\/g, "/")).replace(/\/$/, "");
// only a literal "./" in front, or "." alone, goes: a folder may start with a dot (".sync")
const SYNC = NORMAL === "." ? "" : NORMAL.replace(/^\.\//, "");
const SCRIPT = new RegExp(`^${SYNC ? `${SYNC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/` : ""}.*\\.luau?$`);
/** The pathspec git takes for it */
const SPEC = SYNC || ".";

/** sha, parent, subject of the commits that changed a script, newest first (merges left out) */
const commits = git("log", "--no-merges", "--format=%H %P%x09%s", "-n", String(limit * 20), "--", SPEC)
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
  for (const line of git("diff", "-U0", c.parent, c.sha, "--", SPEC).split("\n")) {
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

/**
 * The tree each commit is read against. A Rojo project (a project file at the root, and no
 * --sourcemap given) has its tree in the repository: each commit's own, read from its own
 * project file, so an instance renamed later is not a "missing child" in an older commit. A
 * game Quack syncs keeps its tree in Studio, not in git: the sourcemap of today stands for every
 * commit, and the missing-child findings of old commits say little
 */
/** The folder's sourcemap.json is the one Quack's daemon writes (Studio's tree, stamped with the place) */
function studioSourcemap(dir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, "sourcemap.json"), "utf8"));
    return !!(json?._quack?.placeId ?? json?._azul?.placeId);
  } catch {
    return false;
  }
}
// a game Quack syncs (a sync folder, as `quack analyze` tells, or the daemon's sourcemap) that also has
// a project file keeps Studio's tree, which no project file holds; a worktree of it has no sourcemap at all
const synced = fs.existsSync(path.join(project, "sync")) || studioSourcemap(project);
const perCommitTree = flag("sourcemap") === undefined && !!projectFileOf(project) && !synced;
if (perCommitTree) process.stderr.write(`tree: each commit's own, from ${path.basename(projectFileOf(project))}\n`);

/** One commit's files into dir, streamed from git archive into tar (nothing held whole in memory) */
function extract(sha, dir) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    // a per-commit tree needs every folder the project file names, not only the scripts'
    const git = spawn("git", ["-C", project, "archive", "--format=tar", sha, perCommitTree ? "." : SPEC], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    // from inside the folder, through stdin: a "C:" path reads as a remote host to GNU tar
    const tar = spawn("tar", ["-xf", "-"], { cwd: dir, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    git.stdout.pipe(tar.stdin);
    git.on("error", reject);
    tar.on("error", reject);
    // either may close first: wait for both exit codes
    const closed = (child) => new Promise((done) => child.on("close", done));
    Promise.all([closed(git), closed(tar)]).then(([gitCode, tarCode]) =>
      gitCode === 0 && tarCode === 0 ? resolve() : reject(new Error(`extracting ${sha}: git ${gitCode}, tar ${tarCode}`)),
    );
  });
}

/** Commits whose project file could not be read: no tree, so no instance path is checked there */
let treeless = 0;

async function findings(root, files) {
  let r;
  if (perCommitTree) {
    const tree = await treeFromProject(root);
    if (!tree) treeless++;
    r = analyzeProject(root, { files, syncDir: SYNC || ".", ...(tree ? { tree } : { sourcemap: path.join(root, "no-sourcemap.json") }) });
  } else r = analyzeProject(root, { files, syncDir: SYNC || ".", sourcemap: fs.existsSync(sourcemap) ? sourcemap : undefined });
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
    await extract(c.parent, before);
    await extract(c.sha, after);
    const files = [...hunks.keys()];
    const was = await findings(before, files.filter((f) => fs.existsSync(path.join(before, f))).map((f) => path.join(before, f)));
    const key = (f) => `${f.file}|${f.rule}|${f.message}`;
    const tally = (list) => list.reduce((m, f) => m.set(key(f), (m.get(key(f)) ?? 0) + 1), new Map());
    const counted = tally(was);
    const remaining = tally(await findings(after, files.filter((f) => fs.existsSync(path.join(after, f))).map((f) => path.join(after, f))));
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
const summary = { project, commits: checked, mode: all ? "every commit" : "fixes", tree: perCommitTree ? "each commit's project file" : fs.existsSync(sourcemap) ? "today's sourcemap" : "the sync folder (no sourcemap: no instance path checked)", treeless, caught: caught.length, commitsCaught: new Set(caught.map((c) => c.sha)).size, byRule, findings: caught };
const out = flag("json");
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`${checked} ${all ? "commits" : "fix commits"} read; ${summary.commitsCaught} had a finding in the lines they fixed, gone after (${caught.length} findings); tree: ${summary.tree}${treeless ? `, ${treeless} side(s) with no readable project file (no paths checked there)` : ""}`);
console.log(JSON.stringify(byRule));
for (const f of caught) console.log(`${f.sha} ${f.file}:${f.line} ${f.rule} ${f.message}  | ${f.subject.slice(0, 70)}`);
