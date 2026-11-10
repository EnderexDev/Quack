import { RobloxError } from "../control/roblox.js";
import { cloudRequest, wholeId } from "./http.js";
import type { CloudOp } from "./ops.js";
import { hasHiddenCharacters } from "./approve.js";

/**
 * Luau run by Roblox in a server of its own against a saved version of a place (Open Cloud's
 * Luau Execution API), with no Studio open. A trial first (Ender, 09/11/26): whether it is
 * usable (time to an answer, the logs, which version runs) is measured before it is relied on.
 * It is a write: the script runs as the experience and can change its DataStores, so the dialog
 * shows the script.
 */

const PERMISSION = "universe.place.luau-execution-session:write";
const POLL_MS = 2000;
/** What the approval dialog can show whole */
const MAX_LINES = 40;
const MAX_CHARS = 4000;
/** Pages of output read back (1000 lines each) */
const LOG_PAGES_MAX = 10;

export const luauOps: Record<string, CloudOp> = {
  luauRun: {
    write: true,
    describe: (a) => {
      const universeId = wholeId(a.universeId, "universeId");
      const placeId = wholeId(a.placeId, "placeId");
      if (typeof a.script !== "string" || !a.script.trim()) throw new RobloxError("script is required");
      // The user approves exactly what runs: a script the dialog cannot show whole never runs
      const lines = a.script.split(/\r?\n/);
      // A NUL cuts the window's text, bidi and zero-width characters disguise what runs
      if (hasHiddenCharacters(a.script)) throw new RobloxError("the script has hidden characters (controls, bidi or other format characters, variation selectors): the approval must show exactly what runs, so they are refused");
      if (lines.length > MAX_LINES || a.script.length > MAX_CHARS) {
        throw new RobloxError(`the script has ${lines.length} lines and ${a.script.length} characters: the approval shows the whole script, so at most ${MAX_LINES} lines and ${MAX_CHARS} characters`);
      }
      return {
        title: `Quack: run Luau in the cloud (place ${placeId})`,
        text: `Run this Luau in a Roblox server of its own, on ${a.version ? `version ${a.version}` : "the latest saved version"} of place ${placeId} (experience ${universeId})? It runs as the experience: it can read and change its DataStores.\n\n${a.script}`,
      };
    },
    run: async (ctx, a) => {
      const universeId = wholeId(a.universeId, "universeId");
      const placeId = wholeId(a.placeId, "placeId");
      const version = a.version === undefined || a.version === null ? undefined : wholeId(a.version, "version");
      const timeoutSeconds = Math.min(Math.max(Math.floor(Number(a.timeoutSeconds) || 60), 1), 300);
      const started = ctx.env.now();
      const create = await cloudRequest(ctx.env, {
        method: "POST",
        url: `https://apis.roblox.com/cloud/v2/universes/${universeId}/places/${placeId}${version ? `/versions/${version}` : ""}/luau-execution-session-tasks`,
        what: `a cloud Luau run on place ${placeId}`,
        permission: PERMISSION,
        body: JSON.stringify({ script: a.script, timeout: `${timeoutSeconds}s` }),
      });
      const taskPath: string | undefined = create.json?.path;
      // The task's path, in either form Roblox documents: .../luau-execution-sessions/{s}/tasks/{t} or .../luau-execution-session-tasks/{t}
      if (!taskPath || !/^universes\/\d+\/places\/\d+\/(versions\/\d+\/)?(luau-execution-sessions\/[\w-]+\/tasks|luau-execution-session-tasks)\/[\w-]+$/.test(taskPath)) {
        throw new RobloxError(`Roblox answered the run without a task path: ${JSON.stringify(create.json ?? create.text).slice(0, 200)}`);
      }
      let task: any = create.json;
      const deadline = started + (timeoutSeconds + 120) * 1000;
      while (!["COMPLETE", "FAILED", "CANCELLED"].includes(task?.state)) {
        if (ctx.env.now() > deadline) throw new RobloxError(`the cloud run did not finish in ${timeoutSeconds + 120} s (task ${taskPath}, state ${task?.state})`);
        await ctx.env.sleep(POLL_MS);
        task = (await cloudRequest(ctx.env, { url: `https://apis.roblox.com/cloud/v2/${taskPath}`, what: "the cloud run's state", permission: PERMISSION })).json;
      }
      const lines: string[] = [];
      let pageToken = "";
      let pages = 0;
      for (; pages < LOG_PAGES_MAX; pages++) {
        const logs = await cloudRequest(ctx.env, {
          url: `https://apis.roblox.com/cloud/v2/${taskPath}/logs?maxPageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
          what: "the cloud run's output",
          permission: PERMISSION,
          allow404: true,
        });
        for (const page of logs.json?.luauExecutionSessionTaskLogs ?? []) for (const m of page.messages ?? []) lines.push(String(m));
        pageToken = typeof logs.json?.nextPageToken === "string" ? logs.json.nextPageToken : "";
        if (!pageToken) break;
      }
      if (pageToken) lines.push(`(the output goes on past ${LOG_PAGES_MAX} pages: not read)`);
      return {
        state: task.state,
        ms: ctx.env.now() - started,
        placeId,
        version: task.placeVersion ?? version,
        results: task.output?.results,
        error: task.error ? `${task.error.code ?? ""} ${task.error.message ?? ""}`.trim() : undefined,
        output: lines,
        task: taskPath,
      };
    },
  },
};
