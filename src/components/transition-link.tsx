"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { tuiNavigate } from "@/lib/navigate";

type TransitionLinkProps = { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>;

// Internal link that plays the boot transition instead of a normal client nav.
export function TransitionLink({ href, children, ...rest }: TransitionLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        tuiNavigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
