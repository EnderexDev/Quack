// Builds Quack Dev at a given version and publishes it as the Dev app's update, in the
// dev-channel release of EnderexDev/quack-releases (latest-dev.json, the installer, its
// signature and the source). Installed Quack Dev apps download it in the background.
//   node app/scripts/publish-dev-update.mjs           (build and publish)
//   node app/scripts/publish-dev-update.mjs --local   (build only, to install by hand)
// The version is chosen here (dev-version.mjs): one above every Dev version published, installed
// or built in any worktree. An explicit x.y.z is still accepted, only when above all of them.
// The Official app is released by .github/workflows/release.yml, never from here.
// Signing key: %APPDATA%\quack\signing\quack-updater.key (+ .password). Needs gh logged in.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, existingVersions, highestVersion, nextVersion } from "./dev-version.mjs";
import { publicSourceZip } from "../../scripts/export-public.mjs";

const REPO = "EnderexDev/quack-releases";
const TAG = "dev-channel";
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..");
const repoRoot = path.join(appDir, "..");

const local = process.argv.includes("--local");
const asked = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (asked !== undefined && !/^\d+\.\d+\.\d+$/.test(asked)) {
  console.error("usage: publish-dev-update.mjs [x.y.z] [--local]");
  process.exit(1);
}
// One counter for every Dev build, local or published: one above every version that exists
const seen = await existingVersions(repoRoot);
const top = highestVersion([seen.published, seen.installed, ...seen.built]);
console.log(`Dev versions seen: published ${seen.published ?? "none"}, installed ${seen.installed ?? "none"}, highest built ${highestVersion(seen.built) ?? "none"}`);
if (asked !== undefined && top !== undefined && compareVersions(asked, top) <= 0) {
  console.error(`${asked} is not above ${top}, the highest Quack Dev version that exists: the updater would never offer it`);
  process.exit(1);
}
const version = asked ?? nextVersion([top]);
console.log(`building Quack Dev ${version}`);

// The source zip is HEAD: a build with uncommitted changes, or with a new file not yet in git,
// would ship a binary its source does not match (the GPL asks for the source of the binary
// itself). Only Cargo build folders (app/src-tauri/target*) may be left out of git
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim() && !/^\?\? app\/src-tauri\/target[^/]*\//.test(line))
  .join("\n");
if (dirty && !local) {
  console.error(`commit first, the published source must match the build:\n${dirty}`);
  process.exit(1);
}

const signing = path.join(process.env.APPDATA ?? "", "quack", "signing");
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(path.join(signing, "quack-updater.key"), "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.readFileSync(path.join(signing, "quack-updater.key.password"), "utf8"),
};
// Only npx needs a shell on Windows (it is a .cmd); gh and git get their arguments as they are,
// so a title with spaces stays one argument
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", ...options });
const runShell = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...options });

const override = JSON.stringify({ version, bundle: { createUpdaterArtifacts: true } });
// Through a file: a JSON argument does not survive cmd.exe's quoting
const overrideFile = path.join(appDir, "src-tauri", "target", "dev-update.conf.json");
fs.mkdirSync(path.dirname(overrideFile), { recursive: true });
fs.writeFileSync(overrideFile, override);
runShell("npx", ["@tauri-apps/cli@2", "build", "--config", overrideFile], { cwd: appDir, env });

const bundleDir = path.join(appDir, "src-tauri", "target", "release", "bundle", "nsis");
const installer = path.join(bundleDir, `Quack Dev_${version}_x64-setup.exe`);
if (!fs.existsSync(installer) || !fs.existsSync(`${installer}.sig`)) {
  console.error(`no signed installer at ${installer}`);
  process.exit(1);
}
if (local) {
  console.log(`built ${installer}`);
  process.exit(0);
}

const out = path.join(appDir, "src-tauri", "target", "dev-update");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const name = `QuackDev_${version}_x64-setup.exe`;
fs.copyFileSync(installer, path.join(out, name));
fs.copyFileSync(`${installer}.sig`, path.join(out, `${name}.sig`));
// The source of this build goes with it (GPL), as the public copy: no private files
const sourceZip = path.join(out, `quack-dev-${version}-source.zip`);
publicSourceZip(sourceZip, `quack-dev-${version}/`);
const manifest = {
  version,
  notes: `Quack Dev ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(`${installer}.sig`, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${TAG}/${name}`,
    },
  },
};
fs.writeFileSync(path.join(out, "latest-dev.json"), JSON.stringify(manifest, null, 2));

let exists = true;
try {
  execFileSync("gh", ["release", "view", TAG, "--repo", REPO], { stdio: "ignore" });
} catch {
  exists = false;
}
if (!exists) {
  // A prerelease: never "latest", so the Official app's latest/download URL never points here
  run("gh", ["release", "create", TAG, "--repo", REPO, "--prerelease", "--title", "Quack Dev (test channel)",
    "--notes", "Test builds of Quack Dev. The Official app updates from the latest release, never from this one."]);
}
// The manifest last, once its installer is there: gh uploads several files at once, and an app
// reading latest-dev.json before the installer landed would fail to download it
const files = fs.readdirSync(out).filter((f) => f !== "latest-dev.json").map((f) => path.join(out, f));
run("gh", ["release", "upload", TAG, "--repo", REPO, "--clobber", ...files]);
run("gh", ["release", "upload", TAG, "--repo", REPO, "--clobber", path.join(out, "latest-dev.json")]);
console.log(`published Quack Dev ${version} to ${REPO} ${TAG}`);
