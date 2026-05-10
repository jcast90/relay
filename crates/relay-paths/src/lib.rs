//! Shared path / binary resolution helpers used by both the TUI
//! (`tui/src/main.rs`) and the Tauri-side GUI (`gui/src-tauri/src/lib.rs`).
//!
//! Phase 1 PR-3 hoisted these out of `gui-src-tauri` into this crate
//! (Task 10b, H1 dispatch parity) so the TUI's chat worker can shell
//! out to `rly chat record-usage` with the same launchd-PATH-strip
//! workaround the GUI uses. Single-source: a future tweak to the PATH
//! ladder propagates to both surfaces in one edit.
//!
//! Two helpers are exposed:
//!
//! - [`augmented_child_path`] — build a `PATH` for child processes that
//!   tolerates macOS Finder launches (which inherit launchd's stripped
//!   `/usr/bin:/bin:/usr/sbin:/sbin`). Mirrors the iTerm / VS Code
//!   "source the login shell once" trick, with belt-and-suspenders
//!   probing of common install dirs.
//! - [`cli_bin`] — resolve the `rly` CLI binary. Honors
//!   `$RELAY_BIN`; otherwise returns `"rly"` and lets the augmented
//!   PATH find it.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Resolve the Relay CLI binary path.
///
/// Honors `$RELAY_BIN`; otherwise returns the bare name `"rly"` and
/// relies on the caller to set `PATH` (typically via [`augmented_child_path`])
/// so the OS can find it.
///
/// Kept tiny on purpose — both consumers (TUI, GUI) historically had
/// near-identical one-liners. Single-source so a future fix (Windows
/// support, alternate env var) lands in one place.
pub fn cli_bin() -> String {
    std::env::var("RELAY_BIN").unwrap_or_else(|_| "rly".to_string())
}

/// Build a `PATH` for child processes that augments the inherited PATH
/// with well-known node / user-bin install dirs.
///
/// Why this exists: macOS Finder-launched apps inherit launchd's
/// stripped `/usr/bin:/bin:/usr/sbin:/sbin`. The user's `.zprofile` /
/// `.profile` / brew/pnpm/nvm init never runs, so even
/// `Command::new("rly")` fails with "command not found" despite the
/// binary being installed. The TUI hits this less often (it's normally
/// terminal-launched), but it can still be invoked by Finder on
/// macOS — and the GUI path is the dominant case.
///
/// Strategy:
/// 1. Try to capture the user's login-shell PATH via `$SHELL -l -c
///    'printenv PATH'`. Bounded by a 2-second wall clock so a broken
///    rc file can't hang startup.
/// 2. Fall back to the parent process's `PATH` env var.
/// 3. Append well-known install dirs (nvm versions, /opt/homebrew/bin,
///    /usr/local/bin, pnpm/asdf/cargo/etc.) that survive even when the
///    shell-PATH probe returns nothing useful.
///
/// Extras are appended in priority order. The captured/inherited PATH
/// stays first so terminal-launched sessions keep using the user's
/// own ordering.
pub fn augmented_child_path() -> String {
    let home = std::env::var_os("HOME").unwrap_or_default();
    let parent: std::ffi::OsString = match resolve_shell_path() {
        Some(s) => s.into(),
        None => std::env::var_os("PATH").unwrap_or_default(),
    };
    compute_augmented_path(&parent, &home)
}

/// Capture the PATH the user's login shell would set.
///
/// On macOS, GUI apps launched from Finder inherit launchd's stripped
/// PATH. iTerm / Warp / VS Code all work around this by running the
/// user's `$SHELL` once to source their dotfiles and harvest the
/// resulting PATH; we do the same.
///
/// `-l -c` (login, non-interactive). `-i` would also source `.zshrc`
/// and friends, but interactive rc files commonly print prompts, read
/// from stdin, or take seconds — unacceptable on the GUI startup
/// path. Any PATH set only in `.zshrc` (not `.zprofile`) still gets
/// caught by the per-tool candidate probes in [`compute_augmented_path`].
///
/// Bounded by a 2-second wall clock. If the shell hangs (broken rc,
/// unusual login dance) the spawned thread leaks harmlessly and we
/// fall back to the process PATH so the app still boots.
fn resolve_shell_path() -> Option<String> {
    static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
            use std::sync::mpsc;
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let out = Command::new(&shell)
                    .args(["-l", "-c", "printenv PATH"])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output();
                let _ = tx.send(out);
            });
            let out = match rx.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    eprintln!("[path] $SHELL -l -c 'printenv PATH' failed: {e}");
                    return None;
                }
                Err(_) => {
                    eprintln!(
                        "[path] $SHELL -l -c 'printenv PATH' timed out after 2s; \
                         falling back to inherited PATH"
                    );
                    return None;
                }
            };
            if !out.status.success() {
                return None;
            }
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .clone()
}

/// Pure helper — `augmented_child_path` reads from process env; this
/// takes the parent PATH and HOME as inputs so tests can exercise it
/// without mutating process-wide state.
pub fn compute_augmented_path(
    parent_path: &std::ffi::OsStr,
    home: &std::ffi::OsStr,
) -> String {
    let home_path = PathBuf::from(home);
    let mut parts: Vec<PathBuf> = std::env::split_paths(parent_path).collect();
    let mut seen: HashSet<PathBuf> = parts.iter().cloned().collect();

    let mut extras: Vec<PathBuf> = Vec::new();

    // nvm first (highest priority). Newest version wins so a modern
    // node beats a stale `/usr/local/bin/node`.
    let nvm_root = home_path.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut versions: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        versions.sort_by(|a, b| b.cmp(a)); // newest first
        for v in versions {
            extras.push(v.join("bin"));
        }
    }

    // Homebrew prefixes + misc user-local install dirs.
    extras.push(PathBuf::from("/opt/homebrew/bin"));
    extras.push(PathBuf::from("/usr/local/bin"));
    for rel in [
        "Library/pnpm",
        ".local/share/pnpm",
        ".npm-global/bin",
        ".volta/bin",
        ".asdf/shims",
        ".cargo/bin",
        ".local/bin",
    ] {
        extras.push(home_path.join(rel));
    }

    for dir in extras {
        if dir.is_dir() && seen.insert(dir.clone()) {
            parts.push(dir);
        }
    }

    std::env::join_paths(parts)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn cli_bin_default_and_env_override() {
        // Tests `cli_bin()` in both modes back-to-back inside one
        // serial test so two threads can't race on `$RELAY_BIN` (cargo
        // runs tests in parallel by default; splitting these into two
        // tests would invite a Heisen-failure when scheduled
        // concurrently).
        let prev = std::env::var_os("RELAY_BIN");

        std::env::remove_var("RELAY_BIN");
        assert_eq!(cli_bin(), "rly");

        std::env::set_var("RELAY_BIN", "/tmp/fake-rly");
        assert_eq!(cli_bin(), "/tmp/fake-rly");

        match prev {
            Some(p) => std::env::set_var("RELAY_BIN", p),
            None => std::env::remove_var("RELAY_BIN"),
        }
    }

    #[test]
    fn compute_augmented_path_preserves_parent_entries_first() {
        // Terminal-launched sessions already have nvm at the top of PATH;
        // the helper must not reorder the parent's entries, only append
        // fallbacks.
        let parent = OsString::from("/parent/a:/parent/b");
        let home = OsString::from("/tmp/no-such-home");
        let out = compute_augmented_path(&parent, &home);
        let parts: Vec<&str> = out.split(':').collect();
        assert_eq!(parts[0], "/parent/a");
        assert_eq!(parts[1], "/parent/b");
    }

    #[test]
    fn compute_augmented_path_deduplicates() {
        let parent = OsString::from("/opt/homebrew/bin:/usr/local/bin");
        let home = OsString::from("/tmp/no-such-home");
        let out = compute_augmented_path(&parent, &home);
        // Even with /opt/homebrew/bin already in parent, augmented
        // output should not duplicate it.
        let count = out.split(':').filter(|p| *p == "/opt/homebrew/bin").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn compute_augmented_path_prepends_nvm_ahead_of_local_prefixes() {
        // Fake HOME containing two nvm node versions; the newest must
        // appear ahead of /usr/local/bin in the resulting PATH so the
        // shim's `exec node` doesn't pick up a stale system node.
        // Hoisted from `gui/src-tauri/src/lib.rs` in Phase 1 PR-3
        // (Task 10b) so the canonical PATH-ladder is tested where it
        // lives.
        let home_dir = std::env::temp_dir().join(format!(
            "relay-paths-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home_dir).expect("mkdir tempdir");
        let home = home_dir.as_os_str().to_owned();
        for v in ["v18.0.0", "v22.14.0"] {
            let bin = home_dir.join(".nvm/versions/node").join(v).join("bin");
            std::fs::create_dir_all(&bin).expect("mkdir nvm");
        }
        let parent = OsString::from("/usr/bin:/bin");
        let result = compute_augmented_path(&parent, &home);

        let segments: Vec<&str> = result.split(':').collect();
        let home_str = home.to_str().unwrap();
        let newest_nvm = format!("{home_str}/.nvm/versions/node/v22.14.0/bin");
        let older_nvm = format!("{home_str}/.nvm/versions/node/v18.0.0/bin");
        let idx_newest = segments.iter().position(|s| *s == newest_nvm);
        let idx_older = segments.iter().position(|s| *s == older_nvm);
        assert!(idx_newest.is_some(), "expected newest nvm in PATH: {result}");
        assert!(idx_older.is_some(), "expected older nvm in PATH: {result}");
        assert!(
            idx_newest.unwrap() < idx_older.unwrap(),
            "newest nvm must precede older: {result}"
        );
        if let Some(idx_usr_local) = segments.iter().position(|s| *s == "/usr/local/bin") {
            assert!(
                idx_newest.unwrap() < idx_usr_local,
                "nvm must precede /usr/local/bin so a stale system node is shadowed: {result}"
            );
        }

        let _ = std::fs::remove_dir_all(&home_dir);
    }
}
