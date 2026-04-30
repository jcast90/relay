use std::fs;

use serde::Deserialize;

use harness_data as data;

#[derive(Deserialize)]
struct SurfaceRecord {
    #[allow(dead_code)]
    version: String,
    #[serde(rename = "sourceSha")]
    source_sha: Option<String>,
}

#[derive(Deserialize, Default)]
struct InstallManifest {
    #[serde(default, rename = "schemaVersion")]
    #[allow(dead_code)]
    schema_version: u32,
    #[serde(default)]
    surfaces: Surfaces,
}

#[derive(Deserialize, Default)]
struct Surfaces {
    cli: Option<SurfaceRecord>,
    tui: Option<SurfaceRecord>,
    gui: Option<SurfaceRecord>,
}

/// Compare the running TUI's compiled-in SHA against what the install
/// manifest last recorded. Three buckets:
///
/// - `Some(text)` — drift detected; render the text as a footer line.
/// - `None` — installed manifest matches running, or we couldn't tell
///   (manifest missing, build had no embedded SHA). Don't render the
///   footer in that case; we'd rather under-nudge than render
///   misleading "everything's fine" text.
///
/// The function is intentionally synchronous and best-effort. It runs
/// once at TUI startup; the cost is one ~1KB JSON read and a couple of
/// string comparisons.
pub fn detect_drift_footer() -> Option<String> {
    let path = data::harness_root().join("installed.json");
    let raw = fs::read_to_string(&path).ok()?;
    let manifest: InstallManifest = serde_json::from_str(&raw).ok()?;

    let running_sha = option_env!("RELAY_GIT_SHA").filter(|s| !s.is_empty());

    let mut hints: Vec<String> = Vec::new();

    // Primary signal: running TUI doesn't match the most recent
    // `rly install tui`. Either the user installed a newer build and
    // hasn't relaunched, or this binary is older than the manifest.
    if let (Some(running), Some(record)) = (running_sha, manifest.surfaces.tui.as_ref()) {
        if let Some(installed) = record.source_sha.as_deref() {
            if running != installed {
                hints.push(format!(
                    "tui v{} ({}) running, manifest v{} ({}) — quit + relaunch to apply update",
                    env!("CARGO_PKG_VERSION"),
                    short(running),
                    record.version,
                    short(installed),
                ));
            }
        }
    }

    // Secondary signal: other surfaces the user might be tracking. We
    // collect their behind-vs-fresh status into the same line so the
    // footer stays one row tall regardless of how many surfaces drift.
    let mut behind_other: Vec<&'static str> = Vec::new();
    let mut fresh_other: Vec<&'static str> = Vec::new();
    let cli_state = surface_state(&manifest.surfaces.cli, running_sha);
    let gui_state = surface_state(&manifest.surfaces.gui, running_sha);
    if matches!(cli_state, Some(SurfaceState::Behind)) {
        behind_other.push("cli");
    } else if matches!(cli_state, Some(SurfaceState::Fresh)) {
        fresh_other.push("cli");
    }
    if matches!(gui_state, Some(SurfaceState::Behind)) {
        behind_other.push("gui");
    } else if matches!(gui_state, Some(SurfaceState::Fresh)) {
        fresh_other.push("gui");
    }
    if !behind_other.is_empty() {
        hints.push(format!(
            "{} behind source — `rly install {}`",
            behind_other.join(" + "),
            behind_other.join(" ")
        ));
    }
    if !fresh_other.is_empty() {
        hints.push(format!(
            "{} not yet installed — `rly install {}`",
            fresh_other.join(" + "),
            fresh_other.join(" ")
        ));
    }

    if hints.is_empty() {
        None
    } else {
        Some(format!("↻ {}", hints.join(" · ")))
    }
}

enum SurfaceState {
    Fresh,
    Behind,
}

/// Compare a non-TUI surface's manifest record to the running TUI's
/// compiled-in SHA. Cross-surface comparison isn't strictly correct
/// (the GUI could have been built from a different SHA than the TUI),
/// but in the common dev flow `rly install` stamps all three at the
/// same SHA — so this catches the "you forgot to install gui" case
/// well enough for a one-line footer hint. Returns `None` when we
/// can't compare (no SHA on either side).
fn surface_state(record: &Option<SurfaceRecord>, running_sha: Option<&str>) -> Option<SurfaceState> {
    match record {
        None => Some(SurfaceState::Fresh),
        Some(r) => match (r.source_sha.as_deref(), running_sha) {
            (Some(installed), Some(running)) if installed != running => Some(SurfaceState::Behind),
            _ => None,
        },
    }
}

fn short(sha: &str) -> &str {
    if sha.len() >= 7 {
        &sha[..7]
    } else {
        sha
    }
}
