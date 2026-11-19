// Example data for the UI harness, in the shapes the hub and the app's Rust side answer
// (src/hub/hub.ts state() and listSessions(), src/hub/api.ts, app/src-tauri/src/main.rs).
// Classic script: it runs before stub.js and before the page's modules.
(() => {
  const now = Date.now();
  const min = 60_000;
  const ESC = "\x1b";
  const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
  const color = (c, s) => `${ESC}[${c}m${s}${ESC}[0m`;

  // src/util/log.ts: "[time] symbol message", warn and error coloured whole
  const daemon = (time, kind, text) => {
    const at = dim(`[${time}]`);
    if (kind === "info") return `${at} ${color(34, "ℹ")} ${text}`;
    if (kind === "ok") return `${at} ${color(32, "✓")} ${text}`;
    if (kind === "warn") return `${at} ${color(33, `⚠ ${text}`)}`;
    if (kind === "err") return `${at} ${color(31, `✗ ${text}`)}`;
    if (kind === "+") return `${at} ${color(32, "+")} ${text}`;
    if (kind === "~") return `${at} ${color(33, "~")} ${text}`;
    if (kind === "-") return `${at} ${color(31, "−")} ${text}`;
    if (kind === "play") return `${at} ${color(32, "▶")} ${text}`;
    if (kind === "stop") return `${at} ${dim("■")} ${text}`;
    return `${at} ${text}`;
  };
  // src/studioOutput.ts: "  00:16:28.796  message  -  Server", errors red and warnings yellow
  const play = (time, level, text, source) => {
    const body = level === "err" ? color(31, text) : level === "warn" ? color(33, text) : text;
    return `  ${dim(time)}  ${body}  -  ${dim(source)}`;
  };

  const astralLog = [
    "===== Quack 1.0.40, daemon for Anime Astral Copy =====",
    daemon("14:02:08.512", "info", "Watching E:\\Dev\\AnimeAstralCopy\\sync"),
    daemon("14:02:09.118", "info", "Studio connected (Anime Astral Copy, place 122779716334700)"),
    daemon("14:02:11.204", "ok", "Snapshot received: 261,412 instances, 1,874 scripts in 2.1 s"),
    daemon("14:02:11.390", "ok", "In sync: 0 files differ"),
    daemon("14:05:42.033", "~", "ServerScriptService/Services/PetService.luau"),
    daemon("14:05:42.040", "+", "ReplicatedStorage/Shared/Config/EggOdds.luau"),
    daemon("14:06:10.871", "~", "StarterPlayer/StarterPlayerScripts/Controllers/HudController.client.luau"),
    daemon("14:06:55.402", "warn", "Merged ServerScriptService/Services/TradeService.luau: Studio and the disk both changed it, 1 hunk kept from Studio"),
    daemon("14:07:03.990", "-", "ReplicatedStorage/Shared/Old/LegacyTween.luau"),
    daemon("14:08:21.517", "err", "Could not write ServerScriptService/Data/ProfileTemplate.luau: EBUSY, resource busy or locked"),
    daemon("14:08:22.640", "ok", "Retried ServerScriptService/Data/ProfileTemplate.luau"),
    daemon("14:09:44.115", "play", "Playtest started"),
    play("14:09:45.002", "", "[PetService] loaded 412 pets for Player1", "Server"),
    play("14:09:45.310", "", "[HudController] mounted 9 windows", "Client"),
    play("14:09:46.877", "warn", "Infinite yield possible on 'ReplicatedStorage.Remotes:WaitForChild(\"Rebirth\")'", "Client"),
    play("14:09:48.120", "err", "ServerScriptService.Services.TradeService:88: attempt to index nil with 'Inventory'", "Server"),
    play("14:09:48.121", "", "Stack Begin\u2028Script 'ServerScriptService.Services.TradeService', Line 88 - function accept\u2028Stack End", "Server"),
    play("14:09:51.664", "", "[EggService] hatched Common Egg x3", "Server"),
    daemon("14:10:30.008", "stop", "Playtest ended"),
    daemon("14:11:02.551", "~", "ServerScriptService/Services/TradeService.luau"),
    daemon("14:11:02.903", "info", "Analysis: 2 findings in 1,874 scripts (1.4 s)"),
    daemon("14:12:40.017", "~", "ReplicatedStorage/Shared/Config/RebirthConfig.luau"),
  ].join("\n") + "\n";

  const places = [
    { placeId: "122779716334700", name: "Anime Astral Copy", folder: "E:\\Dev\\AnimeAstralCopy", today: 14, conflicts: 1, findings: 2, newErrors: 1 },
    { placeId: "138530444532741", name: "PA", folder: "E:\\Dev\\Scratch\\PA", today: 3, conflicts: 0 },
    { placeId: "98112345678901", name: "Quack Lab", folder: "E:\\Dev\\QuackLab", today: 0, conflicts: 0 },
  ];
  const sessions = [
    { placeId: "122779716334700", name: "Anime Astral Copy", folder: places[0].folder, daemonPid: 18244, daemonPort: 51873, studioConnected: true, studioSince: now - 47 * min, daemonSince: now - 52 * min, instances: 261412, scripts: 1874, lastActivity: now - 20_000, syncedAt: now - 46 * min },
    { placeId: "138530444532741", name: "PA", folder: places[1].folder, daemonPid: 20410, daemonPort: 51902, studioConnected: false, daemonSince: now - 3 * 60 * min, instances: 18320, scripts: 211, syncedAt: now - 2 * 60 * min },
  ];

  const state = {
    build: "b41afbbb",
    capabilities: ["queue", "approvals", "publish", "analysis", "automation", "production-errors"],
    queues: {},
    startedAt: now - 5 * 60 * min,
    paused: false,
    sessions,
    places,
    pending: [],
    refused: [],
    ai: { state: "on", provider: "claude" },
    approvals: 0,
  };

  const iso = (ago) => new Date(now - ago).toISOString();
  const merges = {
    "122779716334700": {
      today: 14,
      conflicts: [{ agentVersion: "a3f9c1", file: "ServerScriptService/Services/TradeService.luau" }],
      entries: [
        { t: iso(6 * min), file: "ServerScriptService/Services/TradeService.luau", method: "ai", ms: 4210, agentVersion: "a3f9c1", resolved: false, conflictingHunks: 1 },
        { t: iso(18 * min), file: "ReplicatedStorage/Shared/Config/EggOdds.luau", method: "text", ms: 3 },
        { t: iso(31 * min), file: "StarterPlayer/StarterPlayerScripts/Controllers/HudController.client.luau", method: "text", ms: 5 },
        { t: iso(44 * min), file: "ServerScriptService/Services/PetService.luau", method: "ai", ms: 3890, agentVersion: "77be02", resolved: true },
        { t: iso(90 * min), file: "ServerScriptService/Data/ProfileTemplate.luau", method: "error", error: "the AI did not answer in 60 s" },
      ],
    },
  };

  const conflict = {
    file: "ServerScriptService/Services/TradeService.luau",
    path: "E:\\Dev\\AnimeAstralCopy\\sync\\ServerScriptService\\Services\\TradeService.luau",
    current: "local TradeService = {}\n\nfunction TradeService.accept(trade)\n\tlocal a = trade.from\n\tlocal b = trade.to\n\tif not a or not b then return false end\n\tswap(a.Inventory, b.Inventory, trade.items)\n\treturn true\nend\n\nreturn TradeService\n",
    saved: "local TradeService = {}\n\nfunction TradeService.accept(trade)\n\tlocal a = trade.from\n\tlocal b = trade.to\n\tswap(a.Inventory, b.Inventory, trade.items)\n\tlog(\"trade\", trade.id)\n\treturn true\nend\n\nreturn TradeService\n",
  };

  const analysis = {
    state: "on",
    at: now - 2 * min,
    ms: 1400,
    scripts: 1874,
    findings: [
      { file: "ServerScriptService/Services/TradeService.luau", line: 88, rule: "nil-index", message: "a.Inventory may be nil: accept() reaches it before the check on line 86" },
      { file: "StarterPlayer/StarterPlayerScripts/Controllers/HudController.client.luau", line: 214, rule: "wait-for-child", message: "WaitForChild(\"Rebirth\"): ReplicatedStorage.Remotes has no child named Rebirth" },
    ],
  };
  const productionErrors = {
    state: "on",
    checkedAt: now - 12 * min,
    fresh: [{ at: "ServerScriptService/Services/TradeService.luau:88", hash: "9c1e", source: "Server", message: "attempt to index nil with 'Inventory'", count: 37 }],
  };
  const automation = {
    settings: { global: { review: true, panel: true, errors: true, precommit: false }, places: { "122779716334700": { precommit: true } } },
    effective: Object.fromEntries(places.map((p) => [p.placeId, { review: true, panel: true, errors: true, precommit: p.placeId === "122779716334700" }])),
    precommitHooks: { "122779716334700": "installed" },
  };

  const queue = {
    phase: "running",
    holder: { client: { id: "t3-a1", name: "Claude (Anime Astral)" }, runner: false, heldMs: 4 * min, idleMs: 25_000, tool: "solo_playtest", requestedMin: 10 },
    waiters: [
      { client: { id: "t3-b2", name: "Codex (Quack Share)" }, task: "trade window test", level: "normal", effectiveLevel: "normal", holdMin: 5, waitedMs: 70_000, rush: false },
    ],
    jobs: [
      { id: "j1", name: "pets: hatch three eggs", client: { name: "Claude (Anime Astral)" }, root: "E:\\worktrees\\AnimeAstral\\t3-pets", waitedMs: 40_000 },
      { id: "j2", name: "trade: accept with empty inventory", client: { name: "Codex (Quack Share)" }, root: "E:\\worktrees\\AnimeAstral\\t3-trade", waitedMs: 12_000 },
    ],
    running: { id: "j1", ms: 21_000 },
    play: null,
    cap: null,
    publish: null,
    stuck: null,
    recent: [
      { name: "rebirth: costs scale", client: { name: "Claude (Anime Astral)" }, verdict: "pass", ms: 48_000, at: now - 22 * min },
      { name: "hud: windows open", client: { name: "Codex (Quack Share)" }, verdict: "fail", reason: "check: expected 9 windows, got 8", ms: 61_000, at: now - 40 * min },
    ],
    today: { jobs: 12, passed: 10, plays: 7, sharedPlays: 3, jobsPerPlay: 1.7, queueP50Ms: 38_000, queueP90Ms: 2.4 * min, grants: 15, grantsCapped: 1, failures: { check: 1 }, notRun: 0 },
  };
  const queueSettings = { historyDays: 180, lockIdleMin: 15, lockIdleWaitingMin: 3, capMin: 5, holdSec: 60, readySec: 30, infraWaitSec: [15, 30], infraTries: 3, stuckRetrySec: 30, stuckGiveUpMin: 10, lingerSec: 60, sharedRetry: "all", agingMin: 10 };

  const ai = {
    detected: {
      claude: { installed: true, loggedIn: true, model: "opus", models: ["sonnet", "opus", "haiku"] },
      codex: { installed: false, loggedIn: false, models: [] },
    },
    usable: ["claude"],
    settings: { ai: true, provider: "claude", model: "opus" },
    effective: { state: "on", provider: "claude" },
    file: "C:\\Users\\dev\\AppData\\Roaming\\quack\\config.json",
  };
  const aiClients = {
    clients: [
      { id: "claude", label: "Claude Code", dir: "C:\\Users\\dev\\.claude", installed: true, connected: true, guarded: true, reviewed: true, rule: "current" },
      { id: "codex", label: "Codex", dir: "C:\\Users\\dev\\.codex", installed: false, connected: false },
      { id: "cursor", label: "Cursor", dir: "C:\\Users\\dev\\.cursor", installed: true, connected: false },
    ],
  };

  window.__QUACK_FIXTURES = {
    state,
    logs: { "122779716334700": astralLog, "138530444532741": `${daemon("11:40:02.100", "info", "Watching E:\\Dev\\Scratch\\PA")}\n${daemon("11:52:13.448", "info", "Studio disconnected")}\n` },
    merges,
    conflict,
    analysis,
    productionErrors,
    automation,
    queue,
    queueSettings,
    ai,
    aiClients,
    editors: [
      { id: "cursor", name: "Cursor", lastUsed: now - 3 * min },
      { id: "code", name: "Code", lastUsed: now - 2 * 24 * 60 * min },
      { id: "zed", name: "Zed", lastUsed: now - 9 * 24 * 60 * min },
    ],
    cloud: { hasKey: true, keyEnd: "x9Qa", userId: "48210377", file: "C:\\Users\\dev\\AppData\\Roaming\\quack\\open-cloud.env", fromEnvironment: [] },
    daemonConfig: { config: { merge: { enabled: true }, deleteOrphansOnConnect: false }, path: "C:\\Users\\dev\\AppData\\Roaming\\quack\\config.json" },
    rule: { version: "e70e5483", text: "# Quack: Roblox Studio synced with disk\n..." },
    // The Queue's other states (stub.js &queue=<name>): fields laid over `queue`
    queueStates: {
      // Nobody holds Studio, nothing queued or waiting, no answer yet today
      empty: { phase: "idle", holder: null, waiters: [], jobs: [], running: null, recent: [],
        today: { jobs: 0, passed: 0, plays: 0, sharedPlays: 0, jobsPerPlay: null, queueP50Ms: null, queueP90Ms: null, grants: 0, grantsCapped: 0, failures: {}, notRun: 0 } },
      // Studio refuses every play start: the jobs wait on it
      stuck: { phase: "starting", running: null,
        stuck: { kind: "refused", since: now - 6 * min, error: "Cannot start a new play: a previous one is still in progress", tries: 11 },
        jobs: [
          { id: "j1", name: "pets: hatch three eggs", client: { name: "Claude (Anime Astral)" }, root: "E:\\worktrees\\AnimeAstral\\t3-pets", waitedMs: 6.2 * min, stuck: { since: now - 6 * min, last: "Studio refused the play" } },
          { id: "j2", name: "trade: accept with empty inventory", client: { name: "Codex (Quack Share)" }, root: "E:\\worktrees\\AnimeAstral\\t3-trade", waitedMs: 4 * min, stuck: { since: now - 4 * min, last: "Studio refused the play" } },
        ] },
      // A play Quack did not start (a Local Server test), and the queue's own tests hold Studio
      foreign: { phase: "waiting",
        holder: { client: { id: "queue" }, runner: true, heldMs: 3 * min, idleMs: 8_000, tool: "studio-test" },
        stuck: { kind: "foreign-play", since: now - 2 * min, error: "a play Quack did not start is up", tries: 4 },
        running: null,
        jobs: [{ id: "j2", name: "trade: accept with empty inventory", client: { name: "Codex (Quack Share)" }, root: "E:\\worktrees\\AnimeAstral\\t3-trade", waitedMs: 2.5 * min, stuck: { since: now - 2 * min, last: "a play Quack did not start is up" } }] },
      // Everything at once: a publish riding, the cap, an infra try, a play held, a rush, the not-run
      busy: {
        cap: { active: true, clientId: "t3-a1" },
        publish: {
          current: { client: { name: "Claude (Anime Astral)" }, ms: 40_000, head: "4f1c2a9be0", riders: [{}, {}] },
          last: { version: 812, client: { name: "Codex (Quack Share)" }, at: now - 55 * min, covered: [{}] },
        },
        waiters: [
          { client: { id: "t3-c3", name: "Claude (Quack)" }, task: "hotfix: shop prices", level: "high", effectiveLevel: "high", holdMin: 3, waitedMs: 20_000, rush: true },
          { client: { id: "t3-b2", name: "Codex (Quack Share)" }, task: "publish after the trade fix", level: "normal", effectiveLevel: "normal", holdMin: 2, waitedMs: 70_000, rush: false, publish: { commit: "a83d02c71f" } },
          { client: { id: "t3-d4", name: "Claude (Anime Astral, guilds)" }, task: "guild raid with four players, the boss's second phase", level: "low", effectiveLevel: "normal", holdMin: 10, waitedMs: 11 * min, rush: false, exclusive: true },
        ],
        jobs: [
          { id: "j3", name: "quests: daily reset at midnight", client: { name: "Claude (Quack)" }, root: "E:\\worktrees\\AnimeAstral\\t3-quests", waitedMs: 95_000, infra: { tries: 2, last: "the client never joined", retryInMs: 25_000 } },
          { id: "j1", name: "pets: hatch three eggs", client: { name: "Claude (Anime Astral)" }, root: "E:\\worktrees\\AnimeAstral\\t3-pets", waitedMs: 40_000 },
          { id: "j4", name: "trade: retry after a failed check", client: { name: "Codex (Quack Share)" }, root: "E:\\worktrees\\AnimeAstral\\t3-trade", waitedMs: 30_000, alone: true },
        ],
        running: { id: "j1", ms: 21_000 },
        play: { roots: ["E:\\worktrees\\AnimeAstral\\t3-pets", "E:\\worktrees\\AnimeAstral\\t3-trade"], since: now - 75_000, held: { client: "t3-b2", leftMs: 40_000 } },
        recent: [
          { name: "shop: buy with exact coins", client: { name: "Claude (Quack)" }, verdict: "infra", reason: "Studio refused the play 3 times", at: now - 9 * min },
          { name: "rebirth: costs scale", client: { name: "Claude (Anime Astral)" }, verdict: "pass", ms: 48_000, at: now - 22 * min },
          { name: "hud: windows open", client: { name: "Codex (Quack Share)" }, verdict: "fail", reason: "check: expected 9 windows, got 8", ms: 61_000, at: now - 40 * min },
        ],
        today: { jobs: 12, passed: 10, plays: 7, sharedPlays: 3, jobsPerPlay: 1.7, queueP50Ms: 38_000, queueP90Ms: 2.4 * min, grants: 15, grantsCapped: 1, failures: { check: 1, infra: 2 }, notRun: 2 },
      },
    },
  };
})();
