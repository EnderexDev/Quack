// Approvals of Open Cloud writes: the hub asks, this app answers.
//
// A write to Roblox (a DataStore save, a config publish, a badge...) waits in the hub until the
// user answers in this app's popup. The hub's HTTP API has no password, so an answer carries a
// token only this app knows: 32 random bytes made each time the app starts a hub, handed to it
// on its stdin (never its command line, environment or a plain file). The hub outlives the app
// (an update restarts the app, not the hub), so the app also keeps the token encrypted with the
// Windows user's DPAPI in its settings folder, and the next app instance reads it back.
//
// Limit: a program running as the same Windows user can decrypt that file and drive this app's
// window (UI Automation, SendKeys). DPAPI keeps the token from other users, not from this one;
// the user's AI hook blocks commands that name Quack's window or the token file.

use std::fs;
use std::path::{Path, PathBuf};

/** The file, in the flavor's settings folder (%APPDATA%\<identifier>) */
pub const TOKEN_FILE: &str = "approval-token.dpapi";
/** The header the hub reads the token from (src/cloud/approve.ts APPROVAL_TOKEN_HEADER) */
pub const TOKEN_HEADER: &str = "x-quack-approval-token";
/** The header on every call of this app, so the hub knows an app is there to ask */
pub const APP_HEADER: &str = "x-quack-app";

/** The chime played when a write starts waiting (app/scripts/chime.mjs makes it) */
pub static CHIME: &[u8] = include_bytes!("../sounds/approval.wav");

/** 32 random bytes from the OS, as 64 lowercase hex characters (what the hub accepts) */
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn is_token(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/** DPAPI's extra secret: a blob protected for one Quack flavor never opens for another */
fn entropy(identifier: &str) -> Vec<u8> {
    format!("Quack approval token|{identifier}").into_bytes()
}

pub fn token_path(settings_dir: &Path) -> PathBuf {
    settings_dir.join(TOKEN_FILE)
}

/** Saves the token encrypted for this Windows user and flavor */
pub fn save_token(settings_dir: &Path, identifier: &str, token: &str) -> Result<(), String> {
    let blob = dpapi::protect(token.as_bytes(), &entropy(identifier))?;
    fs::create_dir_all(settings_dir).map_err(|e| e.to_string())?;
    let file = token_path(settings_dir);
    let temp = file.with_extension("tmp");
    fs::write(&temp, blob).map_err(|e| e.to_string())?;
    fs::rename(&temp, &file).map_err(|e| e.to_string())
}

/** The token the last app saved; None when there is no file or it does not decrypt */
pub fn load_token(settings_dir: &Path, identifier: &str) -> Option<String> {
    let blob = fs::read(token_path(settings_dir)).ok()?;
    let plain = dpapi::unprotect(&blob, &entropy(identifier)).ok()?;
    let token = String::from_utf8(plain).ok()?;
    is_token(&token).then_some(token)
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    /** Never a prompt: the call fails instead */
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn run(input: &[u8], entropy: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = Blob { len: input.len() as u32, data: input.as_ptr() as *mut u8 };
        let entropy = Blob { len: entropy.len() as u32, data: entropy.as_ptr() as *mut u8 };
        let mut output = Blob { len: 0, data: std::ptr::null_mut() };
        let null = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call; the output is copied and freed with LocalFree
        let ok = unsafe {
            if protect {
                CryptProtectData(&input, std::ptr::null(), &entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            } else {
                CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, null, null, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            }
        };
        if ok == 0 || output.data.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: DPAPI wrote `len` bytes at `data`
        let bytes = unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec();
        unsafe { LocalFree(output.data as *mut c_void) };
        Ok(bytes)
    }

    pub fn protect(plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        run(plain, entropy, true)
    }

    pub fn unprotect(blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, String> {
        run(blob, entropy, false)
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI is Windows only".into())
    }
    pub fn unprotect(_: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI is Windows only".into())
    }
}

/**
 * Plays the chime from memory, without waiting. From Rust, not the webview: the window is
 * usually hidden when a write starts waiting.
 */
#[cfg(windows)]
pub fn play_chime() -> bool {
    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(sound: *const u16, module: *mut std::ffi::c_void, flags: u32) -> i32;
    }
    const SND_ASYNC: u32 = 0x0001;
    const SND_NODEFAULT: u32 = 0x0002;
    const SND_MEMORY: u32 = 0x0004;
    // SAFETY: CHIME is static, so it outlives the asynchronous play
    unsafe { PlaySoundW(CHIME.as_ptr() as *const u16, std::ptr::null_mut(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT) != 0 }
}

#[cfg(not(windows))]
pub fn play_chime() -> bool {
    false
}

/** The toast's text: "Quack is waiting for your answer", and the write's title under it */
pub fn toast_text(language: &str, title: &str) -> (String, String) {
    let head = if language == "pt" { "O Quack está esperando uma resposta" } else { "Quack is waiting for your answer" };
    (head.to_string(), title.chars().take(200).collect())
}

/**
 * Keeps a shown toast alive. Dropped once its question is answered (or gone): the toast's
 * thread ends then, instead of sleeping out the whole wait.
 */
pub struct ToastHold {
    _release: std::sync::mpsc::Sender<()>,
}

/** A hold, and what its thread waits on: up to `keep_for`, or until the hold is dropped */
fn toast_hold() -> (ToastHold, std::sync::mpsc::Receiver<()>) {
    let (release, released) = std::sync::mpsc::channel();
    (ToastHold { _release: release }, released)
}

/**
 * Shows the toast as this app (its AppUserModelID is the identifier the installer registers);
 * a click on it runs `on_click`. The toast is kept alive in its own thread while the returned
 * hold lives (at most `keep_for`), or its click would reach nothing.
 */
#[cfg(windows)]
pub fn show_toast(app_id: &str, head: String, body: String, keep_for: std::time::Duration, on_click: impl Fn() + Send + 'static) -> Result<ToastHold, String> {
    use tauri_winrt_notification::{Duration, Sound, Toast};
    let app_id = app_id.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    let (hold, released) = toast_hold();
    std::thread::spawn(move || {
        let toast = Toast::new(&app_id)
            .title(&head)
            .text1(&body)
            // The chime plays already: the toast stays silent
            .sound(None::<Sound>)
            .duration(Duration::Long)
            .on_activated(move |_| {
                on_click();
                Ok(())
            });
        let shown = toast.show().map_err(|e| e.to_string());
        let ok = shown.is_ok();
        let _ = sender.send(shown);
        if ok {
            // Answered (the hold dropped) or out of time, whichever comes first
            let _ = released.recv_timeout(keep_for);
        }
        drop(toast);
    });
    receiver.recv().map_err(|e| e.to_string())??;
    Ok(hold)
}

#[cfg(not(windows))]
pub fn show_toast(_: &str, _: String, _: String, _: std::time::Duration, _: impl Fn() + Send + 'static) -> Result<ToastHold, String> {
    Err("toasts are Windows only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_64_hex_characters_and_never_the_same_twice() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert!(is_token(&a) && is_token(&b));
        assert_eq!(a, a.to_lowercase());
        assert_ne!(a, b);
        assert!(!is_token("short"));
        assert!(!is_token(&"g".repeat(64)));
    }

    #[cfg(windows)]
    #[test]
    fn the_token_file_holds_no_token_in_the_clear_and_opens_only_for_its_own_flavor() {
        let dir = std::env::temp_dir().join(format!("quack-approval-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load_token(&dir, "dev.enderex.quack.dev"), None, "no file: no token");
        let token = new_token().unwrap();
        save_token(&dir, "dev.enderex.quack.dev", &token).unwrap();
        let blob = fs::read(dir.join(TOKEN_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&blob).contains(&token), "encrypted on disk");
        assert_eq!(load_token(&dir, "dev.enderex.quack.dev"), Some(token.clone()));
        assert_eq!(load_token(&dir, "dev.enderex.quack"), None, "Official cannot open Dev's");
        fs::write(dir.join(TOKEN_FILE), b"garbage").unwrap();
        assert_eq!(load_token(&dir, "dev.enderex.quack.dev"), None, "a broken file is no token");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_chime_is_a_short_pcm_wav() {
        assert_eq!(&CHIME[0..4], b"RIFF");
        assert_eq!(&CHIME[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([CHIME[20], CHIME[21]]), 1, "PCM");
        let rate = u32::from_le_bytes([CHIME[24], CHIME[25], CHIME[26], CHIME[27]]) as f64;
        let bytes_per_second = u32::from_le_bytes([CHIME[28], CHIME[29], CHIME[30], CHIME[31]]) as f64;
        let data = u32::from_le_bytes([CHIME[40], CHIME[41], CHIME[42], CHIME[43]]) as f64;
        assert!(rate >= 8000.0);
        let seconds = data / bytes_per_second;
        assert!((1.0..=2.0).contains(&seconds), "{seconds} s");
    }

    #[test]
    fn a_toast_thread_ends_when_its_hold_is_dropped_not_after_the_whole_wait() {
        let (hold, released) = toast_hold();
        let waiter = std::thread::spawn(move || {
            let started = std::time::Instant::now();
            let _ = released.recv_timeout(std::time::Duration::from_secs(300));
            started.elapsed()
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(hold);
        assert!(waiter.join().unwrap() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn the_toast_says_quack_waits_in_the_users_language() {
        assert_eq!(toast_text("pt", "Quack: set Coins").0, "O Quack está esperando uma resposta");
        assert_eq!(toast_text("en", "x").0, "Quack is waiting for your answer");
        assert_eq!(toast_text("pt", &"a".repeat(500)).1.len(), 200);
    }
}
