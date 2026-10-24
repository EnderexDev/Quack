import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "scripts", "dev-version.mjs");
// A path in a variable: the .mjs is plain JS, outside the TypeScript project
const devVersion = await import(pathToFileURL(script).href);

// 21/10/26: the channel published 1.0.6 while 1.0.34 was installed; the updater never offered it
test("the next Dev version is above every version seen, compared as numbers", () => {
  assert.equal(devVersion.nextVersion(["1.0.6", "1.0.34", "1.0.9"]), "1.0.35");
  assert.equal(devVersion.nextVersion(["1.0.6", undefined, "junk"]), "1.0.7");
  assert.equal(devVersion.nextVersion(["1.2.0", "1.10.0"]), "1.10.1");
  assert.equal(devVersion.nextVersion([]), "1.0.0");
});

test("an explicit version at or below the highest one is caught", () => {
  assert.equal(devVersion.compareVersions("1.0.6", "1.0.34"), -1);
  assert.equal(devVersion.compareVersions("1.0.34", "1.0.34"), 0);
  assert.equal(devVersion.compareVersions("1.0.35", "1.0.34"), 1);
});

test("a worktree with a non-ASCII path is listed as it is on disk", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "quack-wt-"));
  const repo = path.join(base, "repo");
  const tree = path.join(base, "árvore");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    git(repo, "worktree", "add", "-q", "--detach", tree);
    // .native: the JS realpath keeps an 8.3 temp folder (RUNNER~1 on CI) that git prints long
    const listed = (devVersion.worktrees(repo) as string[]).map((p) => fs.realpathSync.native(p));
    assert.ok(listed.includes(fs.realpathSync.native(tree)), listed.join(" | "));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("built installers are found in every Cargo target folder, Quack Dev only", () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "quack-devver-"));
  try {
    const nsis = (target: string) => path.join(checkout, "app", "src-tauri", target, "release", "bundle", "nsis");
    fs.mkdirSync(nsis("target"), { recursive: true });
    fs.mkdirSync(nsis("target-t3"), { recursive: true });
    // A build with an explicit --target lands under target/<triple>/release
    fs.mkdirSync(nsis("target/x86_64-pc-windows-msvc"), { recursive: true });
    fs.writeFileSync(path.join(nsis("target/x86_64-pc-windows-msvc"), "Quack Dev_1.0.40_x64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis("target"), "Quack Dev_1.0.8_x64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis("target-t3"), "Quack Dev_1.0.21_x64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis("target"), "Quack_1.0.99_x64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis("target-t3"), "Quack Dev_1.0.41_arm64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis("target-t3"), "Quack Dev_1.0.42_x86-setup.exe"), "");
    assert.deepEqual(devVersion.builtVersions(checkout).sort(), ["1.0.21", "1.0.40", "1.0.41", "1.0.42", "1.0.8"]);
    assert.deepEqual(devVersion.builtVersions(path.join(checkout, "missing")), []);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
