// CHANGELOG.md between releases: every change a user notices adds its line under
// "## [Unreleased]" as it lands on hub; the promotion turns that section into the next version.
//   node scripts/changelog.mjs release           stamp [Unreleased] as the next public version
//                                                 (one above the highest v1.0.N tag) and commit
//   node scripts/changelog.mjs check <version>   exit 1 unless the newest section is <version>,
//                                                 with entries, and [Unreleased] is empty
//   node scripts/changelog.mjs notes <version>   print that version's section (release notes)
// The private Release workflow runs `check` before it exports, so a promotion with no changelog
// publishes nothing; the public one runs `notes` for the GitHub release. 1.0.7 to 1.0.20 went
// out without a line (10/11/26) because nothing asked for one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_REPO = "EnderexDev/Quack";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "CHANGELOG.md");

const HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK = /^\[([^\]]+)\]: \S+\s*$/;

/** The file as lines, with each "## [x]" section's range; History and other "## " end a section */
export function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const isHeading = lines[i].startsWith("## ");
    if ((isHeading || LINK.test(lines[i])) && open) {
      open.end = i;
      open = null;
    }
    const m = HEADING.exec(lines[i]);
    if (m) {
      open = { name: m[1], date: m[2], start: i, end: lines.length };
      sections.push(open);
    }
  }
  return { lines, sections };
}

/** The lines under a section's heading, without the blank lines around them */
function body(lines, s) {
  const out = lines.slice(s.start + 1, s.end);
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

const hasEntries = (lines) => lines.some((l) => /^\s*- \S/.test(l));
const versionOf = (s) => (/^\d+\.\d+\.\d+$/.test(s.name) ? s.name : null);

/** The section of a version, as text (the GitHub release notes) */
export function releaseNotes(text, version) {
  const { lines, sections } = parse(text);
  const s = sections.find((x) => x.name === version);
  if (!s) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return body(lines, s).join("\n") + "\n";
}

/** Why the changelog is not ready to publish `version`, or null when it is */
export function checkRelease(text, version) {
  const { lines, sections } = parse(text);
  const unreleased = sections.find((s) => s.name === "Unreleased");
  if (unreleased && hasEntries(body(lines, unreleased))) {
    return `[Unreleased] still has entries: run \`node scripts/changelog.mjs release\` before promoting`;
  }
  const newest = sections.find(versionOf);
  if (!newest || newest.name !== version) {
    return `the newest section of CHANGELOG.md is ${newest ? newest.name : "none"}, but this release is ${version}: run \`node scripts/changelog.mjs release\` before promoting`;
  }
  if (!hasEntries(body(lines, newest))) return `the section of ${version} has no entries`;
  return null;
}

/**
 * [Unreleased] becomes `version` (dated `date`), with an empty [Unreleased] above it and its
 * compare link. When the newest section already is `version` (stamped, then the release failed),
 * the new entries join it under the same headings instead.
 */
export function stampRelease(text, version, date) {
  const { lines, sections } = parse(text);
  const unreleased = sections.find((s) => s.name === "Unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const added = body(lines, unreleased);
  const newest = sections.find(versionOf);
  if (!hasEntries(added)) {
    if (newest && newest.name === version) return text.replace(/\r\n/g, "\n");
    throw new Error("[Unreleased] has no entries: write what this release changes for users (a release with none says so in one line)");
  }

  let out;
  if (newest && newest.name === version) {
    const merged = mergeGroups(body(lines, newest), added);
    out = [
      ...lines.slice(0, unreleased.start + 1), "",
      ...lines.slice(unreleased.end, newest.start + 1), "", ...merged, "",
      ...lines.slice(newest.end),
    ];
  } else {
    out = [...lines.slice(0, unreleased.start + 1), "", `## [${version}] - ${date}`, "", ...added, "", ...lines.slice(unreleased.end)];
  }
  return relink(out, version, newest && newest.name !== version ? newest.name : previousOf(sections, version));
}

function previousOf(sections, version) {
  const s = sections.filter(versionOf).find((x) => x.name !== version);
  return s ? s.name : null;
}

/** Entries grouped by "### Kind", in the order Keep a Changelog uses */
function mergeGroups(a, b) {
  const order = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
  const groups = new Map();
  for (const part of [a, b]) {
    let kind = "Changed";
    for (const l of part) {
      const h = /^### (.+?)\s*$/.exec(l);
      if (h) { kind = h[1]; continue; }
      if (l.trim() === "") continue;
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(l);
    }
  }
  const kinds = [...groups.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  return kinds.flatMap((k, i) => [...(i ? [""] : []), `### ${k}`, ...groups.get(k)]);
}

/** The [Unreleased] and [version] compare links, newest first above the older ones */
function relink(lines, version, previous) {
  const base = `https://github.com/${PUBLIC_REPO}`;
  const kept = lines.filter((l) => {
    const m = LINK.exec(l);
    return !(m && (m[1] === "Unreleased" || m[1] === version));
  });
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const firstLink = kept.findIndex((l) => LINK.test(l));
  const mine = [
    `[Unreleased]: ${base}/compare/v${version}...HEAD`,
    previous ? `[${version}]: ${base}/compare/v${previous}...v${version}` : `[${version}]: ${base}/releases/tag/v${version}`,
  ];
  if (firstLink < 0) kept.push("", ...mine);
  else kept.splice(firstLink, 0, ...mine);
  return kept.join("\n") + "\n";
}

/** One above the highest v1.0.N tag of the public repo, as the private Release workflow counts */
export function nextPublicVersion(tagsOutput) {
  const ns = [...tagsOutput.matchAll(/refs\/tags\/v1\.0\.(\d+)\s*$/gm)].map((m) => Number(m[1]));
  return ns.length ? `1.0.${Math.max(...ns) + 1}` : "1.0.0";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, version] = process.argv.slice(2);
  const text = fs.readFileSync(file, "utf8");
  try {
    if (cmd === "notes" && version) {
      process.stdout.write(releaseNotes(text, version));
    } else if (cmd === "check" && version) {
      const why = checkRelease(text, version);
      if (why) throw new Error(why);
      console.log(`CHANGELOG.md has ${version}`);
    } else if (cmd === "release") {
      const tags = execFileSync("git", ["ls-remote", "--tags", "--refs", `https://github.com/${PUBLIC_REPO}.git`], { encoding: "utf8" });
      const next = version || nextPublicVersion(tags);
      const date = new Date().toISOString().slice(0, 10);
      const out = stampRelease(text, next, date);
      if (out === text.replace(/\r\n/g, "\n")) {
        console.log(`CHANGELOG.md already has ${next}`);
      } else {
        fs.writeFileSync(file, out);
        execFileSync("git", ["commit", "-q", "-m", `Changelog: ${next}`, "--", "CHANGELOG.md"], { cwd: root, stdio: "inherit" });
        console.log(`CHANGELOG.md: [Unreleased] is now ${next}, committed`);
      }
    } else {
      throw new Error("usage: node scripts/changelog.mjs release [version] | check <version> | notes <version>");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
