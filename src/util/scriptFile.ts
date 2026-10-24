import { config } from "../config.js";

export type ScriptClassName = "Script" | "LocalScript" | "ModuleScript";

export interface ClassifiedScriptFile {
  className: ScriptClassName;
  scriptName: string;
}

export interface ClassifyScriptFileOptions {
  stripDisambiguationSuffix?: boolean;
}

export function isScriptClassName(
  className: string,
): className is ScriptClassName {
  return (
    className === "Script" ||
    className === "LocalScript" ||
    className === "ModuleScript"
  );
}

/**
 * Quack: a script's text as read from disk, with CRLF line ends made LF. git on Windows writes
 * CRLF (core.autocrlf true, and the games have no .gitattributes), Studio and the synced files
 * hold LF: a file a merge or checkout wrote reached Studio with a CR on every line (measured on
 * PA, 22/10/26), and differed from Studio's text for every comparison the daemon makes.
 */
export function diskText(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

export function isScriptFileName(fileName: string): boolean {
  return fileName.endsWith(".lua") || fileName.endsWith(".luau");
}

/**
 * Detects Rojo/Argon-style init files (`init.luau`, `init.server.luau`,
 * `init.client.luau`, and their `.lua` equivalents). Quack does not use the
 * init pattern — it uses a script file plus a same-named sibling folder.
 */
export function isInitScriptFileName(fileName: string): boolean {
  const normalized = normalizeLuaLikeFileName(fileName).toLowerCase();
  return (
    normalized === "init.luau" ||
    normalized === "init.server.luau" ||
    normalized === "init.client.luau"
  );
}

export function isInstanceJsonName(fileName: string): boolean {
  return fileName.endsWith(".model.json");
  // || fileName.endsWith(".meta.json"); // No support for this yet
}

export function normalizeLuaLikeFileName(fileName: string): string {
  return fileName.replace(/\.lua$/i, ".luau");
}

export function stripScriptDisambiguationSuffix(scriptName: string): string {
  return scriptName.replace(/__\{?[a-z0-9-]{6,}\}?$/i, "");
}

/**
 * Replaces `@self` with `./instanceName/` when `config.rewriteSelfRequires` is enabled.
 *
 * @param instanceName The name of the instance that the source belongs to.
 * @param source The source code to rewrite.
 * @returns The rewritten source code.
 */
export function replaceSelfRequires(
  instanceName: string,
  source: string,
): string {
  /**
   * Quack's peer pattern is not considered "submodules" by the Luau standard,
   * therefore `@self` resolution will fail when using tools like Luau-LSP,
   * which make the "correct" assumption that `@self` must represent the
   * folder above it!
   *
   * Replacing `@self` with `./instanceName/` keeps local tooling happy when
   * using external code that relies on the `@self` syntax.
   */
  if (!config.rewriteSelfRequires) {
    return source;
  }
  return source.replace(/@self\//g, `./${instanceName}/`);
}

export function classifyScriptFileName(
  fileName: string,
  options: ClassifyScriptFileOptions = {},
): ClassifiedScriptFile {
  const normalized = normalizeLuaLikeFileName(fileName);
  const base = normalized.replace(/\.luau$/i, "");

  const normalizeName = (name: string) =>
    options.stripDisambiguationSuffix
      ? stripScriptDisambiguationSuffix(name)
      : name;

  if (base.endsWith(".server")) {
    return {
      className: "Script",
      scriptName: normalizeName(base.replace(/\.server$/, "")),
    };
  }

  if (base.endsWith(".client")) {
    return {
      className: "LocalScript",
      scriptName: normalizeName(base.replace(/\.client$/, "")),
    };
  }

  if (base.endsWith(".module")) {
    return {
      className: "ModuleScript",
      scriptName: normalizeName(base.replace(/\.module$/, "")),
    };
  }

  return {
    className: "ModuleScript",
    scriptName: normalizeName(base),
  };
}
