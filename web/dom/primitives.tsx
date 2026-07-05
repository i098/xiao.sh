// DOM implementations of the opentui intrinsic elements (box/text/span/strong/a/input).
// Layout contract: opentui positions everything on a Yoga flex grid measured in terminal
// cells; here a cell is `var(--cw)` × `var(--lh)` (set by metrics.ts), so numeric style
// values translate to calc() expressions and the layout stays cell-quantized.
import { useEffect, useRef, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { getMetrics } from "./metrics";

const xc = (v: number | string) => (typeof v === "number" ? `calc(${v} * var(--cw))` : v);
const yc = (v: number | string) => (typeof v === "number" ? `calc(${v} * var(--lh))` : v);

const X_KEYS = new Set(["width", "minWidth", "maxWidth", "left", "right", "paddingLeft", "paddingRight", "marginLeft", "marginRight"]);
const Y_KEYS = new Set(["height", "minHeight", "maxHeight", "top", "bottom", "paddingTop", "paddingBottom", "marginTop", "marginBottom"]);

type TuiStyle = Record<string, unknown> | undefined;

function cellStyle(s: TuiStyle, base: CSSProperties): CSSProperties {
  const o: CSSProperties = { ...base };
  if (!s) return o;
  for (const [k, v] of Object.entries(s)) {
    if (v == null) continue;
    if (X_KEYS.has(k)) (o as Record<string, unknown>)[k] = xc(v as number | string);
    else if (Y_KEYS.has(k)) (o as Record<string, unknown>)[k] = yc(v as number | string);
    else if (k === "padding") o.padding = `${yc(v as number)} ${xc(v as number)}`;
    else if (k === "margin") o.margin = `${yc(v as number)} ${xc(v as number)}`;
    else (o as Record<string, unknown>)[k] = v; // flex*, alignItems, justifyContent, position, zIndex, backgroundColor, ...
  }
  return o;
}

// Mouse events arrive as global viewport cell coordinates — every consumer either ignores
// them or uses row deltas (VolumeBar drag), so a shared origin is sufficient.
const cellXY = (e: RPointerEvent) => {
  const { cw, lh } = getMetrics();
  return { x: Math.floor(e.clientX / cw), y: Math.floor(e.clientY / lh) };
};

type MouseProps = {
  onMouseDown?: (e: { x: number; y: number }) => void;
  onMouseMove?: (e: { x: number; y: number }) => void;
  onMouseOut?: () => void;
  onMouseDrag?: (e: { x: number; y: number }) => void;
  onMouseScroll?: (e: { scroll?: { direction: string } }) => void;
};

type BoxProps = MouseProps & {
  style?: TuiStyle;
  border?: boolean;
  borderStyle?: string;
  borderColor?: string;
  title?: string;
  children?: ReactNode;
  // opentui frame-loop props (KoiPond) — never mounted on web, stripped defensively
  live?: boolean;
  renderAfter?: unknown;
};

function Box({ style, border, borderColor, onMouseDown, onMouseMove, onMouseOut, onMouseDrag, onMouseScroll, children }: BoxProps) {
  const css = cellStyle(style, {
    display: "flex",
    boxSizing: "border-box",
    minWidth: 0,
    // Yoga defaults differ from CSS flex defaults; making them explicit is load-bearing
    flexDirection: (style?.flexDirection as CSSProperties["flexDirection"]) ?? "column",
    flexShrink: (style?.flexShrink as number) ?? 0,
  });
  // Yoga measures text children under the container's width constraint; CSS flex-basis auto
  // sizes a growing box by unwrapped max-content instead. Basis 0 restores Yoga behavior.
  if (style?.flexGrow && style.width == null && style.height == null && style.flexBasis == null) css.flexBasis = "0%";
  if (border) {
    css.border = `1px solid ${borderColor ?? "#2c3531"}`;
    css.borderRadius = "6px"; // borderStyle:"rounded" is the only style in the tree
  }
  if (onMouseDown) css.cursor = "pointer";
  return (
    <div
      style={css}
      onPointerDown={
        onMouseDown || onMouseDrag
          ? (e) => {
              if (onMouseDrag) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              onMouseDown?.(cellXY(e));
            }
          : undefined
      }
      onPointerMove={
        onMouseDrag
          ? (e) => {
              if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) onMouseDrag(cellXY(e));
            }
          : onMouseMove
            ? (e) => onMouseMove(cellXY(e))
            : undefined
      }
      onPointerLeave={onMouseOut ? () => onMouseOut() : undefined}
      onWheel={onMouseScroll ? (e) => onMouseScroll({ scroll: { direction: e.deltaY < 0 ? "up" : "down" } }) : undefined}
    >
      {children}
    </div>
  );
}

type TextProps = {
  style?: TuiStyle;
  fg?: string;
  bg?: string;
  wrapMode?: string;
  attributes?: number;
  children?: ReactNode;
};

function Text({ style, fg, bg, wrapMode, attributes, children }: TextProps) {
  const css = cellStyle(style, {
    boxSizing: "border-box",
    minWidth: 0,
    flexShrink: 0,
    whiteSpace: wrapMode === "none" ? "pre" : "pre-wrap",
    overflow: wrapMode === "none" || style?.height != null ? "hidden" : undefined,
  });
  if (fg) css.color = fg;
  if (bg && bg !== "transparent") css.background = bg;
  if (attributes && attributes & 8) css.textDecoration = "underline";
  return <div style={css}>{children}</div>;
}

function Span({ fg, bg, attributes, children }: TextProps) {
  const css: CSSProperties = {};
  if (fg) css.color = fg;
  if (bg && bg !== "transparent") css.background = bg;
  if (attributes && attributes & 8) css.textDecoration = "underline";
  return <span style={css}>{children}</span>;
}

function Strong({ fg, bg, children }: TextProps) {
  const css: CSSProperties = { fontWeight: 600 };
  if (fg) css.color = fg;
  if (bg && bg !== "transparent") css.background = bg;
  return <span style={css}>{children}</span>;
}

function A({ href, fg, attributes, children }: TextProps & { href?: string }) {
  const css: CSSProperties = { textDecoration: attributes && attributes & 8 ? "underline" : "none" };
  if (fg) css.color = fg;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={css}>
      {children}
    </a>
  );
}

type InputProps = {
  style?: TuiStyle;
  focused?: boolean;
  placeholder?: string;
  value?: string;
  onInput?: (v: string) => void;
  onSubmit?: (v: string) => void;
};

function Input({ style, focused, placeholder, value, onInput, onSubmit }: InputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
    else ref.current?.blur();
  }, [focused]);
  const css = cellStyle(style, {
    boxSizing: "border-box",
    minWidth: 0,
    background: "transparent",
    border: "none",
    outline: "none",
    padding: 0,
    margin: 0,
    font: "inherit",
    color: "inherit",
    caretColor: "#43f08a",
    height: "var(--lh)",
  });
  return (
    <input
      ref={ref}
      style={css}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onInput?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit?.((e.target as HTMLInputElement).value);
      }}
    />
  );
}

export const INTRINSICS = { box: Box, text: Text, span: Span, strong: Strong, a: A, input: Input } as const;
