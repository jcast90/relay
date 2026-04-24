#!/usr/bin/env node
// Automated GUI screenshots via Playwright against the vite dev server.
// Usage:
//   1. In one terminal: cd gui && pnpm dev        (starts vite on http://127.0.0.1:1420)
//   2. In another:      node demo/screenshot-gui.mjs
//
// Screenshots land in demo/screenshots/. Filenames match the shot list in
// demo/README.md so you can drop them straight into the top-level README.
//
// Note: this drives the *web* view, not the Tauri native window. It's the
// cheap reproducible path. For the hero GIF with native window chrome, use
// macOS screen capture (Cmd+Shift+5) — see demo/README.md.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "screenshots");
const BASE_URL = process.env.GUI_URL ?? "http://127.0.0.1:1420";

const shots = [
  {
    name: "01-main-window.png",
    description: "Main window: sidebar + center pane + right pane",
    setup: async (page) => {
      await page.goto(BASE_URL);
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "02-settings.png",
    description: "Settings page",
    setup: async (page) => {
      await page.goto(BASE_URL);
      await page.waitForLoadState("networkidle");
      const settingsTrigger = page
        .getByRole("button", { name: /settings/i })
        .first();
      if (await settingsTrigger.isVisible().catch(() => false)) {
        await settingsTrigger.click();
        await page.waitForTimeout(400);
      }
    },
  },
  {
    name: "03-new-channel.png",
    description: "New channel modal",
    setup: async (page) => {
      await page.goto(BASE_URL);
      await page.waitForLoadState("networkidle");
      const newChannel = page
        .getByRole("button", { name: /new channel/i })
        .first();
      if (await newChannel.isVisible().catch(() => false)) {
        await newChannel.click();
        await page.waitForTimeout(400);
      }
    },
  },
];

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

let ok = 0;
let skipped = 0;
for (const shot of shots) {
  try {
    await shot.setup(page);
    const path = join(OUT_DIR, shot.name);
    await page.screenshot({ path, fullPage: false });
    console.log(`  ✓ ${shot.name} — ${shot.description}`);
    ok++;
  } catch (err) {
    console.log(`  ⚠ ${shot.name} skipped: ${err.message}`);
    skipped++;
  }
}

await browser.close();

console.log(`\nDone: ${ok} captured, ${skipped} skipped. Output: ${OUT_DIR}`);
if (skipped > 0) {
  console.log(
    "Skipped shots usually mean the UI element wasn't found — check selectors in this script.",
  );
}
