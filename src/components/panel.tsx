import type { ReactNode } from "react";

type PanelProps = {
  title?: string;
  index?: number;
  id?: string;
  className?: string;
  children: ReactNode;
};

// Bordered terminal box with a title chip embedded in the top border.
// Hidden until <html data-booted> is set (after the boot screen lifts), then
// each panel slides in staggered by `index`.
export function Panel({ title, index = 0, id, className = "", children }: PanelProps) {
  return (
    <section id={id} className={`tui-panel ${className}`} style={{ animationDelay: `${index * 80}ms` }}>
      {title && <span className="tui-panel__title">{title}</span>}
      {children}
    </section>
  );
}
