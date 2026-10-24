import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, readMergeSettings, type AiProvider, type QuackConfig } from "../config.js";
import { claudeArgs, codexArgs, codexReply, detectAiCached, resolveAi, skippedNote, type Detected } from "./ai.js";
import { run } from "./cli.js";
import { log } from "../util/log.js";

/**
 * Quack: joins a Studio edit and a disk edit of the same script that raced.
 *
 * 1. Text merge of three versions (git merge-file): base = the last text Studio and the
 *    daemon agreed on, disk = the agent's edit, studio = the human's edit. Where both changed
 *    the same lines, Studio's lines win.
 * 2. Check: the Luau analyzer runs on the result; only errors absent from both inputs count.
 * 3. If the check finds new errors, an AI (Claude Code or Codex, see ai.ts) reads the three versions and the errors
 *    and writes the merge, which is checked the same way. One retry with the new errors.
 * 4. If nothing passes, Studio's version stays and the agent's goes to .quack/conflicts/.
 */

export type MergeMethod = "text" | "ai" | "fallback";

export interface MergeResult {
  text: string;
  method: MergeMethod;
  /** Lines both sides changed, resolved for Studio by the text merge */
  conflictingHunks: number;
  /** New analyzer errors of the text merge (the reason the AI ran) */
  textMergeErrors: string[];
  /** Why the AI step was skipped or failed, when it was */
  aiNote?: string;
  ms: number;
}

export interface MergeTools {
  /** Text merge; returns the merged text and how many hunks conflicted */
  merge3(base: string, disk: string, studio: string): Promise<{ text: string; conflicts: number }>;
  /** Analyzer messages for one text, location stripped; null when no analyzer is available */
  analyze(text: string): Promise<string[] | null>;
  /** AI merge; returns the merged text or throws */
  aiMerge(input: AiMergeInput): Promise<string>;
  /** Test hooks: the merge settings and the AI CLIs found (default: config.json, detectAiCached) */
  settings?: () => QuackConfig["merge"];
  detect?: (settings: QuackConfig["merge"]) => Promise<Detected>;
}

export interface AiMergeInput {
  base: string;
  studio: string;
  disk: string;
  errors: string[];
  previousAttempt?: { text: string; errors: string[] };
  provider: AiProvider;
  settings: QuackConfig["merge"];
}

/** Errors in `merged` that neither input had (a multiset difference by message) */
export function newErrors(
  merged: string[],
  disk: string[],
  studio: string[],
): string[] {
  const allowed = new Map<string, number>();
  for (const source of [disk, studio]) {
    const counts = new Map<string, number>();
    for (const m of source) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const [m, n] of counts) allowed.set(m, Math.max(allowed.get(m) ?? 0, n));
  }
  const result: string[] = [];
  for (const m of merged) {
    const left = allowed.get(m) ?? 0;
    if (left > 0) allowed.set(m, left - 1);
    else result.push(m);
  }
  return result;
}

export async function mergeScripts(
  base: string,
  disk: string,
  studio: string,
  tools: MergeTools = defaultTools,
): Promise<MergeResult> {
  const t0 = Date.now();
  const done = (r: Omit<MergeResult, "ms">): MergeResult => ({ ...r, ms: Date.now() - t0 });

  const textMerge = await tools.merge3(base, disk, studio);
  const [mergedDiag, diskDiag, studioDiag] = await Promise.all([
    tools.analyze(textMerge.text),
    tools.analyze(disk),
    tools.analyze(studio),
  ]);

  // No analyzer: nothing can be checked, the text merge is the answer
  if (mergedDiag === null || diskDiag === null || studioDiag === null) {
    return done({
      text: textMerge.text,
      method: "text",
      conflictingHunks: textMerge.conflicts,
      textMergeErrors: [],
      aiNote: "no Luau analyzer found, merge not checked",
    });
  }

  const textMergeErrors = newErrors(mergedDiag, diskDiag, studioDiag);
  if (textMergeErrors.length === 0) {
    return done({ text: textMerge.text, method: "text", conflictingHunks: textMerge.conflicts, textMergeErrors });
  }

  // Read now: the app may have changed the AI since this daemon started
  const settings = tools.settings?.() ?? readMergeSettings();
  const effective = settings.ai ? resolveAi(settings, await (tools.detect ?? detectAiCached)(settings)) : { state: "off" as const, provider: null };
  if (effective.state !== "ready" || !effective.provider) {
    return done({
      text: studio,
      method: "fallback",
      conflictingHunks: textMerge.conflicts,
      textMergeErrors,
      aiNote: skippedNote(effective),
    });
  }

  let previousAttempt: AiMergeInput["previousAttempt"];
  let aiNote = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const aiText = await tools.aiMerge({ base, studio, disk, errors: textMergeErrors, previousAttempt, provider: effective.provider, settings });
      const aiDiag = await tools.analyze(aiText);
      // An analyzer gone since the first check is no check: the AI text is not taken unchecked
      if (aiDiag === null) throw new Error("the Luau analyzer could not check the AI merge");
      const aiErrors = newErrors(aiDiag, diskDiag, studioDiag);
      if (aiErrors.length === 0) {
        return done({ text: aiText, method: "ai", conflictingHunks: textMerge.conflicts, textMergeErrors });
      }
      previousAttempt = { text: aiText, errors: aiErrors };
      aiNote = `AI attempt ${attempt} still had: ${aiErrors.join("; ")}`;
    } catch (error) {
      aiNote = `AI attempt ${attempt} failed: ${(error as Error).message}`;
    }
  }

  return done({ text: studio, method: "fallback", conflictingHunks: textMerge.conflicts, textMergeErrors, aiNote });
}

// ---------- real tools ----------

async function withTempFiles<T>(
  files: Record<string, string>,
  body: (paths: Record<string, string>, dir: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-merge-"));
  try {
    const paths: Record<string, string> = {};
    for (const [name, text] of Object.entries(files)) {
      paths[name] = path.join(dir, name);
      fs.writeFileSync(paths[name], text, "utf8");
    }
    return await body(paths, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** luau-lsp from config, else the newest one Rokit installed, else PATH */
export function findLuauLsp(): string | null {
  if (config.merge.luauLsp) return config.merge.luauLsp;
  const storage = path.join(os.homedir(), ".rokit", "tool-storage", "johnnymorganz", "luau-lsp");
  try {
    const versions = fs
      .readdirSync(storage)
      .filter((v) => fs.existsSync(path.join(storage, v, exeName("luau-lsp"))))
      .sort((a, b) => compareVersions(b, a));
    if (versions.length > 0) return path.join(storage, versions[0], exeName("luau-lsp"));
  } catch {
    // not installed through Rokit
  }
  return null;
}

const exeName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

let warnedNoAnalyzer = false;

export const defaultTools: MergeTools = {
  async merge3(base, disk, studio) {
    return withTempFiles({ "disk.luau": disk, "base.luau": base, "studio.luau": studio }, async (p) => {
      // Exit code = number of conflicting hunks (at most 127); an error is negative, which
      // the process reports as 255 (measured). --theirs then resolves the hunks for Studio.
      const failed = (code: number | null) => code === null || code > 127;
      const plain = await run("git", ["merge-file", "-p", p["disk.luau"], p["base.luau"], p["studio.luau"]]);
      if (failed(plain.code)) throw new Error(`git merge-file failed (${plain.code}): ${plain.stderr}`);
      const resolved = await run("git", ["merge-file", "-p", "--theirs", p["disk.luau"], p["base.luau"], p["studio.luau"]]);
      if (failed(resolved.code)) throw new Error(`git merge-file failed (${resolved.code}): ${resolved.stderr}`);
      return { text: resolved.stdout, conflicts: plain.code ?? 0 };
    });
  },

  async analyze(text) {
    const lsp = findLuauLsp();
    if (!lsp) {
      if (!warnedNoAnalyzer) {
        log.warn("Quack merge: no luau-lsp found; merges are applied without a check");
        warnedNoAnalyzer = true;
      }
      return null;
    }
    return withTempFiles({ "check.luau": text }, async (p) => {
      const r = await run(lsp, ["analyze", "--platform=standard", p["check.luau"]]);
      const diagnostics = (r.stdout + r.stderr)
        .split(/\r?\n/)
        .filter((line) => /\(\d+,\d+\): /.test(line))
        .map((line) => line.replace(/^.*?\(\d+,\d+\): /, "").trim());
      // Exit 1 means "found problems" and also "could not run" (measured: a missing file exits 1
      // with no diagnostic). A failure must never read as a clean check.
      // Only 0 (clean) and 1 (problems listed) are answers; a crash or signal is not
      if ((r.code !== 0 && r.code !== 1) || (r.code === 1 && diagnostics.length === 0)) {
        throw new Error(`luau-lsp analyze failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
      }
      return diagnostics;
    });
  },

  async aiMerge(input) {
    const system = [
      "You merge two concurrent edits of one Roblox Luau script.",
      "BASE is the last version both sides agreed on. STUDIO is a human's edit made in Roblox Studio",
      "(often a game balancer tuning values). DISK is an AI agent's edit of the same file.",
      "Produce one file that keeps the intent of BOTH edits. When both changed the same thing,",
      "the STUDIO value wins, but carry it into the DISK structure (renames, refactors, new code).",
      "The automatic text merge was rejected by the Luau analyzer; its errors are given.",
      "Reply with the complete merged file between a line <<<MERGED and a line MERGED>>>.",
      "Anything outside the markers is ignored.",
    ].join(" ");
    const parts = [
      "=== BASE ===", input.base,
      "=== STUDIO ===", input.studio,
      "=== DISK ===", input.disk,
      "=== ANALYZER ERRORS OF THE TEXT MERGE ===", input.errors.join("\n"),
    ];
    if (input.previousAttempt) {
      parts.push(
        "=== YOUR PREVIOUS MERGE (rejected) ===", input.previousAttempt.text,
        "=== ITS NEW ERRORS ===", input.previousAttempt.errors.join("\n"),
      );
    }
    const prompt = parts.join("\n");
    // Run in an empty folder: in the game folder an AI CLI would read its CLAUDE.md or AGENTS.md
    const reply = await withTempFiles({ "system.txt": system }, async (p, dir) => {
      if (input.provider === "codex") {
        const r = await run(input.settings.codexBin, codexArgs(input.settings.codexModel), `${system}\n\n${prompt}`, 180000, dir);
        if (r.code !== 0) throw new Error(`codex exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
        return codexReply(r.stdout);
      }
      const r = await run(input.settings.claudeBin, claudeArgs(input.settings.model, p["system.txt"]), prompt, 180000, dir);
      if (r.code !== 0) throw new Error(`claude exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
      return r.stdout;
    });
    const m = /<<<MERGED\r?\n([\s\S]*?)\r?\nMERGED>>>/.exec(reply);
    if (!m) throw new Error("the AI reply had no <<<MERGED markers");
    return m[1].replace(/^```\w*\r?\n|\r?\n```$/g, "") + "\n";
  },
};
