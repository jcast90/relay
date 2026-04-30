use std::fs;

use serde::Deserialize;

use harness_data as data;

#[derive(Deserialize)]
struct SurfaceRecord {
    version: String,
    #[serde(rename = "sourceSha")]
    source_sha: Option<String>,
}

#[derive(Deserialize, Default)]
struct InstallManifest {
    #[serde(default, rename = "schemaVersion")]
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
/// manifest last recorded. Returns `Some(text)` when drift is detected
/// and a footer line should render; `None` to suppress.
///
/// We deliberately match PR #208's "fresh = don't nudge" semantic: a
/// missing surface record means the user is most likely running source
/// directly (e.g. `cargo run -p relay-tui`) rather than from an installed
/// binary, and a permanent amber "install gui" footer in dev mode would
/// just train them to ignore the footer. We only nudge for `behind`.
///
/// The function is intentionally synchronous and best-effort. It runs at
/// TUI startup and on each periodic refresh; the cost is one ~1KB JSON
/// read and a handful of string comparisons.
pub fn detect_drift_footer() -> Option<String> {
    let path = data::harness_root().join("installed.json");
    let raw = fs::read_to_string(&path).ok()?;
    let manifest: InstallManifest = serde_json::from_str(&raw).ok()?;

    // Future-format guard. We could try harder to read forward-compatible
    // fields, but a TUI footer rendering text from an unknown schema is
    // worse than no footer — fail closed.
    if manifest.schema_version != 1 {
        return None;
    }

    let running_sha = option_env!("RELAY_GIT_SHA").filter(|s| !s.is_empty());

    let mut hints: Vec<String> = Vec::new();

    // Primary signal: running TUI doesn't match the most recent
    // `rly install tui`. Either the user installed a newer build and
    // hasn't relaunched, or this binary is older than the manifest.
    let tui_record = manifest.surfaces.tui.as_ref();
    if let (Some(running), Some(record)) = (running_sha, tui_record) {
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

    // Secondary signal: peer surfaces (cli/gui) installed at a different
    // SHA than the TUI was. We compare against `manifest.tui.sourceSha`
    // rather than the running TUI's compiled-in SHA so a TUI built from
    // SHA-X but installed at SHA-Y doesn't falsely flag every other
    // surface as drift. If `manifest.tui` is missing we can't establish
    // a reference point and skip peer comparison entirely (the user is
    // either running source dev or has never installed — in both cases
    // we'd rather stay silent).
    let reference = tui_record.and_then(|r| r.source_sha.as_deref());
    let mut behind_other: Vec<&'static str> = Vec::new();
    if let Some(reference) = reference {
        if peer_behind(&manifest.surfaces.cli, reference) {
            behind_other.push("cli");
        }
        if peer_behind(&manifest.surfaces.gui, reference) {
            behind_other.push("gui");
        }
    }
    if !behind_other.is_empty() {
        hints.push(format!(
            "{} installed at a different sha — `rly install {}`",
            behind_other.join(" + "),
            behind_other.join(" ")
        ));
    }

    if hints.is_empty() {
        None
    } else {
        Some(format!("↻ {}", hints.join(" · ")))
    }
}

/// True when a peer surface's manifest record exists and was stamped at
/// a different SHA than `reference`. A missing record returns false —
/// that's the "fresh" case PR #208 explicitly chose not to nudge on.
fn peer_behind(record: &Option<SurfaceRecord>, reference: &str) -> bool {
    match record {
        None => false,
        Some(r) => matches!(r.source_sha.as_deref(), Some(installed) if installed != reference),
    }
}

fn short(sha: &str) -> &str {
    if sha.len() >= 7 {
        &sha[..7]
    } else {
        sha
    }
}
