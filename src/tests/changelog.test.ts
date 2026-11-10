import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// A path in a variable: the .mjs is plain JS, outside the TypeScript project
const changelog = await import(pathToFileURL(path.join(repo, "scripts", "changelog.mjs")).href);

const BASE = "https://github.com/EnderexDev/Quack";
const sample = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Fixed",
  "- A new fix.",
  "",
  "## [1.0.2] - 2026-11-01",
  "",
  "### Added",
  "- Something.",
  "",
  "## History",
  "",
  "Old text.",
  "",
  `[Unreleased]: ${BASE}/compare/v1.0.2...HEAD`,
  `[1.0.2]: ${BASE}/compare/v1.0.1...v1.0.2`,
  "",
].join("\n");

test("release turns [Unreleased] into the version, dated, with an empty [Unreleased] and its links", () => {
  const out = changelog.stampRelease(sample, "1.0.3", "2026-11-10");
  assert.match(out, /## \[Unreleased\]\n\n## \[1\.0\.3\] - 2026-11-10\n\n### Fixed\n- A new fix\.\n\n## \[1\.0\.2\]/);
  assert.ok(out.includes(`[Unreleased]: ${BASE}/compare/v1.0.3...HEAD\n[1.0.3]: ${BASE}/compare/v1.0.2...v1.0.3\n[1.0.2]:`), out);
  assert.equal(out.match(/^\[Unreleased\]:/gm)?.length, 1);
  assert.equal(changelog.checkRelease(out, "1.0.3"), null);
});

// 1.0.7 to 1.0.20 went out with no changelog: the workflow now refuses that
test("check refuses a release whose version has no section, or with [Unreleased] still full", () => {
  assert.match(changelog.checkRelease(sample, "1.0.3"), /Unreleased/);
  const empty = sample.replace("### Fixed\n- A new fix.\n\n", "");
  assert.match(changelog.checkRelease(empty, "1.0.3"), /newest section .* is 1\.0\.2, but this release is 1\.0\.3/);
  assert.equal(changelog.checkRelease(empty, "1.0.2"), null);
});

test("release refuses an empty [Unreleased]", () => {
  const empty = sample.replace("### Fixed\n- A new fix.\n\n", "");
  assert.throws(() => changelog.stampRelease(empty, "1.0.3", "2026-11-10"), /no entries/);
});

// A stamped version whose release failed in CI (1.0.16's first push did) is still the next one
test("release again before the version went out joins the new entries to it", () => {
  const once = changelog.stampRelease(sample, "1.0.3", "2026-11-10");
  assert.equal(changelog.stampRelease(once, "1.0.3", "2026-11-11"), once);
  const more = once.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n- A new tool.\n\n### Fixed\n- Another fix.\n");
  const twice = changelog.stampRelease(more, "1.0.3", "2026-11-11");
  assert.match(twice, /## \[Unreleased\]\n\n## \[1\.0\.3\] - 2026-11-10\n\n### Added\n- A new tool\.\n\n### Fixed\n- A new fix\.\n- Another fix\.\n\n## \[1\.0\.2\]/);
  assert.equal(twice.match(/^\[1\.0\.3\]:/gm)?.length, 1);
});

test("notes print one version's section, without the heading", () => {
  assert.equal(changelog.releaseNotes(sample, "1.0.2"), "### Added\n- Something.\n");
  assert.throws(() => changelog.releaseNotes(sample, "9.9.9"), /no section/);
});

test("the next public version is one above the highest v1.0.N tag", () => {
  const tags = "a\trefs/tags/v1.0.9\nb\trefs/tags/v1.0.20\nc\trefs/tags/v2.4.0\n";
  assert.equal(changelog.nextPublicVersion(tags), "1.0.21");
  assert.equal(changelog.nextPublicVersion(""), "1.0.0");
});

test("the repo's CHANGELOG.md has [Unreleased], and every version has entries and a link, newest first", () => {
  const text = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
  const { lines, sections } = changelog.parse(text);
  assert.equal(sections[0]?.name, "Unreleased");
  const versions = sections.slice(1).map((s: { name: string }) => s.name);
  const nums = versions.map((v: string) => Number(v.split(".")[2]));
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a), "versions newest first");
  for (let n = nums[0]; n >= 0; n--) assert.ok(nums.includes(n), `1.0.${n} has a section`);
  for (const v of versions) {
    assert.ok(changelog.releaseNotes(text, v).includes("\n- ") || changelog.releaseNotes(text, v).startsWith("- "), `${v} has entries`);
    assert.ok(lines.some((l: string) => l.startsWith(`[${v}]: ${BASE}/`)), `${v} has a link`);
  }
});
