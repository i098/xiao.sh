// ponytail: window event instead of React context — BootScreen owns the router,
// any component can request a TUI page transition without prop/context plumbing.
export function tuiNavigate(href: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("tui:navigate", { detail: href }));
}
