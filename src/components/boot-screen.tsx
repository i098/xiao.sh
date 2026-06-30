"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Fake `.sh` boot sequence. Plays on every load and on every TUI navigation:
// the overlay covers the outgoing page (load-out), the route swaps underneath,
// the script types out, then it lifts to reveal the new page (load-in).
const LINES = [
  "$ ssh guest@xiao.sh",
  "Last login: now on ttys001",
  "$ ./xiao.sh --boot",
  "[ ok ] mount /home/jerry",
  "[ ok ] load profile.json",
  "[ ok ] index projects",
  "[ ok ] spotify daemon up",
  "[ ok ] ai-search ready",
  "welcome -- jerry xiao",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function BootScreen() {
  const router = useRouter();
  const [visible, setVisible] = useState(true); // SSR renders the overlay so content never flashes
  const [shown, setShown] = useState(0);
  const running = useRef(false);

  async function run() {
    if (running.current) return;
    running.current = true;

    const root = document.documentElement;
    root.dataset.booting = "1";
    delete root.dataset.booted;
    setVisible(true);
    setShown(0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const perLine = reduced ? 0 : 95;
    for (let i = 1; i <= LINES.length; i += 1) {
      setShown(i);
      if (perLine) await sleep(perLine);
    }
    await sleep(reduced ? 120 : 420);

    setVisible(false);
    delete root.dataset.booting;
    root.dataset.booted = "1"; // triggers panel slide-in
    running.current = false;
  }

  // Boot on first mount (every hard page load).
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Boot on TUI navigation: cover -> route swap -> type -> lift.
  useEffect(() => {
    async function onNavigate(event: Event) {
      const href = (event as CustomEvent<string>).detail;
      if (typeof href !== "string") return;

      document.documentElement.dataset.booting = "1";
      setVisible(true);
      await sleep(180); // let the cover paint before swapping content
      router.push(href);
      await sleep(60);
      void run();
    }

    window.addEventListener("tui:navigate", onNavigate);
    return () => window.removeEventListener("tui:navigate", onNavigate);
  }, [router]);

  return (
    <div className={`tui-boot ${visible ? "" : "tui-boot--hidden"}`} aria-hidden={!visible}>
      <div className="tui-boot__inner">
        {LINES.slice(0, shown).map((line, i) => (
          <div key={i} className="tui-boot__line">
            {line}
          </div>
        ))}
        {visible && <span className="tui-caret" />}
      </div>
    </div>
  );
}
