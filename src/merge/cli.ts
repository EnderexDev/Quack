import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Runs the tools a merge needs (git, luau-lsp, the AI CLIs) and waits for them.
 *
 * On Windows an npm-installed CLI is a .cmd file (codex is; claude can be), which Node only
 * starts through cmd.exe. Those go through the shell with every argument quoted; an argument
 * cmd.exe would read as its own syntax is refused rather than passed along.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 30000,
  cwd?: string,
  /** Added to this process's environment (a client's config folder) */
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  // A path relative to this process, not to the folder the command runs in
  if (/[\\/]/.test(command) && !path.isAbsolute(command)) command = path.resolve(command);
  // A variable set to undefined is removed: a child must not inherit one meant for this process.
  // Windows names are case-insensitive, so any spelling of the name goes.
  let childEnv: NodeJS.ProcessEnv | undefined;
  if (env) {
    childEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      for (const own of Object.keys(childEnv)) if (own.toUpperCase() === key.toUpperCase()) delete childEnv[own];
      if (value !== undefined) childEnv[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const shim = process.platform === "win32" ? windowsShim(command) : null;
      child = shim
        ? spawn([shim, ...args].map(quoteForCmd).join(" "), { windowsHide: true, cwd, shell: true, env: childEnv })
        : spawn(command, args, { windowsHide: true, cwd, detached: process.platform !== "win32", env: childEnv });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Answered once it is gone (a CLI left running would keep spending), or after a grace
      setTimeout(() => reject(timeoutError()), 5000).unref();
    }, timeoutMs);
    const timeoutError = () => new Error(`${path.basename(command)} timed out after ${timeoutMs} ms`);
    // Decode as a stream: a UTF-8 character split across two chunks stays whole
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    // A child that exits before reading its input (EPIPE) must not crash the daemon
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(timeoutError());
      else resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Stops a child and everything it started. On Windows a .cmd runs as cmd.exe -> node: killing
 * cmd.exe alone leaves the CLI running (and calling its API), so the whole tree goes. Elsewhere
 * the child leads its own process group (detached), and the group goes.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** The .cmd or .bat a command names on Windows, or null when it is an executable or not found */
export function windowsShim(command: string): string | null {
  const found = findOnPath(command);
  return found && /\.(cmd|bat)$/i.test(found) ? found : null;
}

/** Where a command is, the way Windows looks for it (PATH, then PATHEXT); null when nowhere */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = path.extname(command) ? [""] : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = path.isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [""]
    : (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      try {
        // Absolute: a relative PATH entry means this folder, not the one the command runs in
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** One argument for cmd.exe: quoted, and refused when it holds what cmd.exe would expand */
export function quoteForCmd(arg: string): string {
  if (/["%!^\r\n]/.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${arg}"`;
}
