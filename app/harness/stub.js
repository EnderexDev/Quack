// window.__TAURI__ for the UI harness: each command and hub path the windows use answers with
// the example data of fixtures.js, so app/ui runs in a plain browser with no app, no hub and no
// Studio. An unknown command or path rejects loudly. Classic script, loaded before the modules.
//
// The page's URL picks the state: ?flavor=dev (green), &lang=pt, &update=1.0.41 (an update
// ready), &rule=1 (the rule notice), &hubOld=1 (an outdated hub), &offline=1 (no hub),
// &paused=1, &aiChoose=1 (the two banners over a game), &refused=1 (a Studio turned away),
// &noGames=1, &approval=1 (a write waiting for the user), &choice=folder|setup (a connection
// waiting for a choice), &unfocused=1 (the window shown without the focus: body.idle),
// &place=<id> and &view=<view> (the screen opened first, through the app's own "navigate").
(() => {
  const params = new URLSearchParams(location.search);
  const F = window.__QUACK_FIXTURES;
  const problems = [];
  const listeners = new Map();
  const settings = { hubPort: 3826, language: params.get("lang") === "pt" ? "pt" : "en", notify: true, ruleSeen: params.get("rule") ? "0f00ba11" : F.rule.version, editor: null, aiTargets: ["claude"] };
  const state = F.state;
  const now = Date.now();
  if (params.get("paused")) state.paused = true;
  if (params.get("aiChoose")) state.ai = { state: "choose" };
  if (params.get("refused")) state.refused = [{ placeId: "77001234567890", placeName: "Obby Rush", at: now - 60_000 }];
  if (params.get("noGames")) {
    state.places = [];
    state.sessions = [];
  }
  if (params.get("choice") === "folder") {
    state.pending = [{ id: "c1", kind: "folderInUse", placeId: "138530444532741", placeName: "PA", folder: "E:\\Dev\\AnimeAstralCopy", other: { kind: "studio" }, since: now - 5000, lastSeen: now }];
  } else if (params.get("choice") === "setup") {
    state.pending = [{ id: "c2", kind: "setup", placeId: "55501234567890", placeName: "Tower Tycoon", since: now - 5000, lastSeen: now }];
  }
  const approvals = params.get("approval")
    ? [{ id: "a1", title: "DataStore: set PlayerData/Player_48210377 in Anime Astral", text: "Universe 7012345678 (Anime Astral)\nStore PlayerData, key Player_48210377\n\nNew value (412 bytes):\n{\n  \"Coins\": 125000,\n  \"Rebirths\": 7,\n  \"Pets\": [\"Golden Dragon\", \"Neon Cat\"]\n}\n\nAsked by: Claude (Anime Astral), tool datastore", expiresAt: now + 4.5 * 60_000 }]
    : [];

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) fn({ event, payload });
  };
  const hubState = () => (params.get("offline")
    ? { online: false, error: "the hub is not answering" }
    : { online: true, state, approvals, approvalsAnswerable: true });

  function hubGet(path) {
    const url = new URL(path, "http://hub");
    const placeId = url.searchParams.get("placeId");
    switch (url.pathname) {
      case "/api/log": {
        // As src/hub/api.ts readLogChunk: no `from` reads it all, `from` reads on from there (a
        // `from` past the end starts over with reset). The log never grows, so the view stays put
        const text = F.logs[placeId] ?? "";
        const raw = url.searchParams.get("from");
        const from = raw === null ? undefined : Number(raw);
        if (from === undefined || from > text.length) return { text, next: text.length, reset: from !== undefined };
        return { text: text.slice(from), next: text.length, reset: false };
      }
      case "/api/merges": return F.merges[placeId] ?? { today: 0, conflicts: [], entries: [] };
      case "/api/conflict": return F.conflict;
      case "/api/analysis": return placeId === "122779716334700" ? F.analysis : { state: "on", at: Date.now() - 300_000, ms: 300, scripts: 211, findings: [] };
      case "/api/production-errors": return placeId === "122779716334700" ? F.productionErrors : { state: "on", checkedAt: Date.now() - 600_000, fresh: [] };
      case "/api/automation": return F.automation;
      case "/api/queue": return F.queue;
      case "/api/queue/settings": return { settings: F.queueSettings };
      case "/api/ai": return F.ai;
      case "/api/setup-candidates": return { existing: [], folderName: url.searchParams.get("name") ?? "Game" };
      default: throw new Error(`harness: no answer for GET ${url.pathname}`);
    }
  }

  // The hub's state as the app's poll would carry it after a write
  const pushState = () => setTimeout(() => emit("hub-state", hubState()), 0);
  const placeOf = (placeId) => state.places.find((p) => p.placeId === placeId);

  /** Each write changes the example data the way the hub would, so the view redraws with it */
  function hubPost(path, body) {
    switch (path) {
      case "/api/pause":
        state.paused = !!body.paused;
        break;
      case "/api/conflict/resolve": {
        const merges = F.merges[body.placeId];
        if (merges) {
          merges.conflicts = merges.conflicts.filter((c) => c.agentVersion !== body.id);
          for (const entry of merges.entries) if (entry.agentVersion === body.id) entry.resolved = true;
        }
        const place = placeOf(body.placeId);
        if (place) place.conflicts = merges?.conflicts.length ?? 0;
        break;
      }
      case "/api/production-errors/dismiss":
        if (body.placeId === "122779716334700") F.productionErrors.fresh = [];
        if (placeOf(body.placeId)) placeOf(body.placeId).newErrors = 0;
        break;
      case "/api/production-errors/check":
        if (body.placeId === "122779716334700") F.productionErrors.checkedAt = Date.now();
        break;
      case "/api/analysis/run":
        F.analysis.at = Date.now();
        break;
      case "/api/rename": {
        const name = String(body.name ?? "").trim();
        if (!name) throw new Error("name must not be empty");
        const place = state.places.find((p) => p.placeId === body.placeId);
        if (!place) throw new Error(`place ${body.placeId} is not registered`);
        place.name = name;
        for (const s of state.sessions) if (s.placeId === body.placeId) s.name = name;
        break;
      }
      case "/api/unregister":
        state.places = state.places.filter((p) => p.placeId !== body.placeId);
        state.sessions = state.sessions.filter((s) => s.placeId !== body.placeId);
        break;
      case "/api/registry":
        if (!/^\d+$/.test(String(body.placeId)) || !body.folder) throw new Error("placeId and folder are required");
        state.places = [...state.places.filter((p) => p.placeId !== body.placeId), { placeId: String(body.placeId), name: body.name, folder: body.folder, today: 0, conflicts: 0 }];
        state.pending = state.pending.filter((c) => c.placeId !== String(body.placeId));
        break;
      case "/api/choice":
        state.pending = state.pending.filter((c) => c.id !== body.id);
        break;
      case "/api/automation": {
        const s = F.automation.settings;
        if (body.global) Object.assign(s.global, body.global);
        if (body.placeId) {
          s.places[body.placeId] = { ...s.places[body.placeId] };
          for (const [k, v] of Object.entries(body.values ?? {})) {
            if (v === null) delete s.places[body.placeId][k];
            else s.places[body.placeId][k] = v;
          }
        }
        for (const p of state.places) F.automation.effective[p.placeId] = { ...s.global, ...s.places[p.placeId] };
        break;
      }
      case "/api/ai":
        Object.assign(F.ai.settings, body);
        F.ai.effective = F.ai.settings.ai ? { state: "on", provider: F.ai.settings.provider ?? "claude" } : { state: "off" };
        state.ai = F.ai.effective;
        break;
      case "/api/queue/settings":
        Object.assign(F.queueSettings, body.settings);
        break;
      case "/api/queue/force-release":
        F.queue.holder = null;
        break;
      case "/api/queue/unstick":
        F.queue.stuck = null;
        break;
      default: throw new Error(`harness: no answer for POST ${path}`);
    }
    pushState();
    return { ok: true };
  }

  const commands = {
    app_info: () => ({ version: "1.0.40", build: params.get("hubOld") ? "newer01" : state.build, flavor: params.get("flavor") === "dev" ? "dev" : "official" }),
    update_status: () => ({ ready: params.get("update") || null }),
    check_update: () => ({ ready: null }),
    install_update: () => { throw new Error("harness: installing is the app's"); },
    ai_rule: () => F.rule,
    ai_clients: () => F.aiClients,
    get_settings: () => ({ ...settings }),
    // As main.rs set_settings: a field left out or null is not changed; editor "" goes back to
    // the one used last (stored as null)
    set_settings: (args) => {
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) settings[k] = k === "editor" && v === "" ? null : v;
      setTimeout(() => emit("settings", { ...settings }), 0);
      return { ...settings };
    },
    get_autostart: () => true,
    set_autostart: ({ enabled }) => enabled,
    editors: () => F.editors,
    open_path: () => null,
    pick_folder: () => null,
    project_roots: () => ["E:\\Dev"],
    make_folder: () => null,
    plugin_version: () => "1.0.38",
    read_daemon_config: () => F.daemonConfig,
    cloud_settings: () => F.cloud,
    restart_hub: () => null,
    // The hub drops an answered write from its list; the next state no longer carries it
    approval_answer: ({ id }) => {
      const at = approvals.findIndex((a) => a.id === id);
      if (at < 0) throw new Error("no such approval");
      approvals.splice(at, 1);
      pushState();
      return { ok: true };
    },
    show_main: () => null,
    tray_fit: () => null,
    hide_window: () => null,
    quit: () => null,
    hub_get: ({ path }) => hubGet(path),
    hub_post: ({ path, body }) => hubPost(path, body),
  };

  // Always a Promise, as Tauri's invoke: callers chain .catch on it
  const invoke = (command, args = {}) => new Promise((resolve, reject) => {
    const fn = commands[command];
    if (!fn) {
      problems.push(`unknown command ${command}`);
      return reject(new Error(`harness: unknown command ${command}`));
    }
    try {
      resolve(structuredClone(fn(args)));
    } catch (error) {
      if (String(error.message).startsWith("harness: no answer")) problems.push(error.message);
      reject(error.message);
    }
  });

  const listen = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    // The app polls the hub every second; here the state arrives once, as soon as it is listened to
    if (event === "hub-state") setTimeout(() => fn({ event, payload: hubState() }), 0);
    return Promise.resolve(() => listeners.get(event)?.delete(fn));
  };

  // A window that is shown (pollers run, idle.js) and focused (animations play) unless &unfocused=1
  const win = {
    isFocused: async () => !params.get("unfocused"),
    isVisible: async () => true,
    isMinimized: async () => false,
    onFocusChanged: async () => () => {},
    onResized: async () => () => {},
  };

  window.__TAURI__ = { core: { invoke }, event: { listen }, window: { getCurrentWindow: () => win } };

  // What the capture script drives and reads
  window.__harness = {
    problems,
    go: (view, placeId, id) => emit("navigate", { view, placeId: placeId ?? null, id: id ?? null }),
    emit,
  };
  if (params.get("view") || params.get("place")) {
    // After main.js listens to "navigate" (its last await)
    const start = Date.now();
    const tick = setInterval(() => {
      if (listeners.get("navigate")?.size || Date.now() - start > 5000) {
        clearInterval(tick);
        window.__harness.go(params.get("view") ?? "output", params.get("place"), params.get("id"));
      }
    }, 20);
  }

  // The Queue and Folder states: &queue=empty|stuck|foreign|busy (fixtures.js queueStates),
  // &queueError=1 (the hub answers no queue), &noFolder=1 (the open game has no folder)
  if (F.queueStates[params.get("queue")]) Object.assign(F.queue, F.queueStates[params.get("queue")]);
  if (params.get("queueError")) {
    const get = commands.hub_get;
    commands.hub_get = (args) => {
      if (String(args.path).startsWith("/api/queue?")) throw new Error("the hub did not answer /api/queue");
      return get(args);
    };
  }
  if (params.get("noFolder")) state.places[0].folder = "";

  // Dialogs, menu, toast and tray: more states. &choice=studio (a second Studio wants a place),
  // &setupExisting=1 (three folders already stamped with the place), &picked=<path> (the folder
  // picker's answer), &approvalLong=1 (a long write), &manyPlaces=1 (nine games).
  // __harness.hubState() is the state the next poll would carry.
  if (params.get("choice") === "studio") {
    state.pending = [{ id: "c3", kind: "studioInUse", placeId: "122779716334700", placeName: "Anime Astral Copy", folder: "E:\\Dev\\AnimeAstralCopy", other: { kind: "studio" }, since: now - 5000, lastSeen: now }];
  }
  if (params.get("approvalLong") && approvals.length) {
    const players = Array.from({ length: 40 }, (_, i) => `    "Player_${48210377 + i}": { "Coins": ${125000 + i * 1000}, "Rebirths": ${i % 9} }`).join(",\n");
    approvals[0] = { ...approvals[0], title: "DataStore: set 40 entries of PlayerData in Anime Astral, the published experience, for the rebalance of rebirth costs", text: `Universe 7012345678 (Anime Astral)\nStore PlayerData, 40 keys\n\nNew values:\n{\n${players}\n}\n\nAsked by: Claude (Anime Astral), tool datastore` };
  }
  if (params.get("manyPlaces")) {
    const more = ["Speed Run", "Tower Tycoon", "Pet Sim Lab", "Racing Test", "Map Builder", "Anime Legacy Copy"];
    more.forEach((name, i) => state.places.push({ placeId: String(70001234567890 + i), name, folder: `E:\\Dev\\${name.replace(/ /g, "")}`, today: 0, conflicts: i === 2 ? 2 : 0 }));
    state.sessions.push({ placeId: "70001234567891", name: "Tower Tycoon", folder: "E:\\Dev\\TowerTycoon", daemonPid: 21002, daemonPort: 51990, studioConnected: true, studioSince: now - 5 * 60_000, daemonSince: now - 6 * 60_000, instances: 4210, scripts: 88 });
  }
  const getAnswer = commands.hub_get;
  commands.hub_get = (args) => {
    const url = new URL(args.path, "http://hub");
    if (url.pathname === "/api/setup-candidates" && params.get("setupExisting")) {
      return { existing: ["E:\\Dev\\TowerTycoon", "E:\\Games\\Tower Tycoon (old)", "D:\\Backup\\TowerTycoon"], folderName: url.searchParams.get("name") ?? "Game" };
    }
    return getAnswer(args);
  };
  if (params.get("picked")) commands.pick_folder = () => params.get("picked");
  window.__harness.hubState = hubState;
  // Each event a fresh copy, as the app's Rust side sends it: the tray compares the new state
  // with the last one, and the same object mutated in place read as no change
  const listenShared = window.__TAURI__.event.listen;
  window.__TAURI__.event.listen = (event, fn) => listenShared(event, (e) => fn(structuredClone(e)));
})();

// Every command the windows invoke, in order, as { command, args }, for a shot's check to read (the
// dialogs, Merges, Conflict, Analysis and Settings shots): which side a resolve sent, which file a
// finding opened, what a dialog answered. The commands still answer from the example data above;
// this only records. Wrapped before the page's modules read window.__TAURI__.core.invoke
(() => {
  const core = window.__TAURI__.core;
  const real = core.invoke;
  const calls = [];
  window.__harness.calls = calls;
  core.invoke = (command, args = {}) => {
    calls.push({ command, args: structuredClone(args) });
    return real(command, args);
  };
})();

// &ai=none|both|unknown: the AI merge card with no AI on this computer, with both and no choice
// yet, or with a hub that could not check (its answer is empty)
(() => {
  const which = new URLSearchParams(location.search).get("ai");
  const F = window.__QUACK_FIXTURES;
  if (which === "unknown") F.ai = null;
  if (which === "none") {
    F.ai = { detected: { claude: { installed: false, loggedIn: false, models: [] }, codex: { installed: true, loggedIn: false, models: [] } }, usable: [], settings: { ai: false }, effective: { state: "off" }, file: F.ai.file };
  }
  if (which === "both") {
    F.ai = { detected: { claude: { installed: true, loggedIn: true, models: ["sonnet", "opus"] }, codex: { installed: true, loggedIn: true, models: ["gpt-5.5"] } }, usable: ["claude", "codex"], settings: { ai: true }, effective: { state: "choose" }, file: F.ai.file };
  }
})();

// &ai=nomodel: Claude in use with its model list but no model saved or detected; &qsOld=1: an
// older hub that sends one number for infraWaitSec instead of a list
(() => {
  const params = new URLSearchParams(location.search);
  const F = window.__QUACK_FIXTURES;
  if (params.get("ai") === "nomodel") {
    delete F.ai.settings.model;
    delete F.ai.detected.claude.model;
  }
  if (params.get("qsOld")) F.queueSettings.infraWaitSec = 15;
})();
