# Fonts

Tidewater uses Inter (UI) and JetBrains Mono (code). The CSS in
`src/styles/tokens.css` currently falls back to OS-installed copies via
`src: local(...)`. To ship fully offline, drop the variable .woff2 files
here and extend the `@font-face` src lists to reference them first:

- `Inter.woff2` — https://rsms.me/inter/inter.html (variable)
- `JetBrainsMono.woff2` — https://www.jetbrains.com/lp/mono/ (variable)
