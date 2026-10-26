// Quack app: the tray icon and window over the Quack hub.
//
// The hub (Node, src/hub) does the syncing; this process only starts it when nothing answers on
// its port, polls GET /api/state once a second, and relays the windows' calls to it. The
// windows never reach the hub themselves: the hub refuses anything carrying a web Origin, and
// the webview is one.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect, RunEvent, WebviewWindow, WindowEvent};
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

use flavor::{ICON_BAD, ICON_OK, ICON_PAUSED, ICON_WARN};

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
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
}

fn hub_call(port: u16, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    if !path.starts_with("/api/") {
        return Err("not a hub API path".into());
    }
    let url = format!("http://127.0.0.1:{port}{path}");
    let agent = ureq::AgentBuilder::new().timeout_connect(CONNECT_TIMEOUT).timeout(Duration::from_secs(5)).build();
    let result = match body {
        Some(body) => agent.request(method, &url).send_json(body.clone()),
        None => agent.request(method, &url).call(),
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
    let port = port_of(&app);
    tauri::async_runtime::spawn_blocking(move || hub_call(port, "POST", &path, Some(&body)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    app.state::<Shared>().settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, language: Option<String>, notify: Option<bool>) -> Result<Settings, String> {
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
    appdata().join(flavor::IDENTIFIER).join("restart-hub-after-update")
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
fn early_update_takeover(settings: &Settings) -> Option<Child> {
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
        Ok(state) if state["build"].as_str() != Some(build.as_str()) => start_hub_process(settings, &without_verbatim(entry), true).ok(),
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
fn copy_if_changed(from: &Path, to: &Path) -> std::io::Result<bool> {
    write_if_changed(&fs::read(from)?, to)
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
 */
fn install_plugin(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(from) = resource(app, &["plugin", flavor::PLUGIN]) else { return };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return };
    let to = PathBuf::from(local).join("Roblox").join("Plugins").join(flavor::PLUGIN);
    match copy_if_changed(&from, &to) {
        Ok(true) => {
            let pt = app.state::<Shared>().settings.lock().unwrap().language == "pt";
            let body = if pt {
                "Plugin atualizado. Reabra os places no Studio pra carregar."
            } else {
                "Plugin updated. Reopen your places in Studio to load it."
            };
            let _ = app.notification().builder().title(flavor::NAME).body(body).show();
        }
        Ok(false) => {}
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

/**
 * Claude Code, Cursor and Codex on this computer and whether each has this flavor's MCP
 * (`ai-clients`), or the MCP added to each one installed (`connect-ai`): the shipped command
 * does both, so the button and `quack connect-ai` never disagree.
 */
#[tauri::command]
async fn ai_clients(app: AppHandle, connect: bool) -> Result<Value, String> {
    let node = app.state::<Shared>().settings.lock().unwrap().node.clone();
    let cli = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("dist").join("control").join("main.js")
    } else {
        resource(&app, &["hub", "cli.mjs"]).ok_or("the app's files were not found")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let output = hidden_command(&node)
            .arg(&cli)
            .args(["--flavor", flavor::CLI_FLAVOR, if connect { "connect-ai" } else { "ai-clients" }, "--json"])
            .output()
            .map_err(|e| format!("could not run {node}: {e}"))?;
        // Exit 1 still carries the list, with the problem on the client it concerns
        serde_json::from_slice::<Value>(&output.stdout).map_err(|_| String::from_utf8_lossy(&output.stderr).trim().to_string())
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

/**
 * VS Code's executable: next to the `bin\code.cmd` on PATH (the installer puts it there), or in
 * the default per-user and machine install folders
 */
fn vscode_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join("code.cmd").is_file() {
                if let Some(install) = dir.parent() {
                    candidates.push(install.join("Code.exe"));
                }
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs").join("Microsoft VS Code").join("Code.exe"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Microsoft VS Code").join("Code.exe"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String, editor: bool) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_inside_registered(&app, &target) {
        return Err("only a registered game's folder can be opened".into());
    }
    let result = if editor {
        // Code.exe itself, never `code.cmd` through cmd.exe: cmd would read a `&` or `|` in a
        // folder name as a second command
        let Some(code) = vscode_exe() else { return Err("VS Code was not found".into()) };
        Command::new(code).arg(&path).spawn()
    } else {
        Command::new("explorer").arg(&path).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle, place_id: Option<String>, view: Option<String>, id: Option<String>) {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
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
    fn vscode_is_launched_as_an_executable_never_through_a_script() {
        // cmd.exe would read & or | in a folder name as a second command
        if let Some(code) = vscode_exe() {
            assert!(code.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")), "{code:?}");
        }
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
        let _ = window.hide();
        return;
    }
    // Clicking the icon while the panel is open first takes its focus, which hides it: that
    // click must not open it again
    if shared.tray_hidden_at.lock().unwrap().is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    *shared.tray_rect.lock().unwrap() = Some(rect);
    place_tray(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to("tray", "tray-shown", ());
}

fn spawn_hub(app: &AppHandle) {
    spawn_hub_with(app, false);
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
    match start_hub_process(&settings, &hub_entry(app, &settings), takeover) {
        Ok(child) => *hub = Some(child),
        Err(error) => eprintln!("Could not start the hub: {error}"),
    }
}

/** The hub process itself, logging to the flavor's hub log; needs no running app (see main) */
fn start_hub_process(settings: &Settings, entry: &Path, takeover: bool) -> Result<Child, String> {
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
        .args(["--port", &settings.hub_port.to_string(), "--registry", &settings.registry])
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    if takeover {
        command.arg("--takeover");
    }
    command.spawn().map_err(|e| e.to_string())
}

fn tray_icon_for(online: bool, state: &Value) -> (&'static str, &'static [u8]) {
    if !online {
        return ("bad", ICON_BAD);
    }
    if state["paused"].as_bool().unwrap_or(false) {
        return ("paused", ICON_PAUSED);
    }
    let conflicts: u64 = state["places"].as_array().into_iter().flatten().filter_map(|p| p["conflicts"].as_u64()).sum();
    let waiting = state["pending"].as_array().is_some_and(|p| !p.is_empty());
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

fn poll_loop(app: AppHandle) {
    let mut shown_icon = "";
    let mut shown_tooltip = String::new();
    let mut known_conflicts: Option<HashMap<String, u64>> = None;
    let mut known_choices: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let shared = app.state::<Shared>();
        let (port, language, notify) = {
            let s = shared.settings.lock().unwrap();
            (s.hub_port, s.language.clone(), s.notify)
        };
        let result = hub_call(port, "GET", "/api/state", None);
        let online = result.is_ok();
        let state = result.clone().unwrap_or(Value::Null);
        match &result {
            Ok(state) => {
                // It came up: once it is gone, the next one starts at once (RESPAWN_AFTER)
                *shared.last_spawn.lock().unwrap() = None;
                *shared.last_state.lock().unwrap() = state.clone();
                let _ = app.emit("hub-state", json!({ "online": true, "state": state }));
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
        }
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
    let early_hub = early_update_takeover(&settings);
    let shared = Shared {
        settings: Mutex::new(settings),
        settings_file,
        hub: Mutex::new(early_hub),
        last_spawn: Mutex::new(None),
        last_state: Mutex::new(Value::Null),
        tray_rect: Mutex::new(None),
        tray_hidden_at: Mutex::new(None),
        ready_update: Mutex::new(None),
    };
    tauri::Builder::default()
        .manage(shared)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            hub_get,
            hub_post,
            get_settings,
            set_settings,
            get_autostart,
            set_autostart,
            pick_folder,
            project_roots,
            make_folder,
            app_info,
            restart_hub,
            update_status,
            check_update,
            install_update,
            read_daemon_config,
            ai_clients,
            open_path,
            show_main,
            tray_fit,
            quit
        ])
        .setup(move |app| {
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
            if !started_hidden {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Closing the window keeps Quack running in the tray; quitting is in the tray menu
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            ("tray", WindowEvent::Focused(false)) => {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
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
