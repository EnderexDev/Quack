// Quack app: the tray icon and window over the Quack hub.
//
// The hub (Node, src/hub) does the syncing; this process only starts it when nothing answers on
// its port, polls GET /api/state once a second, and relays the windows' calls to it. The
// windows never reach the hub themselves: the hub refuses anything carrying a web Origin, and
// the webview is one.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod approval;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, RunEvent, UserAttentionType, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const TRAY_ID: &str = "quack";

// Two builds, side by side. Official (cargo feature "official") is what real games sync with:
// port 3825, %APPDATA%\quack\hub.json. Dev is where changes are tried first: port 3826,
// hub-dev.json, its own window, settings and autostart entry. Each ships its own copy of the hub.
#[cfg(feature = "official")]
mod flavor {
    pub const NAME: &str = "Quack";
    pub const PORT: u16 = 3825;
    pub const REGISTRY: &str = "hub.json";
    /** Same folder Tauri's app_config_dir gives for the identifier in tauri.official.conf.json */
    pub const IDENTIFIER: &str = "dev.enderex.quack";
    pub const HUB_LOG: &str = "hub-app.log";
    /** The plugin this flavor installs into Studio's Plugins folder */
    pub const PLUGIN: &str = "Quack.rbxmx";
    /** The terminal command this flavor installs, and the flavor it passes to cli.mjs */
    pub const COMMAND: &str = "quack";
    pub const CLI_FLAVOR: &str = "official";
    /** Tray icons in yellow; Dev's are green, so the two tell apart by colour (icons.mjs) */
    pub const ICON_OK: &[u8] = include_bytes!("../tray/ok.png");
    pub const ICON_WARN: &[u8] = include_bytes!("../tray/warn.png");
    pub const ICON_BAD: &[u8] = include_bytes!("../tray/bad.png");
    pub const ICON_PAUSED: &[u8] = include_bytes!("../tray/paused.png");
}
#[cfg(not(feature = "official"))]
mod flavor {
    pub const NAME: &str = "Quack Dev";
    pub const PORT: u16 = 3826;
    pub const REGISTRY: &str = "hub-dev.json";
    pub const IDENTIFIER: &str = "dev.enderex.quack.dev";
    pub const HUB_LOG: &str = "hub-dev-app.log";
    pub const PLUGIN: &str = "QuackDev.rbxmx";
    pub const COMMAND: &str = "quackdev";
    pub const CLI_FLAVOR: &str = "dev";
    pub const ICON_OK: &[u8] = include_bytes!("../tray-dev/ok.png");
    pub const ICON_WARN: &[u8] = include_bytes!("../tray-dev/warn.png");
    pub const ICON_BAD: &[u8] = include_bytes!("../tray-dev/bad.png");
    pub const ICON_PAUSED: &[u8] = include_bytes!("../tray-dev/paused.png");
}
const TRAY_WIDTH: f64 = 320.0;
/** Gap between the tray panel and the taskbar, in physical pixels */
const TRAY_GAP: f64 = 10.0;
/**
 * A hub that has not answered yet gets this long to come up before the app starts another one.
 * One that answered is restarted as soon as it is gone (`quack restart-hub`, a crash later on).
 */
const RESPAWN_AFTER: Duration = Duration::from_secs(10);
/**
 * Connecting to the hub's port. A plain connect on Windows takes ~2 s to fail on a closed
 * localhost port (measured 21/10/26), which every poll paid while the hub was down; a live
 * hub accepts in under a millisecond.
 */
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const POLL_EVERY: Duration = Duration::from_millis(1000);
/** Between polls, how often the app looks whether the hub it started has exited */
const HUB_EXIT_CHECK_EVERY: Duration = Duration::from_millis(25);
/** How often the app looks for a new version of itself, after the look at start */
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/** The hub restart an update asks for is done only this soon after the click */
const UPDATE_RESTART_WINDOW_SECS: u64 = 10 * 60;
/** How long a write waits for the user's answer in the hub (src/cloud/approve.ts) */
const APPROVAL_WAIT: Duration = Duration::from_secs(5 * 60);

use flavor::{ICON_BAD, ICON_OK, ICON_PAUSED, ICON_WARN};

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/** The flavor's settings folder: settings.json, the update marker, the approval token */
fn settings_dir() -> PathBuf {
    appdata().join(flavor::IDENTIFIER)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    language: String,
    notify: bool,
    hub_port: u16,
    registry: String,
    /**
     * The hub's entry file, only when overridden. Unset: the hub bundled with the app (release),
     * or this repo's dist/ (debug). Replaces `hubMain`, which pinned the repo path into every
     * saved settings file; serde drops that old key.
     */
    hub_entry: Option<String>,
    node: String,
    /**
     * The version of the rule for AI the user said they gave their AI ("I pasted it"). While the
     * shipped rule's version differs, the window shows the rule notice; only that click hides it.
     */
    rule_seen: Option<String>,
    /** The editor "Open in …" uses, by id; unset: the one used last */
    editor: Option<String>,
    /**
     * The AI folders ticked in the last Connect to AI (`connect-ai` ids); unset: none chosen yet,
     * so the dialog ticks only each AI's default folder
     */
    ai_targets: Option<Vec<String>>,
}

impl Default for Settings {
    fn default() -> Self {
        // The flavor's own hub and registry: Dev never touches the official 3825
        Settings {
            language: "en".into(),
            notify: false,
            hub_port: flavor::PORT,
            registry: appdata().join("quack").join(flavor::REGISTRY).to_string_lossy().into_owned(),
            hub_entry: None,
            node: "node".into(),
            rule_seen: None,
            editor: None,
            ai_targets: None,
        }
    }
}

/** The hub the app runs: an override, else the bundled copy (release) or the repo's dist (debug) */
fn hub_entry(app: &AppHandle, settings: &Settings) -> PathBuf {
    if let Some(entry) = settings.hub_entry.as_deref().filter(|e| !e.trim().is_empty()) {
        return PathBuf::from(entry);
    }
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("hub").join("main.js");
    }
    app.path()
        .resource_dir()
        .map(|dir| without_verbatim(dir.join("resources").join("hub").join("hub.mjs")))
        .unwrap_or_else(|_| PathBuf::from("hub.mjs"))
}

/** A file the installer put next to the app, under resources/ */
fn resource(app: &AppHandle, parts: &[&str]) -> Option<PathBuf> {
    let mut path = app.path().resource_dir().ok()?.join("resources");
    for part in parts {
        path = path.join(part);
    }
    Some(without_verbatim(path))
}

/**
 * The build id of the hub this app ships (resources/hub/BUILD). A running hub that reports
 * another one was started by an older install. None in debug, which runs the repo's dist/.
 */
fn bundled_build(app: &AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return None;
    }
    let text = fs::read_to_string(resource(app, &["hub", "BUILD"])?).ok()?;
    Some(text.trim().to_string()).filter(|b| !b.is_empty())
}

/**
 * `C:\...` from `\\?\C:\...`. Tauri's resource_dir is a verbatim path, and Node cannot start
 * an entry file given that way (EISDIR on lstat 'C:', seen 20/10/26 on the installed app).
 * A verbatim UNC path (`\\?\UNC\server\share`) becomes `\\server\share`.
 */
fn without_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

struct Shared {
    settings: Mutex<Settings>,
    settings_file: PathBuf,
    /** The hub this app started, if it started one */
    hub: Mutex<Option<Child>>,
    last_spawn: Mutex<Option<Instant>>,
    /** The last /api/state, to check the paths the windows ask to open */
    last_state: Mutex<Value>,
    /** Where the tray icon was last clicked: x, y, width, height in physical pixels */
    tray_rect: Mutex<Option<(f64, f64, f64, f64)>>,
    tray_hidden_at: Mutex<Option<Instant>>,
    /** A new version, downloaded and checked against the signing key, waiting for the click */
    ready_update: Mutex<Option<(Update, Vec<u8>)>>,
    /**
     * The token that answers the hub's approvals: the one this app gave the hub it started, or
     * the one an earlier app saved (approval.rs). Never sent to the windows.
     */
    approval_token: Mutex<Option<String>>,
}

fn hub_call(port: u16, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    hub_call_with(port, method, path, body, None)
}

/**
 * A call to the hub. Every one says it is the app (the hub then knows an app is there to ask
 * the user); `token`, the approval token, only on the calls that read or answer approvals.
 */
fn hub_call_with(port: u16, method: &str, path: &str, body: Option<&Value>, token: Option<&str>) -> Result<Value, String> {
    if !path.starts_with("/api/") {
        return Err("not a hub API path".into());
    }
    let url = format!("http://127.0.0.1:{port}{path}");
    let agent = ureq::AgentBuilder::new().timeout_connect(CONNECT_TIMEOUT).timeout(Duration::from_secs(5)).build();
    let mut request = agent.request(method, &url).set(approval::APP_HEADER, "1");
    if let Some(token) = token {
        request = request.set(approval::TOKEN_HEADER, token);
    }
    let result = match body {
        Some(body) => request.send_json(body.clone()),
        None => request.call(),
    };
    match result {
        Ok(response) => response.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, response)) => {
            let body: Value = response.into_json().unwrap_or(Value::Null);
            Err(body
                .get("error")
                .and_then(|e| e.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("the hub answered {code}")))
        }
        Err(error) => Err(format!("the hub is not answering ({error})")),
    }
}

fn port_of(app: &AppHandle) -> u16 {
    app.state::<Shared>().settings.lock().unwrap().hub_port
}

#[tauri::command]
async fn hub_get(app: AppHandle, path: String) -> Result<Value, String> {
    let port = port_of(&app);
    tauri::async_runtime::spawn_blocking(move || hub_call(port, "GET", &path, None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hub_post(app: AppHandle, path: String, body: Value) -> Result<Value, String> {
    if path == "/api/shutdown" {
        return Err("the app stops the hub only when it quits".into());
    }
    if path.starts_with("/api/approvals") {
        return Err("a write is answered through approval_answer".into());
    }
    let port = port_of(&app);
    tauri::async_runtime::spawn_blocking(move || hub_call(port, "POST", &path, Some(&body)))
        .await
        .map_err(|e| e.to_string())?
}

/**
 * The user's click in the approval popup. The token is added here, in Rust: the windows never
 * see it. Without one the hub knows, the popup says to restart the hub.
 */
#[tauri::command]
async fn approval_answer(app: AppHandle, id: String, approve: bool) -> Result<Value, String> {
    let port = port_of(&app);
    let token = app.state::<Shared>().approval_token.lock().unwrap().clone();
    let Some(token) = token else { return Err("restart the hub to approve writes".into()) };
    tauri::async_runtime::spawn_blocking(move || hub_call_with(port, "POST", "/api/approvals/answer", Some(&json!({ "id": id, "approve": approve })), Some(&token)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    app.state::<Shared>().settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, language: Option<String>, notify: Option<bool>, rule_seen: Option<String>, editor: Option<String>, ai_targets: Option<Vec<String>>) -> Result<Settings, String> {
    if let Some(ids) = &ai_targets {
        if !valid_ai_targets(ids) {
            return Err("ai_targets must be connect-ai ids".into());
        }
    }
    // An editor id must be one installed here; "" goes back to the one used last
    let editor = match editor.as_deref() {
        None => None,
        Some("") => Some(None),
        Some(id) if find_editors(&EditorRoots::of_this_computer()).iter().any(|e| e.id == id) => Some(Some(id.to_string())),
        Some(id) => return Err(format!("the editor {id} was not found")),
    };
    let shared = app.state::<Shared>();
    let settings = {
        let mut settings = shared.settings.lock().unwrap();
        if let Some(language) = language {
            if language != "en" && language != "pt" {
                return Err("language must be en or pt".into());
            }
            settings.language = language;
        }
        if let Some(notify) = notify {
            settings.notify = notify;
        }
        if let Some(version) = rule_seen {
            if version.len() > 32 || !version.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Err("rule_seen must be a rule version".into());
            }
            settings.rule_seen = Some(version);
        }
        if let Some(editor) = editor {
            settings.editor = editor;
        }
        if let Some(ids) = ai_targets {
            settings.ai_targets = Some(ids);
        }
        settings.clone()
    };
    if let Some(dir) = shared.settings_file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    fs::write(&shared.settings_file, serde_json::to_string_pretty(&settings).unwrap()).map_err(|e| e.to_string())?;
    let _ = app.emit("settings", &settings);
    Ok(settings)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    Ok(launcher.is_enabled().unwrap_or(false))
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .map(|path| path.to_string())
}

/** Where game folders usually live: Documents\Dev, then Documents (the known folder, so a
 * Documents moved to another drive is followed) */
#[tauri::command]
fn project_roots(app: AppHandle) -> Vec<String> {
    let Ok(documents) = app.path().document_dir() else { return Vec::new() };
    let documents = without_verbatim(documents);
    vec![documents.join("Dev").to_string_lossy().into_owned(), documents.to_string_lossy().into_owned()]
}

/** Creates a new game folder for setup; an absolute path only, and fine if it already exists */
#[tauri::command]
fn make_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("the folder must be an absolute path".into());
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())
}

/** The app's version and the build of the hub it ships, for Settings and the outdated-hub banner */
#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    json!({ "version": app.package_info().version.to_string(), "build": bundled_build(&app), "flavor": flavor::CLI_FLAVOR })
}

/**
 * The version of the plugin in Studio's Plugins folder: the app version that last changed its
 * code (not every app update changes the plugin). Read when Settings opens: the install runs
 * on its own thread at start and can finish after the window asked app_info.
 */
#[tauri::command]
fn plugin_version() -> Option<String> {
    installed_plugin_version()
}

/** Whether something still listens on the hub's port */
fn port_open(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).is_ok()
}

/**
 * Stops the hub on this flavor's port, whoever started it (an older install of this app, too),
 * and starts the one this app ships. A handoff: the daemons keep running and the new hub adopts
 * them, so a Studio connected to its daemon keeps syncing through the restart.
 */
fn restart_hub_now(app: &AppHandle) -> Result<(), String> {
    let shared = app.state::<Shared>();
    // The old hub is no longer this app's to watch: its exit is expected, not a crash to answer
    let old = shared.hub.lock().unwrap().take();
    // The new hub gets ready while the old one still serves, then asks it to step down and takes
    // the port the moment it is free (it adopts the daemons: no Studio drops)
    *shared.last_spawn.lock().unwrap() = None;
    spawn_hub_with(app, true);
    if let Some(mut child) = old {
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
        });
    }
    Ok(())
}

#[tauri::command]
async fn restart_hub(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restart_hub_now(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/** Written right before an update installs; the new version finds it and restarts the hub */
fn update_marker() -> PathBuf {
    settings_dir().join("restart-hub-after-update")
}

/**
 * Looks for a newer version (Official: the latest release of EnderexDev/Quack; Dev: EnderexDev/quack-releases,
 * its dev-channel release) and downloads it in the background. The download is verified
 * against the signing key, and kept until the user clicks; nothing installs on its own.
 * Returns the version waiting for the click, if any.
 */
async fn fetch_update(app: &AppHandle) -> Result<Option<String>, String> {
    if let Some((update, _)) = app.state::<Shared>().ready_update.lock().unwrap().as_ref() {
        return Ok(Some(update.version.clone()));
    }
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    *app.state::<Shared>().ready_update.lock().unwrap() = Some((update, bytes));
    let _ = app.emit("update-ready", json!({ "version": version }));
    // The window is usually closed: once per downloaded version, a notification says where to go
    let pt = app.state::<Shared>().settings.lock().unwrap().language == "pt";
    let body = if pt {
        format!("Versão {version} pronta. Abra o Quack pra instalar.")
    } else {
        format!("Version {version} is ready. Open Quack to install it.")
    };
    let _ = app.notification().builder().title(flavor::NAME).body(body).show();
    Ok(Some(version))
}

/**
 * The "Check for updates" button: the background loop only looks every 6 hours, so a release
 * published right after the app opened waited until then (22/10/26).
 */
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    let ready = fetch_update(&app).await?;
    Ok(json!({ "ready": ready }))
}

fn update_loop(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    loop {
        if let Err(error) = tauri::async_runtime::block_on(fetch_update(&app)) {
            eprintln!("Update check failed: {error}");
        }
        thread::sleep(UPDATE_CHECK_EVERY);
    }
}

/** The version waiting for the click, if any (the window asks when it opens) */
#[tauri::command]
fn update_status(app: AppHandle) -> Value {
    let ready = app.state::<Shared>().ready_update.lock().unwrap().as_ref().map(|(update, _)| update.version.clone());
    json!({ "ready": ready })
}

/**
 * The user's click: installs the downloaded version. On Windows the installer takes over and
 * this process exits; the hub, its own process, keeps running and syncing meanwhile. The
 * installer starts the new version, which restarts the hub (finish_update): the click is the
 * consent for that drop too, so it is not asked again.
 */
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let ready = app.state::<Shared>().ready_update.lock().unwrap().take();
    let Some((update, bytes)) = ready else {
        return Err("no update is ready".into());
    };
    let marker = update_marker();
    let result = (|| {
        if let Some(dir) = marker.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&marker, unix_now().to_string()).map_err(|e| e.to_string())?;
        update.install(&bytes).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        // Kept for another click: the download is verified, no need to wait for the next check
        let _ = fs::remove_file(&marker);
        *app.state::<Shared>().ready_update.lock().unwrap() = Some((update, bytes));
    }
    result
}

/**
 * Right after an update, before Tauri builds any window: the hub this version ships replaces the
 * old one by taking over. Waiting for the windows first (finish_update, in setup) cost 0.85 s,
 * measured 21/10/26. None when there was no update click, it is stale, no hub runs, or the one
 * running already is this build; finish_update and the poll loop cover what is left.
 */
fn early_update_takeover(settings: &Settings) -> Option<(Child, String)> {
    if cfg!(debug_assertions) {
        return None;
    }
    let marker = update_marker();
    let text = fs::read_to_string(&marker).ok()?;
    let _ = fs::remove_file(&marker);
    let fresh = text.trim().parse::<u64>().is_ok_and(|at| unix_now().saturating_sub(at) < UPDATE_RESTART_WINDOW_SECS);
    if !fresh {
        return None;
    }
    // resources/ sits next to the executable in an install (what resource_dir gives later)
    let hub_dir = std::env::current_exe().ok()?.parent()?.join("resources").join("hub");
    let build = fs::read_to_string(hub_dir.join("BUILD")).ok()?.trim().to_string();
    let entry = settings.hub_entry.as_deref().filter(|e| !e.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| hub_dir.join("hub.mjs"));
    match hub_call(settings.hub_port, "GET", "/api/state", None) {
        Ok(state) if state["build"].as_str() != Some(build.as_str()) => {
            let token = approval::new_token().ok()?;
            let child = start_hub_process(settings, &without_verbatim(entry), true, &token).ok()?;
            remember_token(&token);
            Some((child, token))
        }
        _ => None,
    }
}

/**
 * After an update: the old install's hub is still running and syncing. Once it answers, it is
 * restarted into the one this version ships, the same as the "Restart hub" click. Only within
 * a few minutes of the click, and only if its build really differs.
 */
fn finish_update(app: AppHandle) {
    let marker = update_marker();
    let Ok(text) = fs::read_to_string(&marker) else { return };
    let _ = fs::remove_file(&marker);
    let fresh = text.trim().parse::<u64>().is_ok_and(|at| unix_now().saturating_sub(at) < UPDATE_RESTART_WINDOW_SECS);
    let Some(build) = bundled_build(&app) else { return };
    if !fresh {
        return;
    }
    let port = port_of(&app);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match hub_call(port, "GET", "/api/state", None) {
            Ok(state) => {
                if state["build"].as_str() != Some(build.as_str()) {
                    if let Err(error) = restart_hub_now(&app) {
                        eprintln!("Could not restart the hub after the update: {error}");
                    }
                }
                return;
            }
            // Nothing answers yet: the poll loop starts the new hub itself if none comes back
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(500)),
            Err(_) => return,
        }
    }
}

/** Copies `from` over `to` when their bytes differ, through a temporary file; true if it copied */
#[cfg(test)]
fn copy_if_changed(from: &Path, to: &Path) -> std::io::Result<bool> {
    write_if_changed(&fs::read(from)?, to)
}

/** Where the shipped plugin waits for the app's version (QuackService.APP_VERSION) */
const PLUGIN_VERSION_PLACEHOLDER: &str = "@@quack-app-version@@";
const PLUGIN_VERSION_LINE: &str = "QuackService.APP_VERSION = \"";

/** The plugin with this app's version in place of the placeholder, so its header shows it */
fn stamp_plugin(shipped: &str, version: &str) -> String {
    shipped.replacen(PLUGIN_VERSION_PLACEHOLDER, version, 1)
}

/** An installed plugin with its stamped version put back to the placeholder */
fn unstamp_plugin(installed: &str) -> String {
    let Some(start) = installed.find(PLUGIN_VERSION_LINE).map(|i| i + PLUGIN_VERSION_LINE.len()) else {
        return installed.to_string();
    };
    let Some(len) = installed[start..].find('"') else { return installed.to_string() };
    format!("{}{PLUGIN_VERSION_PLACEHOLDER}{}", &installed[..start], &installed[start + len..])
}

/** The app version stamped in a plugin's text; None when it was never stamped */
fn stamped_version(plugin: &str) -> Option<String> {
    let start = plugin.find(PLUGIN_VERSION_LINE)? + PLUGIN_VERSION_LINE.len();
    let version = &plugin[start..start + plugin[start..].find('"')?];
    (!version.is_empty() && !version.starts_with("@@")).then(|| version.to_string())
}

/** The plugin in Studio's Plugins folder: the app version whose plugin code it is, for Settings */
fn installed_plugin_version() -> Option<String> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    stamped_version(&fs::read_to_string(PathBuf::from(local).join("Roblox").join("Plugins").join(flavor::PLUGIN)).ok()?)
}

#[derive(Debug, PartialEq)]
enum PluginInstall {
    /** The installed plugin has this code: left alone, with the version that brought it */
    Unchanged,
    /** New code (or no plugin there yet): Studio loads it when a place reopens */
    Updated,
}

/**
 * Writes the shipped plugin, stamped with `version`, over `to` when its code differs. Same code
 * keeps its old stamp, so the number the plugin shows is the app version that last changed it.
 */
fn install_plugin_file(shipped: &[u8], version: &str, to: &Path) -> std::io::Result<PluginInstall> {
    let Ok(shipped) = std::str::from_utf8(shipped) else {
        return Ok(if write_if_changed(shipped, to)? { PluginInstall::Updated } else { PluginInstall::Unchanged });
    };
    let installed = fs::read_to_string(to).ok();
    let same_code = installed.as_deref().is_some_and(|text| unstamp_plugin(text) == shipped);
    if same_code && installed.as_deref().and_then(stamped_version).is_some() {
        return Ok(PluginInstall::Unchanged);
    }
    if !write_if_changed(stamp_plugin(shipped, version).as_bytes(), to)? {
        return Ok(PluginInstall::Unchanged);
    }
    // A plugin of the same code that only lacked a stamp is nothing new for Studio
    Ok(if same_code { PluginInstall::Unchanged } else { PluginInstall::Updated })
}

/** Writes `new` to `to` when the file holds other bytes, through a temporary file; true if it wrote */
fn write_if_changed(new: &[u8], to: &Path) -> std::io::Result<bool> {
    if fs::read(to).ok().as_deref() == Some(new) {
        return Ok(false);
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    let part = to.with_extension("part");
    fs::write(&part, new)?;
    fs::rename(&part, to)?;
    Ok(true)
}

/**
 * Puts the plugin this app ships into Studio's Plugins folder when it differs from the one
 * there, so the plugin always matches the hub. Studio loads it when a place is opened again.
 * The plugin shows the version of the app that last changed its code: an update that leaves
 * the plugin's code alone leaves the file alone too.
 */
fn install_plugin(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(from) = resource(app, &["plugin", flavor::PLUGIN]) else { return };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let to = PathBuf::from(local).join("Roblox").join("Plugins").join(flavor::PLUGIN);
    let version = app.package_info().version.to_string();
    match fs::read(&from).and_then(|shipped| install_plugin_file(&shipped, &version, &to)) {
        Ok(PluginInstall::Updated) => {
            let pt = app.state::<Shared>().settings.lock().unwrap().language == "pt";
            let body = if pt {
                "Plugin atualizado. Reabra os places no Studio pra carregar."
            } else {
                "Plugin updated. Reopen your places in Studio to load it."
            };
            let _ = app.notification().builder().title(flavor::NAME).body(body).show();
        }
        Ok(PluginInstall::Unchanged) => {}
        Err(error) => eprintln!("Could not install the plugin at {}: {error}", to.display()),
    }
}

/**
 * The terminal command (`quack` / `quackdev`): a .cmd next to the app that runs the cli.mjs it
 * ships with this flavor's name, so each name only ever reaches its own hub. Its folder goes on
 * the user PATH once; terminals opened after that find it.
 */
fn install_cli(app: &AppHandle) {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return;
    }
    let Some(dir) = app.path().resource_dir().ok().map(|d| without_verbatim(d).join("bin")) else { return };
    let node = app.state::<Shared>().settings.lock().unwrap().node.clone();
    if let Err(error) = write_if_changed(cli_shim(&node, flavor::CLI_FLAVOR).as_bytes(), &dir.join(format!("{}.cmd", flavor::COMMAND))) {
        eprintln!("Could not install the {} command: {error}", flavor::COMMAND);
        return;
    }
    // Git Bash (and every AI session's shell): cmd and PowerShell skip a file with no extension
    if let Err(error) = write_if_changed(sh_shim(&node, flavor::CLI_FLAVOR).as_bytes(), &dir.join(flavor::COMMAND)) {
        eprintln!("Could not install the {} command for Git Bash: {error}", flavor::COMMAND);
    }
    // Both apps start at login: one at a time, or the second write would drop the first's entry
    let Some(_lock) = PathLock::take(&appdata().join("quack").join("path.lock")) else {
        return eprintln!("Could not take the PATH lock");
    };
    let current = match read_user_path() {
        Ok(current) => current,
        // Unread is not empty: writing now would drop every other entry
        Err(error) => return eprintln!("Could not read the user PATH: {error}"),
    };
    let Some(updated) = path_with(&current, &dir) else { return };
    if let Err(error) = write_user_path(&updated) {
        return eprintln!("Could not add {} to the user PATH: {error}", dir.display());
    }
    let pt = app.state::<Shared>().settings.lock().unwrap().language == "pt";
    let body = if pt {
        format!("Comando {} instalado. Abra um terminal novo pra usar.", flavor::COMMAND)
    } else {
        format!("The {} command is installed. Open a new terminal to use it.", flavor::COMMAND)
    };
    let _ = app.notification().builder().title(flavor::NAME).body(body).show();
}

/**
 * An exclusive OS lock on a file: held by one process at a time, released when dropped or when
 * the process dies, so a crash leaves nothing to expire. The file itself stays.
 */
struct PathLock(#[allow(dead_code)] fs::File);

impl PathLock {
    fn take(file: &Path) -> Option<PathLock> {
        let _ = fs::create_dir_all(file.parent()?);
        let handle = OpenOptions::new().write(true).create(true).truncate(false).open(file).ok()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match handle.try_lock() {
                Ok(()) => return Some(PathLock(handle)),
                Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                Err(_) => return None,
            }
        }
    }
}

/** The .cmd: cli.mjs sits in resources\hub, one folder up from bin\ */
fn cli_shim(node: &str, flavor: &str) -> String {
    let node = node.replace('"', "");
    format!("@\"{node}\" \"%~dp0..\\resources\\hub\\cli.mjs\" --flavor {flavor} %*\r\n")
}

/**
 * The same command for Git Bash, which runs a .cmd only by its full name, through `cmd /c`: with
 * a space in the path ("Quack Dev") and a quoted argument, cmd strips the outer quotes and looks
 * for `...\Local\Quack` (07/11/26). Single quotes keep the node path literal; MSYS turns the
 * script's own path into a Windows one for node.
 */
fn sh_shim(node: &str, flavor: &str) -> String {
    let node = node.replace('"', "").replace('\\', "/").replace('\'', "'\\''");
    format!("#!/bin/sh\nexec '{node}' \"$(dirname \"$0\")/../resources/hub/cli.mjs\" --flavor {flavor} \"$@\"\n")
}

/** The user PATH with `dir` added at the end; None when it is there already */
fn path_with(current: &str, dir: &Path) -> Option<String> {
    let wanted = normalized(dir);
    if current.split(';').map(str::trim).any(|entry| !entry.is_empty() && normalized(Path::new(entry)) == wanted) {
        return None;
    }
    let base = current.trim_end_matches(';');
    Some(if base.is_empty() { dir.display().to_string() } else { format!("{base};{}", dir.display()) })
}

/**
 * The user PATH as stored, %VARIABLES% unexpanded (setx and [Environment] would expand them or
 * cut the value at 1024 characters)
 */
fn read_user_path() -> Result<String, String> {
    let script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; \
        $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); \
        if ($k) { [Console]::Out.Write($k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) }";
    let output = hidden_command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

/**
 * Writes it back in the kind it had (REG_SZ or REG_EXPAND_SZ; a new one expands); touching a user
 * variable through [Environment] tells running programs
 */
fn write_user_path(value: &str) -> Result<(), String> {
    let script = "$ErrorActionPreference='Stop'; \
        $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); \
        $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString; \
        if ($k.GetValueNames() -contains 'Path') { $kind=$k.GetValueKind('Path') }; \
        $k.SetValue('Path',$env:QUACK_NEW_PATH,$kind); \
        [Environment]::SetEnvironmentVariable('QUACK_PATH_REFRESH','1','User'); \
        [Environment]::SetEnvironmentVariable('QUACK_PATH_REFRESH',$null,'User')";
    let output = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("QUACK_NEW_PATH", value)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

/** `connect-ai` ids: claude, codex or cursor, or claude:/codex: with a folder; 64 at most */
fn valid_ai_targets(ids: &[String]) -> bool {
    ids.len() <= 64
        && ids.iter().all(|id| {
            id == "cursor"
                || ["claude", "codex"].iter().any(|kind| {
                    id == kind || id.strip_prefix(kind).and_then(|rest| rest.strip_prefix(':')).is_some_and(|dir| !dir.is_empty() && dir.len() < 1024 && !dir.contains(['\0', '\n', '\r']))
                })
        })
}

/**
 * Claude Code, Cursor and Codex on this computer and whether each has this flavor's MCP
 * (`ai-clients`), or the MCP added to each one installed (`connect-ai`): the shipped command
 * does both, so the button and `quack connect-ai` never disagree.
 */
#[tauri::command]
async fn ai_clients(app: AppHandle, connect: bool, only: Option<Vec<String>>) -> Result<Value, String> {
    // The folders ticked in the dialog: each one by its id, and none ticked connects nothing
    if let Some(ids) = &only {
        if !valid_ai_targets(ids) {
            return Err("only takes connect-ai ids".into());
        }
        if connect && ids.is_empty() {
            return Err("no AI chosen".into());
        }
    }
    let node = app.state::<Shared>().settings.lock().unwrap().node.clone();
    let cli = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("control").join("main.js")
    } else {
        resource(&app, &["hub", "cli.mjs"]).ok_or("the app's files were not found")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = hidden_command(&node);
        command.arg(&cli).args(["--flavor", flavor::CLI_FLAVOR, if connect { "connect-ai" } else { "ai-clients" }, "--json"]);
        if let (true, Some(ids)) = (connect, &only) {
            // After `--`, an id is never read as an option
            command.arg("--exact").arg("--").args(ids);
        }
        let output = command
            .output()
            .map_err(|e| format!("could not run {node}: {e}"))?;
        // Exit 1 still carries the list, with the problem on the client it concerns
        serde_json::from_slice::<Value>(&output.stdout).map_err(|_| String::from_utf8_lossy(&output.stderr).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/**
 * The rule an AI keeps in its instructions file, with how it installs or updates it
 * (`rule --prompt`): the shipped command writes it, so the button and `quack rule` never differ.
 */
#[tauri::command]
async fn ai_rule(app: AppHandle) -> Result<Value, String> {
    let node = app.state::<Shared>().settings.lock().unwrap().node.clone();
    let cli = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("control").join("main.js")
    } else {
        resource(&app, &["hub", "cli.mjs"]).ok_or("the app's files were not found")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let output = hidden_command(&node)
            .arg(&cli)
            .args(["--flavor", flavor::CLI_FLAVOR, "rule", "--prompt", "--json"])
            .output()
            .map_err(|e| format!("could not run {node}: {e}"))?;
        serde_json::from_slice::<Value>(&output.stdout).map_err(|_| String::from_utf8_lossy(&output.stderr).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/** The shipped command's path: this repo's dist in debug, resources/hub/cli.mjs installed */
fn cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("control").join("main.js"));
    }
    resource(app, &["hub", "cli.mjs"]).ok_or_else(|| "the app's files were not found".to_string())
}

/**
 * The Open Cloud key and creator upload_asset uses (`cloud`), and saving them (`cloud set` /
 * `cloud clear`). The shipped command reads and writes open-cloud.env, so the app, the terminal and
 * the upload never disagree. The key goes on the child's stdin, never its command line, and never
 * comes back: the answer carries only its last 4 characters.
 */
#[tauri::command]
async fn cloud_settings(app: AppHandle, key: Option<String>, user_id: Option<String>, group_id: Option<String>, clear: Option<bool>) -> Result<Value, String> {
    let node = app.state::<Shared>().settings.lock().unwrap().node.clone();
    let cli = cli_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["--flavor".into(), flavor::CLI_FLAVOR.into(), "cloud".into()];
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if clear == Some(true) {
            args.push("clear".into());
        } else if key.is_some() || user_id.is_some() || group_id.is_some() {
            args.push("set".into());
            if key.is_some() {
                args.push("--key-stdin".into());
            }
            // An empty id clears that creator: passed as --user= so it is not read as a missing value
            if let Some(id) = user_id {
                args.push(format!("--user={id}"));
            }
            if let Some(id) = group_id {
                args.push(format!("--group={id}"));
            }
        }
        args.push("--json".into());
        let mut child = hidden_command(&node)
            .arg(&cli)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run {node}: {e}"))?;
        {
            use std::io::Write;
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            if let Some(key) = key {
                stdin.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
            }
            // Dropped here: the child sees the end of stdin
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|_| String::from_utf8_lossy(&output.stderr).trim().to_string())?;
        match value.get("error").and_then(|e| e.as_str()) {
            Some(error) => Err(error.to_string()),
            None => Ok(value),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/** The daemon settings, read only: one file for every game, shared by Quack and Quack Dev */
#[tauri::command]
fn read_daemon_config() -> Value {
    let file = appdata().join("quack").join("config.json");
    let parsed = fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
    json!({ "path": file.to_string_lossy(), "config": parsed })
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.trim_end_matches('\\').to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/** Only a registered game's folder, or something inside it, may be opened from a window */
fn is_inside_registered(app: &AppHandle, target: &Path) -> bool {
    let state = app.state::<Shared>().last_state.lock().unwrap().clone();
    let target = normalized(target);
    if target.split('\\').any(|part| part == "..") {
        return false;
    }
    state["places"].as_array().into_iter().flatten().any(|place| {
        place["folder"].as_str().is_some_and(|folder| {
            let folder = normalized(Path::new(folder));
            target == folder || target.starts_with(&format!("{folder}\\"))
        })
    })
}

fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/** A code editor found on this computer, for "Open in …" */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Editor {
    /** Stable across updates: a VS Code fork's applicationName ("code", "cursor"), else fixed */
    id: String,
    name: String,
    /** The GUI executable itself, never a `.cmd`: cmd.exe reads `&` or `|` in a folder name as
     * a second command. The window never sees it; it names an editor by id only. */
    #[serde(skip)]
    exe: PathBuf,
    /** When the editor last wrote its own state (unix seconds, 0 = unknown): Windows' launch
     * counter (UserAssist) reads 0 runs for every editor on Windows 11 (measured 09/11/26), so
     * the last time the editor was used is the best sign of which one the user works in */
    last_used: u64,
}

fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/** The newest modification time among the files right inside each folder */
fn newest_inside(dirs: &[PathBuf]) -> u64 {
    dirs.iter()
        .filter_map(|dir| fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .map(|entry| modified_secs(&entry.path()))
        .max()
        .unwrap_or(0)
}

/**
 * A VS Code fork installed in `dir` (VS Code, Insiders, Cursor, Windsurf, VSCodium, Antigravity,
 * …): every one carries `resources\app\product.json`, at the top or one versioned folder down,
 * and its executable is `<nameShort>.exe`. Its state is in `<appdata>\<nameShort>\User`.
 */
fn vscode_fork_in(dir: &Path, appdata: &Path) -> Option<Editor> {
    let product = std::iter::once(dir.to_path_buf())
        .chain(fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()))
        .map(|root| root.join("resources").join("app").join("product.json"))
        .find(|p| p.is_file())?;
    let product: Value = serde_json::from_str(&fs::read_to_string(product).ok()?).ok()?;
    // dataFolderName is VS Code's own field: an Electron app that only looks alike has none
    product.get("dataFolderName")?;
    let short = product["nameShort"].as_str()?;
    let exe = Some(dir.join(format!("{short}.exe"))).filter(|p| p.is_file()).or_else(|| {
        // Not named after nameShort: the one executable there that is not its uninstaller
        let mut found = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            name.ends_with(".exe") && !name.starts_with("unins")
        });
        let only = found.next()?;
        found.next().is_none().then_some(only)
    })?;
    let user = appdata.join(short).join("User");
    let global = user.join("globalStorage");
    Some(Editor {
        id: product["applicationName"].as_str().unwrap_or(short).to_lowercase(),
        name: product["nameLong"].as_str().unwrap_or(short).to_string(),
        exe,
        last_used: [modified_secs(&global.join("storage.json")), modified_secs(&global.join("state.vscdb")), modified_secs(&user.join("workspaceStorage"))]
            .into_iter()
            .max()
            .unwrap_or(0),
    })
}

/** The folders the editors are looked for in, and where they keep their state */
struct EditorRoots {
    /** Install folders' parents: %LOCALAPPDATA%\Programs, %ProgramFiles%, %ProgramFiles(x86)% */
    installs: Vec<PathBuf>,
    /** Install folders named directly: the parent of each `bin` folder on PATH */
    on_path: Vec<PathBuf>,
    appdata: PathBuf,
    local_appdata: PathBuf,
}

impl EditorRoots {
    fn of_this_computer() -> Self {
        let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let local_appdata = env("LOCALAPPDATA").unwrap_or_default();
        let installs = [Some(local_appdata.join("Programs")), env("ProgramFiles"), env("ProgramFiles(x86)")]
            .into_iter()
            .flatten()
            .collect();
        let on_path = std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .filter(|dir| dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("bin")))
                    .filter_map(|dir| dir.parent().map(Path::to_path_buf))
                    .collect()
            })
            .unwrap_or_default();
        EditorRoots { installs, on_path, appdata: appdata(), local_appdata }
    }
}

/** Every editor installed, each once, in no particular order */
fn find_editors(roots: &EditorRoots) -> Vec<Editor> {
    let mut found: Vec<Editor> = Vec::new();
    let mut add = |editor: Editor| {
        if !found.iter().any(|e| e.id == editor.id) {
            found.push(editor);
        }
    };
    let dirs = roots
        .installs
        .iter()
        .filter_map(|parent| fs::read_dir(parent).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .chain(roots.on_path.iter().cloned())
        .filter(|p| p.is_dir());
    for dir in dirs {
        if let Some(editor) = vscode_fork_in(&dir, &roots.appdata) {
            add(editor);
        }
    }
    // Two editors that are not VS Code underneath, each in its installer's default folder
    let zed_data = roots.local_appdata.join("Zed").join("db");
    let zed_used = fs::read_dir(&zed_data).map(|d| d.flatten().map(|e| e.path()).collect::<Vec<_>>()).unwrap_or_default();
    let others = [
        ("zed", "Zed", vec![roots.local_appdata.join("Programs").join("Zed").join("Zed.exe")], newest_inside(&zed_used)),
        (
            "sublime_text",
            "Sublime Text",
            roots.installs.iter().map(|p| p.join("Sublime Text").join("sublime_text.exe")).collect(),
            modified_secs(&roots.appdata.join("Sublime Text").join("Local").join("Session.sublime_session")),
        ),
    ];
    for (id, name, candidates, last_used) in others {
        if let Some(exe) = candidates.into_iter().find(|p| p.is_file()) {
            add(Editor { id: id.into(), name: name.into(), exe, last_used });
        }
    }
    found
}

/** The user's pick first (when still installed), then the one used last, then by name */
fn rank_editors(mut editors: Vec<Editor>, preferred: Option<&str>) -> Vec<Editor> {
    editors.sort_by(|a, b| {
        let picked = |e: &Editor| Some(e.id.as_str()) == preferred;
        picked(b).cmp(&picked(a)).then(b.last_used.cmp(&a.last_used)).then_with(|| a.name.cmp(&b.name))
    });
    editors
}

fn editors_for(app: &AppHandle) -> Vec<Editor> {
    let preferred = app.state::<Shared>().settings.lock().unwrap().editor.clone();
    rank_editors(find_editors(&EditorRoots::of_this_computer()), preferred.as_deref())
}

/** The editors on this computer, the one "Open in …" uses first */
#[tauri::command]
fn editors(app: AppHandle) -> Vec<Editor> {
    editors_for(&app)
}

#[tauri::command]
fn open_path(app: AppHandle, path: String, editor: bool) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_inside_registered(&app, &target) {
        return Err("only a registered game's folder can be opened".into());
    }
    let result = if editor {
        let Some(editor) = editors_for(&app).into_iter().next() else { return Err("no code editor was found".into()) };
        Command::new(editor.exe).arg(&path).spawn()
    } else {
        Command::new("explorer").arg(&path).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle, place_id: Option<String>, view: Option<String>, id: Option<String>) {
    if let Some(tray) = app.get_webview_window("tray") {
        hide(&tray);
    }
    show_main_window(&app);
    let _ = app.emit_to("main", "navigate", json!({ "placeId": place_id, "view": view, "id": id }));
}

#[tauri::command]
fn tray_fit(app: AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("tray") {
        let _ = window.set_size(LogicalSize::new(TRAY_WIDTH, height.clamp(120.0, 720.0)));
        place_tray(&app, &window);
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/** The panel's Esc: hides through hide() here, which also stops its WebView2 */
#[tauri::command]
fn hide_window(window: WebviewWindow) {
    hide(&window);
}

/**
 * Shows the window and its WebView2. A window hidden by Windows alone leaves its WebView2
 * thinking it is on screen: it keeps a compositor and renderer running for a page nobody sees.
 */
fn show(window: &WebviewWindow) {
    let webview: &tauri::Webview = window.as_ref();
    let _ = webview.show();
    let _ = window.show();
}

/** Hides the window and tells its WebView2 (SetIsVisible false), which then stops drawing */
fn hide(window: &WebviewWindow) {
    let _ = window.hide();
    let webview: &tauri::Webview = window.as_ref();
    let _ = webview.hide();
}

/**
 * The WebView2 folder of both windows. They run with --disable-gpu (additionalBrowserArgs in
 * both tauri confs), and WebView2 refuses to start with other arguments in a folder another
 * process still uses (0x8007139F, seen in Quack Presence next to its older version still
 * open). A folder only this configuration uses is never shared with a version from before it.
 * If the arguments change again, the folder's name changes with them.
 */
const WEBVIEW_DIR: &str = "webview-sem-gpu";

/** Builds a window of tauri.conf.json (both have "create": false) in WEBVIEW_DIR */
fn build_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let config = app.config().app.windows.iter().find(|w| w.label == label).cloned().ok_or(tauri::Error::WindowNotFound)?;
    let dir = app.path().app_local_data_dir()?.join(WEBVIEW_DIR);
    tauri::WebviewWindowBuilder::from_config(app, &config)?.data_directory(dir).build()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show(&window);
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/** Above the tray icon (or below it, for a taskbar at the top), kept on its monitor */
fn place_tray(app: &AppHandle, window: &WebviewWindow) {
    let Some((ix, iy, iw, ih)) = *app.state::<Shared>().tray_rect.lock().unwrap() else { return };
    let Ok(size) = window.outer_size() else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let monitor = app.monitor_from_point(ix + iw / 2.0, iy + ih / 2.0).ok().flatten();
    let (mx, my, mw, mh) = match &monitor {
        Some(m) => {
            let area = m.work_area();
            (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64)
        }
        None => (0.0, 0.0, f64::MAX, f64::MAX),
    };
    let (x, y) = tray_position((ix, iy, iw, ih), (w, h), (mx, my, mw, mh));
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/** Panel position for an icon rect, a panel size and a monitor work area (all x, y, w, h) */
fn tray_position(icon: (f64, f64, f64, f64), panel: (f64, f64), area: (f64, f64, f64, f64)) -> (f64, f64) {
    let (ix, iy, iw, ih) = icon;
    let (w, h) = panel;
    let (mx, my, mw, mh) = area;
    // clamp panics when its bounds cross, which they do on a work area narrower (or shorter)
    // than the panel: the high bound never goes below the low one
    let x_low = mx + TRAY_GAP;
    let x = (ix + iw / 2.0 - w / 2.0).clamp(x_low, (mx + mw - w - TRAY_GAP).max(x_low));
    let below = iy < my + mh / 2.0;
    let y = if below { iy + ih + TRAY_GAP } else { iy - h - TRAY_GAP };
    let y = y.clamp(my, (my + mh - h).max(my));
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_share_the_webview2_arguments_in_both_flavors() {
        // The official conf replaces the whole windows array, so both files carry the same
        // arguments and "create": false. Windows with different arguments cannot share one
        // WebView2: the second would not open. Without the GPU the windows draw the same and
        // WebView2 uses ~60 MB less (measured 12/11/26); the --disable-features is what wry
        // passes by default when a window has no arguments of its own.
        let dev: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let official: Value = serde_json::from_str(include_str!("../tauri.official.conf.json")).unwrap();
        for conf in [&dev, &official] {
            let windows = conf["app"]["windows"].as_array().unwrap();
            assert_eq!(windows.len(), 2);
            for w in windows {
                let args = w["additionalBrowserArgs"].as_str().unwrap_or("");
                assert_eq!(args, "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu", "{}", w["label"]);
                // Built by build_window, in WEBVIEW_DIR
                assert_eq!(w["create"], false, "{} would be built outside build_window", w["label"]);
            }
        }
    }

    #[test]
    fn the_token_reaches_the_hub_on_stdin_and_stdin_then_ends() {
        let mut child = Command::new("node")
            .args(["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('['+s+']'))"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let token = approval::new_token().unwrap();
        write_token(&mut child, &token);
        let output = child.wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), format!("[{token}\n]"), "the whole token, then the end of stdin");
    }

    #[test]
    fn the_poll_announces_each_waiting_write_once_and_rechecks_a_token_the_hub_does_not_take() {
        let state = |pending: u64, started: u64| json!({ "capabilities": ["queue", "approvals"], "approvals": pending, "startedAt": started });
        let list = |ids: &[&str], answerable: bool| json!({ "approvals": ids.iter().map(|id| json!({ "id": id, "title": "Quack: set" })).collect::<Vec<_>>(), "answerable": answerable });
        let mut watch = ApprovalWatch::default();
        let mut reads = 0;

        // First poll: the token is checked even with nothing waiting
        assert!(watch.poll(&state(0, 1), Some("t"), |_| { reads += 1; Ok(list(&[], true)) }).is_empty());
        assert_eq!((reads, watch.answerable), (1, Some(true)));
        // Nothing waits and the token is known good: no read
        watch.poll(&state(0, 1), Some("t"), |_| { reads += 1; Ok(list(&[], true)) });
        assert_eq!(reads, 1);

        // A write waits: announced once, listed while it waits
        let fresh = watch.poll(&state(1, 1), Some("t"), |_| Ok(list(&["a"], true)));
        assert_eq!(fresh.len(), 1);
        assert!(watch.poll(&state(1, 1), Some("t"), |_| Ok(list(&["a"], true))).is_empty(), "not announced twice");
        assert!(watch.poll(&state(1, 1), Some("t"), |_| Err("down".into())).is_empty(), "a failed read announces nothing");
        assert!(watch.poll(&state(1, 1), Some("t"), |_| Ok(list(&["a"], true))).is_empty(), "nor after it");
        assert_eq!(watch.list.as_array().unwrap().len(), 1);
        assert!(watch.is_waiting("a"), "its toast is kept");
        assert!(!watch.just_emptied());
        // Answered: the flash stops once
        watch.poll(&state(0, 1), Some("t"), |_| panic!("no read"));
        assert!(watch.just_emptied());
        assert!(!watch.is_waiting("a"), "answered: its toast is let go");
        assert_eq!(watch.list, json!([]));

        // A new hub (another start time): checked again; one that refuses the token is checked every poll
        let mut reads = 0;
        watch.poll(&state(0, 2), Some("t"), |_| { reads += 1; Ok(list(&[], false)) });
        watch.poll(&state(0, 2), Some("t"), |_| { reads += 1; Ok(list(&[], false)) });
        assert_eq!((reads, watch.answerable), (2, Some(false)));

        // A hub without approvals (an older build): nothing to answer, no notice
        watch.poll(&json!({ "capabilities": ["queue"] }), Some("t"), |_| panic!("no read"));
        assert_eq!(watch.answerable, None);
    }

    #[test]
    fn a_running_session_is_not_ending_so_the_hub_still_restarts() {
        // The shutdown side only shows on a real shutdown; this keeps the check from ever
        // blocking the restart after a crash or `quack restart-hub`
        assert!(!session_ending());
    }

    #[test]
    fn tray_panel_sits_above_a_bottom_taskbar_and_stays_on_screen() {
        // 2560x1440 with a 48 px taskbar; icon near the right edge
        let (x, y) = tray_position((2400.0, 1400.0, 24.0, 24.0), (400.0, 500.0), (0.0, 0.0, 2560.0, 1392.0));
        assert_eq!(y, 1400.0 - 500.0 - TRAY_GAP);
        assert!(x + 400.0 <= 2560.0 - TRAY_GAP + 0.001, "kept inside the right edge");
    }

    #[test]
    fn a_right_click_on_the_icon_opens_the_panel_too() {
        let click = |button, button_state| TrayIconEvent::Click {
            id: TRAY_ID.into(),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect::default(),
            button,
            button_state,
        };
        assert!(opens_tray_panel(click(MouseButton::Right, MouseButtonState::Up)).is_some());
        assert!(opens_tray_panel(click(MouseButton::Left, MouseButtonState::Up)).is_some());
        assert!(opens_tray_panel(click(MouseButton::Left, MouseButtonState::Down)).is_none(), "only the release");
        assert!(opens_tray_panel(click(MouseButton::Middle, MouseButtonState::Up)).is_none());
    }

    #[test]
    fn the_tray_panel_has_the_quit_the_menu_had() {
        let html = include_str!("../../ui/tray.html");
        let js = include_str!("../../ui/tray.js");
        assert!(html.contains(r#"id="quit""#) && js.contains(r#"invoke("quit")"#));
    }

    #[test]
    fn the_poll_wakes_up_when_its_own_hub_exits() {
        // A hub that stops 200 ms in: the app hears of it then, not at the end of the poll
        let child = Command::new("node").args(["-e", "setTimeout(() => {}, 200)"]).spawn().unwrap();
        let hub = Mutex::new(Some(child));
        let started = Instant::now();
        assert!(sleep_until_own_hub_exits(&hub, Duration::from_secs(3)));
        assert!(started.elapsed() < Duration::from_millis(1500), "took {:?}", started.elapsed());
        // No hub of its own (another install's): it sleeps the whole poll
        let started = Instant::now();
        assert!(!sleep_until_own_hub_exits(&Mutex::new(None), Duration::from_millis(200)));
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn a_hub_call_to_a_closed_port_fails_fast() {
        // Free a port, then call it: on Windows a plain connect took ~2 s to be refused
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let started = Instant::now();
        assert!(hub_call(port, "GET", "/api/state", None).is_err());
        assert!(started.elapsed() < Duration::from_millis(1000), "took {:?}", started.elapsed());
        assert!(!port_open(port));
    }

    #[test]
    fn tray_panel_on_a_work_area_narrower_than_itself_does_not_panic() {
        let (x, y) = tray_position((100.0, 700.0, 24.0, 24.0), (400.0, 500.0), (0.0, 0.0, 300.0, 400.0));
        assert_eq!(x, TRAY_GAP);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn the_hub_entry_drops_the_verbatim_prefix_node_cannot_start() {
        assert_eq!(
            without_verbatim(PathBuf::from(r"\\?\C:\Users\E\AppData\Local\Quack Dev\resources\hub\hub.mjs")),
            PathBuf::from(r"C:\Users\E\AppData\Local\Quack Dev\resources\hub\hub.mjs")
        );
        assert_eq!(without_verbatim(PathBuf::from(r"\\?\UNC\nas\share\hub.mjs")), PathBuf::from(r"\\nas\share\hub.mjs"));
        assert_eq!(without_verbatim(PathBuf::from(r"C:\plain\hub.mjs")), PathBuf::from(r"C:\plain\hub.mjs"));
    }

    #[test]
    fn the_plugin_is_copied_only_when_its_bytes_change() {
        let dir = std::env::temp_dir().join(format!("quack-plugin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let from = dir.join("shipped.rbxmx");
        let to = dir.join("Roblox").join("Plugins").join("Quack.rbxmx");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&from, "v1").unwrap();
        assert!(copy_if_changed(&from, &to).unwrap(), "first install, Plugins folder made");
        assert_eq!(fs::read_to_string(&to).unwrap(), "v1");
        assert!(!copy_if_changed(&from, &to).unwrap(), "same bytes: left alone");
        fs::write(&from, "v2").unwrap();
        assert!(copy_if_changed(&from, &to).unwrap(), "new build: replaced");
        assert_eq!(fs::read_to_string(&to).unwrap(), "v2");
        assert!(!to.with_extension("part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // Not every app update changes the plugin: the plugin keeps the version of the app that last
    // changed its code, and only new code asks Ender to reopen his places (on Official that drops
    // Astral's Studio for a moment)
    #[test]
    fn the_plugin_keeps_the_version_of_the_app_that_last_changed_its_code() {
        let dir = std::env::temp_dir().join(format!("quack-plugin-stamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let to = dir.join("Roblox").join("Plugins").join("Quack.rbxmx");
        let shipped = |code: &str| format!("{code}\nQuackService.APP_VERSION = \"{PLUGIN_VERSION_PLACEHOLDER}\"\n");
        let installed = || stamped_version(&fs::read_to_string(&to).unwrap());
        let v1 = shipped("print(1)");
        assert_eq!(stamped_version(&v1), None, "the shipped plugin carries no version");
        assert_eq!(install_plugin_file(v1.as_bytes(), "1.0.7", &to).unwrap(), PluginInstall::Updated, "first install");
        assert_eq!(fs::read_to_string(&to).unwrap(), "print(1)\nQuackService.APP_VERSION = \"1.0.7\"\n");
        assert_eq!(install_plugin_file(v1.as_bytes(), "1.0.8", &to).unwrap(), PluginInstall::Unchanged, "same code");
        assert_eq!(installed().as_deref(), Some("1.0.7"), "the app version that brought this code");
        let v2 = shipped("print(2)");
        assert_eq!(install_plugin_file(v2.as_bytes(), "1.0.9", &to).unwrap(), PluginInstall::Updated, "new code");
        assert_eq!(fs::read_to_string(&to).unwrap(), "print(2)\nQuackService.APP_VERSION = \"1.0.9\"\n");
        // Built straight into Plugins (never stamped): the same code gets a version, quietly
        fs::write(&to, &v2).unwrap();
        assert_eq!(install_plugin_file(v2.as_bytes(), "1.0.10", &to).unwrap(), PluginInstall::Unchanged);
        assert_eq!(installed().as_deref(), Some("1.0.10"));
        // A plugin from before the stamp has no such line: the shipped one is new code
        fs::write(&to, "print(2)\n").unwrap();
        assert_eq!(installed(), None);
        assert_eq!(install_plugin_file(v2.as_bytes(), "1.0.10", &to).unwrap(), PluginInstall::Updated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_command_folder_joins_the_path_once_and_keeps_every_other_entry() {
        let dir = Path::new(r"C:\Users\Ender\AppData\Local\Quack Dev\bin");
        assert_eq!(path_with("", dir).as_deref(), Some(r"C:\Users\Ender\AppData\Local\Quack Dev\bin"));
        assert_eq!(
            path_with(r"%USERPROFILE%\.cargo\bin;C:\Tools;", dir).as_deref(),
            Some(r"%USERPROFILE%\.cargo\bin;C:\Tools;C:\Users\Ender\AppData\Local\Quack Dev\bin"),
            "unexpanded entries stay as they were"
        );
        assert_eq!(path_with(r"C:\Tools; c:/users/ender/appdata/local/quack dev/bin\ ;D:\x", dir), None, "already there, any case or slash");
        assert!(path_with(r"C:\Users\Ender\AppData\Local\Quack\bin", dir).is_some(), "Official's folder is not Dev's");
    }

    #[test]
    fn the_path_lock_is_held_by_one_at_a_time_and_a_dead_holder_leaves_it_free() {
        let file = std::env::temp_dir().join(format!("quack-path-lock-{}", std::process::id()));
        let _ = fs::remove_file(&file);
        let first = PathLock::take(&file).expect("free: taken");
        let waited = thread::spawn({
            let file = file.clone();
            move || {
                let started = Instant::now();
                let lock = PathLock::take(&file);
                (lock.is_some(), started.elapsed())
            }
        });
        thread::sleep(Duration::from_millis(400));
        drop(first);
        let (taken, after) = waited.join().unwrap();
        assert!(taken && after >= Duration::from_millis(300), "the second waits for the first: {after:?}");
        // The file stays after a holder is gone (a crash too): the next one takes it at once
        assert!(file.exists());
        let started = Instant::now();
        assert!(PathLock::take(&file).is_some());
        assert!(started.elapsed() < Duration::from_millis(100), "a lock nobody holds is not waited for");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn the_command_runs_the_shipped_cli_with_its_own_flavor() {
        assert_eq!(cli_shim("node", "dev"), "@\"node\" \"%~dp0..\\resources\\hub\\cli.mjs\" --flavor dev %*\r\n");
        assert_eq!(
            cli_shim(r"C:\Program Files\nodejs\node.exe", "official"),
            "@\"C:\\Program Files\\nodejs\\node.exe\" \"%~dp0..\\resources\\hub\\cli.mjs\" --flavor official %*\r\n"
        );
    }

    #[test]
    fn git_bash_gets_its_own_command_with_the_arguments_untouched() {
        assert_eq!(
            sh_shim(r"C:\Program Files\nodejs\node.exe", "dev"),
            "#!/bin/sh\nexec 'C:/Program Files/nodejs/node.exe' \"$(dirname \"$0\")/../resources/hub/cli.mjs\" --flavor dev \"$@\"\n"
        );
        assert!(sh_shim(r"C:\it's\node.exe", "official").starts_with("#!/bin/sh\nexec 'C:/it'\\''s/node.exe' "));
    }

    #[test]
    fn every_editor_found_here_is_launched_as_an_executable_never_through_a_script() {
        // cmd.exe would read & or | in a folder name as a second command
        for editor in find_editors(&EditorRoots::of_this_computer()) {
            assert!(editor.exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")), "{editor:?}");
            assert!(editor.exe.is_file(), "{editor:?}");
        }
    }

    fn fake_fork(dir: &Path, exe: &str, product: Value) {
        fs::create_dir_all(dir.join("resources").join("app")).unwrap();
        fs::write(dir.join("resources").join("app").join("product.json"), product.to_string()).unwrap();
        fs::write(dir.join(exe), "").unwrap();
        fs::write(dir.join("unins000.exe"), "").unwrap();
    }

    #[test]
    fn the_editors_installed_are_found_with_the_time_each_was_last_used() {
        let root = std::env::temp_dir().join(format!("quack-editors-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let programs = root.join("Local").join("Programs");
        let program_files = root.join("Program Files");
        let appdata = root.join("Roaming");
        let fork = |short: &str, app: &str| json!({ "nameShort": short, "nameLong": format!("{short} Long"), "applicationName": app, "dataFolderName": format!(".{app}") });
        // Per-user, with the state it writes when used
        fake_fork(&programs.join("Antigravity IDE"), "Antigravity IDE.exe", fork("Antigravity IDE", "antigravity-ide"));
        let global = appdata.join("Antigravity IDE").join("User").join("globalStorage");
        fs::create_dir_all(&global).unwrap();
        fs::write(global.join("storage.json"), "{}").unwrap();
        // Machine-wide, the product.json one versioned folder down
        let code = program_files.join("Microsoft VS Code");
        fake_fork(&code.join("abc123"), "unused.exe", fork("Code", "code"));
        fs::write(code.join("Code.exe"), "").unwrap();
        // The same editor again in a second place is listed once
        fake_fork(&program_files.join("Antigravity IDE"), "Antigravity IDE.exe", fork("Antigravity IDE", "antigravity-ide"));
        // An Electron app with a product.json that is not VS Code's
        fs::create_dir_all(programs.join("Notion").join("resources").join("app")).unwrap();
        fs::write(programs.join("Notion").join("resources").join("app").join("product.json"), r#"{"nameShort":"Notion"}"#).unwrap();
        fs::write(programs.join("Notion").join("Notion.exe"), "").unwrap();
        // Zed, used through its database
        fs::create_dir_all(programs.join("Zed")).unwrap();
        fs::write(programs.join("Zed").join("Zed.exe"), "").unwrap();
        fs::create_dir_all(root.join("Local").join("Zed").join("db").join("0-stable")).unwrap();
        fs::write(root.join("Local").join("Zed").join("db").join("0-stable").join("db.sqlite"), "").unwrap();

        let roots = EditorRoots { installs: vec![programs.clone(), program_files.clone()], on_path: vec![], appdata, local_appdata: root.join("Local") };
        let mut found = find_editors(&roots);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["antigravity-ide", "code", "zed"]);
        assert_eq!(found[0].exe, programs.join("Antigravity IDE").join("Antigravity IDE.exe"), "the first place found wins");
        assert_eq!(found[0].name, "Antigravity IDE Long");
        assert!(found[0].last_used > 0, "its storage.json dates its last use");
        assert_eq!(found[1].exe, code.join("Code.exe"));
        assert_eq!(found[1].last_used, 0, "never opened: no state");
        assert!(found[2].last_used > 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_editor_picked_comes_first_then_the_one_used_last() {
        let editor = |id: &str, last_used: u64| Editor { id: id.into(), name: id.to_uppercase(), exe: PathBuf::new(), last_used };
        let all = vec![editor("code", 100), editor("zed", 300), editor("cursor", 0), editor("antigravity-ide", 0)];
        let order = |preferred| rank_editors(all.clone(), preferred).into_iter().map(|e| e.id).collect::<Vec<_>>();
        assert_eq!(order(None), ["zed", "code", "antigravity-ide", "cursor"]);
        assert_eq!(order(Some("cursor")), ["cursor", "zed", "code", "antigravity-ide"]);
        // A pick that was uninstalled since falls back to the one used last
        assert_eq!(order(Some("sublime_text"))[0], "zed");
    }
}

/** Either button opens the panel, on release, like the taskbar's own icons */
fn opens_tray_panel(event: TrayIconEvent) -> Option<Rect> {
    match event {
        TrayIconEvent::Click { button: MouseButton::Left | MouseButton::Right, button_state: MouseButtonState::Up, rect, .. } => Some(rect),
        _ => None,
    }
}

fn toggle_tray(app: &AppHandle, rect: (f64, f64, f64, f64)) {
    let Some(window) = app.get_webview_window("tray") else { return };
    let shared = app.state::<Shared>();
    if window.is_visible().unwrap_or(false) {
        hide(&window);
        return;
    }
    // Clicking the icon while the panel is open first takes its focus, which hides it: that
    // click must not open it again
    if shared.tray_hidden_at.lock().unwrap().is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    *shared.tray_rect.lock().unwrap() = Some(rect);
    place_tray(app, &window);
    show(&window);
    let _ = window.set_focus();
    let _ = app.emit_to("tray", "tray-shown", ());
}

/** The poll's start of a hub: at launch, and again after its own hub exits or stops answering */
fn spawn_hub(app: &AppHandle) {
    // Windows ends the hub with the session; a node started now cannot initialise
    // (0xc0000142) and shows an error popup on every shutdown (08/11/26). Only the poll's
    // restarts wait on this: the "Restart hub" click and an update's takeover never fire then.
    if session_ending() {
        return;
    }
    spawn_hub_with(app, false);
}

/** True while Windows is logging off or shutting down this session (SM_SHUTTINGDOWN) */
#[cfg(windows)]
fn session_ending() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
    }
    const SM_SHUTTINGDOWN: i32 = 0x2000;
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(windows))]
fn session_ending() -> bool {
    false
}

/**
 * Starts the hub this app ships. `takeover`: it replaces the hub running on the port, which
 * stays up until the new one is ready (the port is closed for ms, not for a whole start).
 */
fn spawn_hub_with(app: &AppHandle, takeover: bool) {
    let shared = app.state::<Shared>();
    let settings = shared.settings.lock().unwrap().clone();
    let mut hub = shared.hub.lock().unwrap();
    if let Some(child) = hub.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return; // still starting
        }
    }
    let mut last = shared.last_spawn.lock().unwrap();
    if last.is_some_and(|at| at.elapsed() < RESPAWN_AFTER) {
        return;
    }
    *last = Some(Instant::now());
    let token = match approval::new_token() {
        Ok(token) => token,
        Err(error) => return eprintln!("Could not make the approval token: {error}"),
    };
    match start_hub_process(&settings, &hub_entry(app, &settings), takeover, &token) {
        Ok(child) => {
            *hub = Some(child);
            remember_token(&token);
            *shared.approval_token.lock().unwrap() = Some(token);
        }
        Err(error) => eprintln!("Could not start the hub: {error}"),
    }
}

/** The token saved for the next app instance (the hub outlives this one) */
fn remember_token(token: &str) {
    if let Err(error) = approval::save_token(&settings_dir(), flavor::IDENTIFIER, token) {
        eprintln!("Could not save the approval token: {error}");
    }
}

/**
 * The hub process itself, logging to the flavor's hub log; needs no running app (see main).
 * `token` answers its approvals: written on its stdin, then stdin closes (--token-stdin).
 */
fn start_hub_process(settings: &Settings, entry: &Path, takeover: bool, token: &str) -> Result<Child, String> {
    // Each flavor's hub writes its own log: shared, the two read as one
    let log_file = appdata().join("quack").join(flavor::HUB_LOG);
    let _ = fs::create_dir_all(log_file.parent().unwrap());
    let mut log = OpenOptions::new().create(true).append(true).open(&log_file).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let _ = writeln!(log, "===== quack app starts {} with {} =====", entry.display(), settings.node);
    }
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = hidden_command(&settings.node);
    command
        .arg(entry)
        .args(["--port", &settings.hub_port.to_string(), "--registry", &settings.registry, "--token-stdin"])
        .stdin(Stdio::piped())
        .stdout(log)
        .stderr(log_err);
    if takeover {
        command.arg("--takeover");
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    write_token(&mut child, token);
    Ok(child)
}

/** The token on the child's stdin, then the end of stdin */
fn write_token(child: &mut Child, token: &str) {
    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{token}");
        // Dropped here: the hub sees the end of stdin and keeps the token
    }
}

fn tray_icon_for(online: bool, state: &Value) -> (&'static str, &'static [u8]) {
    if !online {
        return ("bad", ICON_BAD);
    }
    if state["paused"].as_bool().unwrap_or(false) {
        return ("paused", ICON_PAUSED);
    }
    let conflicts: u64 = state["places"].as_array().into_iter().flatten().filter_map(|p| p["conflicts"].as_u64()).sum();
    let waiting = state["pending"].as_array().is_some_and(|p| !p.is_empty()) || state["approvals"].as_u64().unwrap_or(0) > 0;
    if conflicts > 0 || waiting { ("warn", ICON_WARN) } else { ("ok", ICON_OK) }
}

fn tooltip_for(language: &str, online: bool, state: &Value) -> String {
    let pt = language == "pt";
    if !online {
        return if pt { format!("{}: hub fora do ar", flavor::NAME) } else { format!("{}: hub offline", flavor::NAME) };
    }
    if state["paused"].as_bool().unwrap_or(false) {
        return if pt { format!("{}: pausado", flavor::NAME) } else { format!("{}: paused", flavor::NAME) };
    }
    let connected = state["sessions"].as_array().into_iter().flatten().filter(|s| s["studioConnected"].as_bool() == Some(true)).count();
    let conflicts: u64 = state["places"].as_array().into_iter().flatten().filter_map(|p| p["conflicts"].as_u64()).sum();
    let mut text = if pt { format!("{}: {connected} conectado(s)", flavor::NAME) } else { format!("{}: {connected} connected", flavor::NAME) };
    if conflicts > 0 {
        text += &if pt { format!(", {conflicts} conflito(s)") } else { format!(", {conflicts} conflict(s)") };
    }
    text
}

/**
 * What the poll knows of the hub's approvals. The list is read only while the hub reports one
 * waiting, or until the hub says it takes this app's token (a new hub, or a new token, is
 * checked again: one that just started may not have read its stdin yet).
 */
#[derive(Default)]
struct ApprovalWatch {
    /** The writes waiting, as GET /api/approvals gave them (what the window shows) */
    list: Value,
    /** Whether the hub takes this app's answers; None for a hub without approvals */
    answerable: Option<bool>,
    /** The hub (its start time) and the token `answerable` is about */
    checked: Option<(Value, Option<String>)>,
    known: std::collections::HashSet<String>,
    waiting: bool,
    emptied: bool,
}

impl ApprovalWatch {
    /** One poll's /api/state (Null when offline); returns the approvals new since the last one */
    fn poll(&mut self, state: &Value, token: Option<&str>, fetch: impl FnOnce(Option<&str>) -> Result<Value, String>) -> Vec<Value> {
        let was_waiting = self.waiting;
        self.emptied = false;
        let supported = state["capabilities"].as_array().is_some_and(|c| c.iter().any(|x| x == "approvals"));
        let key = (state["startedAt"].clone(), token.map(String::from));
        let pending = state["approvals"].as_u64().unwrap_or(0);
        if !supported || (pending == 0 && self.answerable == Some(true) && self.checked.as_ref() == Some(&key)) {
            if !supported {
                self.answerable = None;
                self.checked = None;
            }
            self.list = json!([]);
            self.known.clear();
            self.waiting = false;
            self.emptied = was_waiting;
            return Vec::new();
        }
        // A failed read keeps what was known: the next poll must not announce the same write again
        let Ok(answer) = fetch(token) else { return Vec::new() };
        self.answerable = answer["answerable"].as_bool();
        self.checked = Some(key);
        self.list = if answer["approvals"].is_array() { answer["approvals"].clone() } else { json!([]) };
        let mut fresh = Vec::new();
        let mut now = std::collections::HashSet::new();
        for approval in self.list.as_array().into_iter().flatten() {
            if let Some(id) = approval["id"].as_str() {
                if !self.known.contains(id) {
                    fresh.push(approval.clone());
                }
                now.insert(id.to_string());
            }
        }
        self.waiting = !now.is_empty();
        self.emptied = was_waiting && !self.waiting;
        self.known = now;
        fresh
    }

    /** This write still waits for the user, as far as the last read knows */
    fn is_waiting(&self, id: &str) -> bool {
        self.known.contains(id)
    }

    /** The last write waiting was just answered (or expired): the taskbar stops flashing */
    fn just_emptied(&self) -> bool {
        self.emptied
    }
}

/**
 * A write started waiting for the user. In the background: the chime, the window back on the
 * taskbar minimized with its button flashing (never over a fullscreen game: the tray's native
 * menu lost the foreground to one, measured), and a toast whose click shows the popup.
 */
fn alert_approval(app: &AppHandle, language: &str, approval: &Value) -> Option<approval::ToastHold> {
    approval::play_chime();
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // tao: a hidden window minimized stays hidden but iconic, and the show then puts it
            // on the taskbar minimized. Its WebView2 stays hidden until the user brings it up
            // (Focused(true) in main), so only the window's own show here.
            let _ = window.minimize();
            let _ = window.show();
        }
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    }
    let (head, body) = approval::toast_text(language, approval["title"].as_str().unwrap_or_default());
    let handle = app.clone();
    match approval::show_toast(flavor::IDENTIFIER, head.clone(), body.clone(), APPROVAL_WAIT, move || show_main_window(&handle)) {
        Ok(hold) => Some(hold),
        Err(_) => {
            // No toast of its own (an unregistered app id): the plugin's, which has no click
            let _ = app.notification().builder().title(head).body(body).show();
            None
        }
    }
}

fn poll_loop(app: AppHandle) {
    let mut shown_icon = "";
    let mut shown_tooltip = String::new();
    let mut known_conflicts: Option<HashMap<String, u64>> = None;
    // The production errors not dismissed per place, and the places whose key cannot read them
    let mut known_errors: Option<HashMap<String, u64>> = None;
    let mut known_problems: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut known_choices: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut approvals = ApprovalWatch::default();
    // Each waiting write's toast, kept alive until that write is answered or gone
    let mut toasts: HashMap<String, approval::ToastHold> = HashMap::new();
    loop {
        let shared = app.state::<Shared>();
        let (port, language, notify) = {
            let s = shared.settings.lock().unwrap();
            (s.hub_port, s.language.clone(), s.notify)
        };
        let result = hub_call(port, "GET", "/api/state", None);
        let online = result.is_ok();
        let state = result.clone().unwrap_or(Value::Null);
        let token = shared.approval_token.lock().unwrap().clone();
        let fresh = approvals.poll(&state, token.as_deref(), |token| hub_call_with(port, "GET", "/api/approvals", None, token));
        match &result {
            Ok(state) => {
                // It came up: once it is gone, the next one starts at once (RESPAWN_AFTER)
                *shared.last_spawn.lock().unwrap() = None;
                *shared.last_state.lock().unwrap() = state.clone();
                // The writes waiting for an answer, and whether this app's answers count
                let _ = app.emit("hub-state", json!({ "online": true, "state": state, "approvals": approvals.list, "approvalsAnswerable": approvals.answerable }));
            }
            Err(error) => {
                let _ = app.emit("hub-state", json!({ "online": false, "error": error }));
                spawn_hub(&app);
            }
        }

        let (name, bytes) = tray_icon_for(online, &state);
        let tooltip = tooltip_for(&language, online, &state);
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if name != shown_icon {
                if let Ok(image) = Image::from_bytes(bytes) {
                    let _ = tray.set_icon(Some(image));
                    shown_icon = name;
                }
            }
            if tooltip != shown_tooltip {
                let _ = tray.set_tooltip(Some(&tooltip));
                shown_tooltip = tooltip;
            }
        }

        // A notification for each conflict that appeared since the last poll; the first poll
        // only learns what was already there
        if online {
            let mut now = HashMap::new();
            for place in state["places"].as_array().into_iter().flatten() {
                let id = place["placeId"].as_str().unwrap_or_default().to_string();
                let count = place["conflicts"].as_u64().unwrap_or(0);
                if let Some(before) = &known_conflicts {
                    if notify && count > *before.get(&id).unwrap_or(&0) {
                        let name = place["name"].as_str().unwrap_or(&id).to_string();
                        let body = if language == "pt" { format!("{name}: novo conflito") } else { format!("{name}: new conflict") };
                        let _ = app.notification().builder().title(flavor::NAME).body(body).show();
                    }
                }
                now.insert(id, count);
            }
            known_conflicts = Some(now);

            // A new production error (the hub checks each place once an hour): its own setting
            // turns it on, so it is told even with the conflict notifications off. A key that
            // cannot read a game's errors is told once, when it first shows up
            let mut errors_now = HashMap::new();
            let mut problems_now = std::collections::HashSet::new();
            for place in state["places"].as_array().into_iter().flatten() {
                let id = place["placeId"].as_str().unwrap_or_default().to_string();
                let name = place["name"].as_str().unwrap_or(&id).to_string();
                let count = place["newErrors"].as_u64().unwrap_or(0);
                if let Some(before) = &known_errors {
                    if count > *before.get(&id).unwrap_or(&0) {
                        let latest = &place["latestError"];
                        let message: String = latest["message"].as_str().unwrap_or_default().chars().take(140).collect();
                        let at = latest["at"].as_str().map(|a| format!(" ({a})")).unwrap_or_default();
                        let title = if language == "pt" { format!("{name}: erro novo em produção") } else { format!("{name}: new production error") };
                        let _ = app.notification().builder().title(title).body(format!("{message}{at}")).show();
                    }
                }
                errors_now.insert(id.clone(), count);
                if place["errorsProblem"].is_string() {
                    if known_errors.is_some() && !known_problems.contains(&id) {
                        let body = if language == "pt" {
                            format!("{name}: a chave da Open Cloud não lê os erros deste jogo (falta universe.analytics:read)")
                        } else {
                            format!("{name}: the Open Cloud key cannot read this game's errors (it lacks universe.analytics:read)")
                        };
                        let _ = app.notification().builder().title(flavor::NAME).body(body).show();
                    }
                    problems_now.insert(id);
                }
            }
            known_errors = Some(errors_now);
            known_problems = problems_now;

            // A connection waiting for the user's choice brings the window up, once per choice
            let mut current = std::collections::HashSet::new();
            for choice in state["pending"].as_array().into_iter().flatten() {
                if let Some(id) = choice["id"].as_str() {
                    if !known_choices.contains(id) {
                        show_main_window(&app);
                        let _ = app.emit_to("main", "choice", choice.clone());
                    }
                    current.insert(id.to_string());
                }
            }
            known_choices = current;

            // A write that started waiting: the chime, the taskbar flash and a toast, once each
            for approval in &fresh {
                if let (Some(hold), Some(id)) = (alert_approval(&app, &language, approval), approval["id"].as_str()) {
                    toasts.insert(id.to_string(), hold);
                }
            }
            if approvals.just_emptied() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.request_user_attention(None);
                }
            }
        }
        // An answered (or expired) write lets its toast's thread end now, not after the full wait
        toasts.retain(|id, _| approvals.is_waiting(id));
        if sleep_until_own_hub_exits(&shared.hub, POLL_EVERY) {
            // Its own hub stopped (quack restart-hub, a crash): the next one starts now, not at
            // the next poll; spawn_hub still holds back one that never came up
            spawn_hub(&app);
        }
    }
}

/** Sleeps `max`, or less when the hub this app started exits; true in that case */
fn sleep_until_own_hub_exits(hub: &Mutex<Option<Child>>, max: Duration) -> bool {
    let started = Instant::now();
    let was_running = matches!(hub.lock().unwrap().as_mut().map(|c| c.try_wait()), Some(Ok(None)));
    while started.elapsed() < max {
        thread::sleep(HUB_EXIT_CHECK_EVERY.min(max.saturating_sub(started.elapsed())));
        if was_running && !matches!(hub.lock().unwrap().as_mut().map(|c| c.try_wait()), Some(Ok(None))) {
            return true;
        }
    }
    false
}

/** Stop the hub this app started, with its daemons; a hub someone else started keeps running */
fn stop_own_hub(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let mut hub = shared.hub.lock().unwrap();
    let Some(child) = hub.as_mut() else { return };
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    let port = shared.settings.lock().unwrap().hub_port;
    if hub_call(port, "POST", "/api/shutdown", Some(&json!({}))).is_ok() {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
            thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
}

fn main() {
    let started_hidden = std::env::args().any(|arg| arg == "--hidden");
    // Managed before the builder runs: the windows in tauri.conf.json are created (and fire
    // focus events) before `setup`. Same folder Tauri's app_config_dir gives on Windows.
    let settings_file = appdata().join(flavor::IDENTIFIER).join("settings.json");
    let settings = fs::read_to_string(&settings_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default();
    // After an update click: the new hub starts now, while Tauri is still building the windows
    let (early_hub, early_token) = early_update_takeover(&settings).unzip();
    // A hub this app did not start (an earlier instance did; it outlives the app) answers to the
    // token that instance saved. A hub this app starts later replaces it with its own
    let approval_token = early_token.or_else(|| approval::load_token(&settings_dir(), flavor::IDENTIFIER));
    let shared = Shared {
        settings: Mutex::new(settings),
        settings_file,
        hub: Mutex::new(early_hub),
        approval_token: Mutex::new(approval_token),
        last_spawn: Mutex::new(None),
        last_state: Mutex::new(Value::Null),
        tray_rect: Mutex::new(None),
        tray_hidden_at: Mutex::new(None),
        ready_update: Mutex::new(None),
    };
    tauri::Builder::default()
        .manage(shared)
        // A second start shows the window, except the hub's own (--hidden, when a write waits and
        // it found no app polling): that one must not take the screen
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == "--hidden") {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            hub_get,
            hub_post,
            approval_answer,
            get_settings,
            set_settings,
            get_autostart,
            set_autostart,
            pick_folder,
            project_roots,
            make_folder,
            app_info,
            plugin_version,
            restart_hub,
            update_status,
            check_update,
            install_update,
            read_daemon_config,
            ai_clients,
            ai_rule,
            cloud_settings,
            editors,
            open_path,
            show_main,
            hide_window,
            tray_fit,
            quit
        ])
        .setup(move |app| {
            // Both windows are built here, in WEBVIEW_DIR, before any thread that may show one
            build_window(app.handle(), "main")?;
            build_window(app.handle(), "tray")?;
            // No native menu: Windows opens it under the cursor, over the taskbar, which covers
            // it whenever a fullscreen game keeps the foreground. Quit lives in the panel.
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(ICON_BAD)?)
                .tooltip(flavor::NAME)
                .on_tray_icon_event(|tray, event| {
                    if let Some(rect) = opens_tray_panel(event) {
                        let app = tray.app_handle();
                        let scale = app.get_webview_window("tray").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                        let position = rect.position.to_physical::<f64>(scale);
                        let size = rect.size.to_physical::<f64>(scale);
                        toggle_tray(app, (position.x, position.y, size.width, size.height));
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            thread::spawn(move || poll_loop(handle));
            let handle = app.handle().clone();
            thread::spawn(move || install_plugin(&handle));
            let handle = app.handle().clone();
            thread::spawn(move || install_cli(&handle));
            let handle = app.handle().clone();
            thread::spawn(move || finish_update(handle));
            let handle = app.handle().clone();
            thread::spawn(move || update_loop(handle));
            // The windows start hidden (tauri.conf.json), but their WebView2 starts visible
            for window in app.webview_windows().values() {
                hide(window);
            }
            if !started_hidden {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Closing the window keeps Quack running in the tray; quitting is in the tray menu
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                if let Some(main) = window.app_handle().get_webview_window("main") {
                    hide(&main);
                }
            }
            // A window that reached the screen without show() (alert_approval's minimized one,
            // brought up from the taskbar) gets its WebView2 back when it takes the focus. Only a
            // window on screen: the hidden main gets a focus event at startup, after setup.
            ("main", WindowEvent::Focused(true)) => {
                if let Some(main) = window.app_handle().get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) {
                    let webview: &tauri::Webview = main.as_ref();
                    let _ = webview.show();
                }
            }
            ("tray", WindowEvent::Focused(false)) => {
                if window.is_visible().unwrap_or(false) {
                    if let Some(tray) = window.app_handle().get_webview_window("tray") {
                        hide(&tray);
                    }
                    *window.app_handle().state::<Shared>().tray_hidden_at.lock().unwrap() = Some(Instant::now());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Quack app failed to start")
        .run(|app, event| match event {
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => stop_own_hub(app),
            _ => {}
        });
}
