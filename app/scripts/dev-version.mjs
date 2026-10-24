// The next Quack Dev version, chosen in one place. Each session used to pick its own from a
// different source (the last published, the installed one, its own last build), and on 21/10/26
// the channel published 1.0.6 over an installed 1.0.34: the updater only offers a higher version,
// so that update never reached anyone. The next version is one above every Dev version that
// exists anywhere here: the channel's latest-dev.json, the installed app, and every installer
// built in any worktree of the repo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LATEST_DEV_URL = "https://github.com/EnderexDev/quack-releases/releases/download/dev-channel/latest-dev.json";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1, comparing two x.y.z versions */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a).slice(1).map(Number);
  const pb = SEMVER.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The highest x.y.z in the list (anything else ignored), or undefined */
export function highestVersion(versions) {
  return versions.filter((v) => typeof v === "string" && SEMVER.test(v)).sort(compareVersions).at(-1);
}

/** One patch above the highest version seen; 1.0.0 when there is none */
export function nextVersion(versions) {
  const top = highestVersion(versions);
  if (!top) return "1.0.0";
  const [major, minor, patch] = SEMVER.exec(top).slice(1).map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** Versions of the Quack Dev installers under one checkout's Cargo build folders */
export function builtVersions(checkout) {
  const tauri = path.join(checkout, "app", "src-tauri");
  let targets;
  try {
    targets = fs.readdirSync(tauri).filter((d) => d.startsWith("target"));
  } catch {
    return [];
  }
  // target*/release, and target*/<triple>/release for a build with an explicit --target
  const releases = [];
  for (const target of targets) {
    releases.push(path.join(tauri, target, "release"));
    try {
      for (const sub of fs.readdirSync(path.join(tauri, target))) releases.push(path.join(tauri, target, sub, "release"));
    } catch {
      // not a folder
    }
  }
  const found = [];
  for (const release of releases) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(release, "bundle", "nsis"));
    } catch {
      continue;
    }
    for (const file of files) {
      const m = /^Quack Dev_(\d+\.\d+\.\d+)_(?:x64|x86|arm64)-setup\.exe$/.exec(file);
      if (m) found.push(m[1]);
    }
  }
  return found;
}

/** The installed Quack Dev's version, or undefined when it is not installed */
export function installedVersion() {
  const exe = path.join(process.env.LOCALAPPDATA ?? "", "Quack Dev", "quack-app.exe");
  if (process.platform !== "win32" || !fs.existsSync(exe)) return undefined;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: "utf8" });
  return out.trim() || undefined;
}

/** Every worktree of the repo (the main checkout included) */
export function worktrees(repoRoot) {
  // -z: NUL-separated fields and unquoted paths (without it git quotes a path with non-ASCII characters)
  const out = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length));
}

/** The channel's published version; throws when it cannot be read, since guessing is how it broke */
export async function publishedVersion() {
  const response = await fetch(LATEST_DEV_URL, { redirect: "follow" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`latest-dev.json answered ${response.status}`);
  return (await response.json()).version;
}

/** Every Dev version that exists, by where it was seen */
export async function existingVersions(repoRoot) {
  const seen = { published: await publishedVersion(), installed: installedVersion(), built: [] };
  for (const checkout of worktrees(repoRoot)) seen.built.push(...builtVersions(checkout));
  return seen;
}
