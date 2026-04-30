use std::process::Command;

fn main() {
    tauri_build::build();

    // Embed the repo HEAD SHA at build time so the running GUI can detect
    // when its compiled-in version differs from what `rly install gui` last
    // wrote to the install manifest. Without this, a freshly built GUI has
    // no way to tell it's out-of-date relative to a newer source on disk
    // until the user relaunches it.
    let sha = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=RELAY_GIT_SHA={}", sha);

    // Re-run when HEAD moves so a `git checkout` between builds doesn't
    // leave a stale SHA compiled in. Rebuilding on every branch switch is
    // the cost; the alternative is a stamp that lies.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");
}
