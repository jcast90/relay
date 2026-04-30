use std::process::Command;

fn main() {
    // Embed the repo HEAD SHA at build time so the running TUI can
    // detect when its compiled-in version differs from what the install
    // manifest at `~/.relay/installed.json` last recorded — i.e. someone
    // ran `rly install tui` but the user hasn't relaunched yet. The CLI's
    // `rly install --check` only sees manifest-vs-source drift and
    // wouldn't catch this gap on its own.
    let sha = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=RELAY_GIT_SHA={}", sha);
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
}
