---
"relay": minor
---

OSS-20: release pipeline. Adds Changesets-driven versioning with a Cargo.toml
sync script, `.github/workflows/release.yml` that publishes to npm + cuts
per-OS GUI artifacts (`.dmg`, `.AppImage`, `.deb`, `.msi`) + creates a GitHub
Release on `v*` tags. `install.sh` gains a Tauri-dep preflight on Linux with
an interactive `apt-get install` offer. README has a proper Install section
with the `npm install -g rly` / `npx rly@latest welcome` one-liner.
