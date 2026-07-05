// Browser stand-in for "@opentui/react" (aliased by the /app.js build plugin):
// useKeyboard broadcasts DOM keydowns in opentui's KeyEvent shape, useTerminalDimensions
// reads the metrics cell grid, useRenderer stubs the one call site (setCursorPosition).
import { useEffect, useState } from "react";
import { getMetrics, onMetrics } from "./metrics";

export type KeyLike = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  raw: string;
};

const NAME: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Enter: "return",
  Escape: "escape",
  Backspace: "backspace",
  Tab: "tab",
  " ": "space",
};

const handlers = new Set<(key: KeyLike) => void>();
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", (e) => {
    // no terminal to quit / no ctrl sequences on the web — let browser shortcuts through
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const name = NAME[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
    const key: KeyLike = {
      name,
      ctrl: false,
      meta: false,
      shift: e.shiftKey,
      option: false,
      sequence: e.key.length === 1 ? e.key : "",
      raw: e.key,
    };
    // NOTE: events from the chat <input> are deliberately not filtered out — the TUI's
    // first-letter-nav timer relies on the global handler seeing letters while the input
    // focuses (keydown fires before React's onChange updates inputRef, matching opentui).
    handlers.forEach((h) => h(key));
  });
}

export function useKeyboard(fn: (key: KeyLike) => void): void {
  useEffect(() => {
    ensureListener();
    handlers.add(fn);
    return () => {
      handlers.delete(fn);
    };
  }, [fn]);
}

export function useTerminalDimensions(): { width: number; height: number } {
  const [d, setD] = useState(() => {
    const m = getMetrics();
    return { width: m.cols, height: m.rows };
  });
  useEffect(
    () =>
      onMetrics(() => {
        const m = getMetrics();
        setD({ width: m.cols, height: m.rows });
      }),
    [],
  );
  return d;
}

const RENDERER = { setCursorPosition: (_x: number, _y: number, _visible?: boolean) => {} };
export function useRenderer(): typeof RENDERER {
  return RENDERER;
}
