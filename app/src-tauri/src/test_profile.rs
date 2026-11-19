// QUACK_TEST_PROFILE: run this app isolated from the installed Quack and Quack Dev, for tests.
//
// With QUACK_TEST_PROFILE=<an existing absolute folder> (and QUACK_TEST_PORT, optional), the app
// keeps everything it would write under %APPDATA% in <folder>\appdata (settings, approval token,
// hub log, the hub's registry and config.json: its child processes get that folder as APPDATA),
// its WebView2 data in <folder>\webview, starts its own hub on the test port, takes a
// single-instance key of its own (so a start never reaches the installed app), and never touches
// the machine: no plugin copy into Studio, no PATH entry, no command file, no autostart entry, no
// update check, no tray icon. Its windows open shown but never activated, off screen.
//
// Unset, nothing changes. Set but unusable (a relative or missing folder, one inside Quack's own
// folders, a port of a real hub), the app refuses to start rather than fall back to the real
// profile.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const PROFILE_VAR: &str = "QUACK_TEST_PROFILE";
pub const PORT_VAR: &str = "QUACK_TEST_PORT";
/** The test hub's port when QUACK_TEST_PORT is unset: neither Official's 3825 nor Dev's 3826 */
pub const DEFAULT_PORT: u16 = 3839;
/** Ports a test hub never takes: the installed Official and Dev hubs */
const REAL_PORTS: [u16; 2] = [3825, 3826];
/** Where the windows sit: off every monitor, so a test never covers what someone else is looking at */
pub const OFF_SCREEN: (f64, f64) = (-20000.0, -20000.0);

#[derive(Debug, Clone, PartialEq)]
pub struct TestProfile {
    pub root: PathBuf,
    /** The app identifier for this profile: the single-instance key, never the installed app's */
    pub identifier: String,
    pub port: u16,
}

impl TestProfile {
    /** What the app and its child processes use as %APPDATA% */
    pub fn appdata(&self) -> PathBuf {
        self.root.join("appdata")
    }

    /** The WebView2 user data folder of both windows */
    pub fn webview_dir(&self) -> PathBuf {
        self.root.join("webview")
    }
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.trim_end_matches('\\').to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/**
 * The path with every junction and link resolved: its deepest folder that exists, canonicalized
 * (without the `\\?\` prefix), then the part that does not exist yet. A profile reached through a
 * junction into a real folder is then seen inside it.
 */
fn canonical(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut existing = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            let text = real.to_string_lossy();
            let mut out = match text.strip_prefix(r"\\?\UNC\") {
                Some(unc) => PathBuf::from(format!(r"\\{unc}")),
                None => PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)),
            };
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/**
 * The first link or junction under `dir` (never followed), or a folder too deep or unreadable
 * to vouch for. A fresh profile is empty, so this costs nothing in the normal case.
 */
fn first_link_inside(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 32 {
        return Some(dir.to_path_buf());
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Some(dir.to_path_buf()) };
    for entry in entries {
        let Ok(entry) = entry else { return Some(dir.to_path_buf()) };
        let path = entry.path();
        // Not followed: on Windows a junction is a link here too
        let Ok(meta) = std::fs::symlink_metadata(&path) else { return Some(path) };
        if meta.file_type().is_symlink() {
            return Some(path);
        }
        if meta.is_dir() {
            if let Some(found) = first_link_inside(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/** `a` is `b` or inside it */
fn within(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}\\"))
}

/** FNV-1a of the folder, so two profiles at once get two single-instance keys */
fn short_hash(text: &str) -> u32 {
    text.bytes().fold(0x811c_9dc5u32, |hash, byte| (hash ^ byte as u32).wrapping_mul(0x0100_0193))
}

/**
 * The profile from the two variables' values. `base_identifier` is the flavor's identifier,
 * `forbidden` the real folders the profile must neither be inside nor contain. Ok(None): the
 * variable is unset (or empty) and the app runs as always.
 */
pub fn resolve(profile: Option<OsString>, port: Option<OsString>, base_identifier: &str, forbidden: &[PathBuf]) -> Result<Option<TestProfile>, String> {
    let profile = profile.filter(|p| !p.is_empty());
    let Some(profile) = profile else {
        return match port.filter(|p| !p.is_empty()) {
            Some(_) => Err(format!("{PORT_VAR} is set without {PROFILE_VAR}")),
            None => Ok(None),
        };
    };
    let root = PathBuf::from(&profile);
    if !root.is_absolute() {
        return Err(format!("{PROFILE_VAR} must be an absolute folder, not {}", root.display()));
    }
    if root.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{PROFILE_VAR} must not contain '..'"));
    }
    if !root.is_dir() {
        return Err(format!("{PROFILE_VAR} must be a folder that exists: {}", root.display()));
    }
    // Compared and keyed as resolved paths: a junction or a link never hides a real folder
    let root = canonical(&root);
    let key = normalized(&root);
    for real in forbidden {
        let real = normalized(&canonical(real));
        if within(&key, &real) || within(&real, &key) {
            return Err(format!("{PROFILE_VAR} must be apart from Quack's own folders ({real})"));
        }
    }
    // A link or junction already inside the profile (appdata pointing at the real %APPDATA%\quack)
    // would send the app's writes out of it
    if let Some(link) = first_link_inside(&root, 0) {
        return Err(format!("{PROFILE_VAR} must hold no link or junction ({})", link.display()));
    }
    let port = match port.filter(|p| !p.is_empty()) {
        None => DEFAULT_PORT,
        Some(text) => text
            .to_str()
            .and_then(|t| t.trim().parse::<u16>().ok())
            .ok_or_else(|| format!("{PORT_VAR} must be a port number"))?,
    };
    if port < 1024 || REAL_PORTS.contains(&port) {
        return Err(format!("{PORT_VAR} {port} is not a test port (1024 or above, never 3825 or 3826)"));
    }
    Ok(Some(TestProfile { identifier: format!("{base_identifier}.test-{:08x}", short_hash(&key)), root, port }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_profile(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quack-test-profile-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unset_means_the_app_as_always() {
        assert_eq!(resolve(None, None, "dev.enderex.quack.dev", &[]), Ok(None));
        assert_eq!(resolve(Some("".into()), Some("".into()), "dev.enderex.quack.dev", &[]), Ok(None));
        assert!(resolve(None, Some("3900".into()), "dev.enderex.quack.dev", &[]).is_err(), "a port alone is a mistake, not ignored");
    }

    #[test]
    fn a_profile_gets_its_own_identifier_port_and_folders() {
        let dir = temp_profile("own");
        let profile = resolve(Some(dir.clone().into()), None, "dev.enderex.quack.dev", &[]).unwrap().unwrap();
        assert_eq!(profile.port, DEFAULT_PORT);
        assert!(profile.identifier.starts_with("dev.enderex.quack.dev.test-"), "{}", profile.identifier);
        assert_ne!(profile.identifier, "dev.enderex.quack.dev", "the installed app's single-instance key");
        assert_eq!(profile.appdata(), canonical(&dir).join("appdata"));
        assert_eq!(profile.webview_dir(), canonical(&dir).join("webview"));
        let custom = resolve(Some(dir.clone().into()), Some("3901".into()), "dev.enderex.quack.dev", &[]).unwrap().unwrap();
        assert_eq!(custom.port, 3901);
        // Another folder, another key: two test runs at once never hand off to each other
        let other = temp_profile("other");
        let second = resolve(Some(other.clone().into()), None, "dev.enderex.quack.dev", &[]).unwrap().unwrap();
        assert_ne!(profile.identifier, second.identifier);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn a_profile_that_could_reach_the_real_one_refuses_to_start() {
        let dir = temp_profile("refuse");
        let id = "dev.enderex.quack.dev";
        for port in ["3825", "3826", "80", "0", "x", "70000"] {
            assert!(resolve(Some(dir.clone().into()), Some(port.into()), id, &[]).is_err(), "port {port}");
        }
        assert!(resolve(Some("relative\\folder".into()), None, id, &[]).is_err());
        assert!(resolve(Some(dir.join("missing").into()), None, id, &[]).is_err(), "a typo never creates a folder");
        assert!(resolve(Some(dir.join("..").join("x").into()), None, id, &[]).is_err());
        // Inside a real folder, or holding one
        let real = dir.join("Roaming").join("quack");
        std::fs::create_dir_all(real.join("inside")).unwrap();
        assert!(resolve(Some(real.join("inside").into()), None, id, &[real.clone()]).is_err());
        assert!(resolve(Some(dir.join("Roaming").into()), None, id, &[real.clone()]).is_err());
        let upper = PathBuf::from(dir.to_string_lossy().to_uppercase());
        if cfg!(windows) {
            assert!(resolve(Some(upper.join("ROAMING").join("QUACK").join("INSIDE").into()), None, id, &[real.clone()]).is_err(), "any case");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_into_a_real_folder_is_seen_inside_it() {
        let dir = temp_profile("junction");
        let real = dir.join("Roaming").join("quack");
        std::fs::create_dir_all(real.join("inside")).unwrap();
        // mklink /J needs no administrator, unlike a symbolic link
        let link = dir.join("link");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&real).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        // Removed even when an assert fails: the junction first (remove_dir does not follow it)
        struct Cleanup(PathBuf, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir(&self.1);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone(), link.clone());
        let id = "dev.enderex.quack.dev";
        assert!(resolve(Some(link.join("inside").into()), None, id, &[real.clone()]).is_err(), "through the junction");
        assert!(resolve(Some(link.clone().into()), None, id, &[real.clone()]).is_err(), "the junction itself");
        // A forbidden folder named through the junction is resolved too
        let apart = dir.join("apart");
        std::fs::create_dir_all(&apart).unwrap();
        assert!(resolve(Some(real.join("inside").into()), None, id, &[link.clone()]).is_err());
        let ok = resolve(Some(apart.clone().into()), None, id, &[link.clone()]).unwrap().unwrap();
        assert_eq!(normalized(&ok.root), normalized(&canonical(&apart)), "the profile is used as resolved");
        // A junction already inside the profile, say appdata into the real folder, is refused
        let profile = dir.join("profile");
        std::fs::create_dir_all(profile.join("nested")).unwrap();
        let inner = profile.join("nested").join("appdata");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&inner).arg(&real).output().unwrap();
        assert!(made.status.success());
        struct Unlink(PathBuf);
        impl Drop for Unlink {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _unlink = Unlink(inner.clone());
        let refused = resolve(Some(profile.clone().into()), None, id, &[]).unwrap_err();
        assert!(refused.contains("no link or junction"), "{refused}");
        std::fs::remove_dir(&inner).unwrap();
        assert!(resolve(Some(profile.clone().into()), None, id, &[]).unwrap().is_some(), "without it the profile is fine");
    }
}
