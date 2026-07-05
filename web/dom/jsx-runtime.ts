// The web bundle's react/jsx-runtime: identical to React's, except intrinsic string tags
// that name opentui elements (box/text/span/...) resolve to the DOM primitives. The /app.js
// build plugin rewrites `react/jsx-runtime` imports to this file for modules under tui/ only,
// so the same JSX renders a terminal over ssh and HTML in the browser.
import { jsx as _jsx, jsxs as _jsxs, Fragment } from "react/jsx-runtime";
import { jsxDEV as _jsxDEV } from "react/jsx-dev-runtime";
import { INTRINSICS } from "./primitives";

type AnyTag = unknown;
const map = (t: AnyTag) => (typeof t === "string" && t in INTRINSICS ? INTRINSICS[t as keyof typeof INTRINSICS] : t);

export { Fragment };
export const jsx = (t: AnyTag, p: unknown, k?: unknown) => _jsx(map(t) as never, p as never, k as never);
export const jsxs = (t: AnyTag, p: unknown, k?: unknown) => _jsxs(map(t) as never, p as never, k as never);
export const jsxDEV = (t: AnyTag, p: unknown, k?: unknown, s?: unknown, src?: unknown, self?: unknown) =>
  _jsxDEV(map(t) as never, p as never, k as never, s as never, src as never, self as never);
