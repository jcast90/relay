import { ask, message } from "@tauri-apps/plugin-dialog";

// Tauri v2 webviews on macOS silently no-op `window.confirm` / `window.alert`
// (they only exist on the Web platform in Chromium). Anything that routes
// through the built-in DOM dialogs returns `false` / undefined without
// rendering, which looked to the user like buttons "not doing anything."
// Go through the dialog plugin so every confirm / notify actually surfaces.

export async function confirmAction(
  messageText: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error" }
): Promise<boolean> {
  return ask(messageText, {
    title: opts?.title ?? "Confirm",
    kind: opts?.kind ?? "warning",
  });
}

export async function notifyError(
  messageText: string,
  opts?: { title?: string }
): Promise<void> {
  await message(messageText, {
    title: opts?.title ?? "Error",
    kind: "error",
  });
}
