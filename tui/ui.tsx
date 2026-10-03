// Shared TUI primitives: the editorial palette, small formatters, and the Stat card.
// Split from app.tsx so the music module and the app share one source of visual truth.
import type { ReactNode } from "react";

// Editorial palette: green ACCENT reserved for links/active/live; neutral INK/MUTED/FAINT for hierarchy.
export const ACCENT = "#43f08a";
export const INK = "#e9ece9";
export const MUTED = "#7c8a82";
// FAINT is the quietest copy. The water texture runs behind every screen, so it sits above
// the texture's brightest strand (#4c4c4c); the old #2c3531 drowned in it.
export const FAINT = "#56645d";
// dashed rules and dividers: they claim their whole row or column, so the texture never
// touches them and they keep the old faint shade
export const HAIRLINE = "#2c3531";
export const SEL_BG = "#15211b";
export const ERR = "#fda4af";
// text rows paint no background — the koi pond (browser canvas on web, server-drawn over ssh)
// shows through the gaps. Full-screen overlays (boot transition, pickers) use POND_BG_HEX.
export const PANEL = "transparent";

export function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export const BARS = "▁▂▃▄▅▆▇█";

export function commas(n: number) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function compactNum(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}
export function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Consistent stat card used across the home dashboard: a MUTED uppercase label,
// then content. One shared rhythm so every block lines up.
export const SEP = "  ·  ";
export function Stat({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text bg={PANEL}>
        <span fg={MUTED}>{label}</span>
        {meta ? <span fg={FAINT}>{`  ·  ${meta}`}</span> : null}
      </text>
      {children}
    </box>
  );
}
