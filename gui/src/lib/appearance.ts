import { useEffect, useState } from "react";

const KEY = "relay.appearance";

export type AvatarStyle = "glyph" | "initial";
export type Density = "compact" | "medium" | "spacious";

export type Appearance = {
  avatarStyle: AvatarStyle;
  density: Density;
};

const DEFAULT: Appearance = {
  avatarStyle: "glyph",
  density: "medium",
};

function read(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      avatarStyle: parsed.avatarStyle === "initial" ? "initial" : "glyph",
      density:
        parsed.density === "compact" || parsed.density === "spacious"
          ? parsed.density
          : "medium",
    };
  } catch {
    return DEFAULT;
  }
}

function write(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
    // Broadcast to other hook subscribers in the same tab. `storage` only
    // fires cross-tab, so we dispatch a custom event for same-tab listeners.
    window.dispatchEvent(new CustomEvent("relay:appearance", { detail: a }));
  } catch {
    /* storage blocked — best-effort */
  }
}

/**
 * React hook returning the current Appearance and a setter. Persists to
 * localStorage and broadcasts changes so every subscriber stays in sync.
 */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [state, setState] = useState<Appearance>(() => read());

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<Appearance>).detail;
      if (detail) setState(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setState(read());
    };
    window.addEventListener("relay:appearance", onEvent);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("relay:appearance", onEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = (next: Appearance) => {
    setState(next);
    write(next);
  };
  return [state, update];
}
