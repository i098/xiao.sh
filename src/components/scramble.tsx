"use client";

import { useEffect, useRef, useState } from "react";
import type { ElementType } from "react";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/<>#*?$";

type ScrambleProps = {
  text: string;
  className?: string;
  delay?: number;
  duration?: number;
  as?: ElementType;
};

// Reveals `text` left-to-right while the unrevealed tail flickers random chars.
export default function Scramble({
  text,
  className,
  delay = 0,
  duration = 600,
  as: Tag = "span",
}: ScrambleProps) {
  const [out, setOut] = useState(text); // SSR + first paint render the final text (no hydration mismatch)
  const raf = useRef(0);
  const timer = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOut(text);
      return;
    }

    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const reveal = Math.floor(p * text.length);
      let next = "";
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        next += i < reveal || c === " " ? c : CHARS[Math.floor(Math.random() * CHARS.length)];
      }
      setOut(next);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setOut(text);
    };

    timer.current = window.setTimeout(() => {
      raf.current = requestAnimationFrame(tick);
    }, delay);

    return () => {
      window.clearTimeout(timer.current);
      cancelAnimationFrame(raf.current);
    };
  }, [text, delay, duration]);

  return <Tag className={className}>{out}</Tag>;
}
