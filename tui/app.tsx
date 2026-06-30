import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { profile } from "@/lib/profile";
import { projects, type Project } from "@/lib/projects";
import { ask, type ChatMessage } from "@/lib/ai";
import { EXTERNAL_LINK_ARROW } from "@/lib/symbols";
import type { LinkedInSnapshot } from "@/lib/linkedin";
import type { VisitInfo } from "@/lib/visits";
import { capture } from "@/lib/analytics";
import { getSpotify, type SpotifyState } from "@/lib/spotify";
import { autoName, deleteSession, listSessions, loadSession, saveSession, type SavedSession } from "@/lib/sessions";

// Editorial palette: green ACCENT reserved for links/active/live; neutral INK/MUTED/FAINT for hierarchy.
const ACCENT = "#43f08a";
const INK = "#e9ece9";
const MUTED = "#7c8a82";
const FAINT = "#2c3531";
const SEL_BG = "#15211b";
const ERR = "#fda4af";
// opaque strip behind text so the koi pond doesn't bleed through the spaces between words
const PANEL = "#070d0c";

const LIST_W = 30;

type Screen = "home" | "projects" | "about" | "chat" | "links";

const NAV: { key: string; screen: Screen }[] = [
  { key: "h", screen: "home" },
  { key: "p", screen: "projects" },
  { key: "a", screen: "about" },
  { key: "c", screen: "chat" },
  { key: "l", screen: "links" },
];
const SCREENS: Screen[] = ["home", "projects", "about", "chat", "links"];

// grouped /help — rendered as a multi-line assistant message (hierarchy, not one line)
const HELP_TEXT = [
  "COMMANDS",
  "  /help              show this",
  "  /clear             wipe history",
  "  /save [name]       save chat (auto-named if blank)",
  "  /resume [name]     reopen a saved chat — no name opens a picker",
  "  /delete [name]     delete a saved chat — no name opens a picker",
  "  /exit              back to home",
  "NAVIGATE",
  "  /home /projects /about /chat /links   (or press h p a c l)",
  "SCROLL",
  "  PageUp / PageDown   ·   ↑ / ↓ when the input is empty",
].join("\n");

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function compactLanguage(value: string) {
  return value
    .replace(/\s+(native or bilingual|full professional|professional working|limited working|elementary)\s+proficiency.*$/i, "")
    .trim();
}

// tight dashed rules (no solid lines anywhere)
function Rule({ w }: { w?: number }) {
  const { width } = useTerminalDimensions();
  return <text fg={FAINT}>{"-".repeat(Math.max(1, w ?? width))}</text>;
}
function VRule({ rows }: { rows: number }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <text key={i} fg={FAINT}>
          ╎
        </text>
      ))}
    </box>
  );
}

// stack tech -> short colored tag (terminal "icon"), brand color. keyed normalized.
const TECH: Record<string, { tag: string; col: string }> = {
  typescript: { tag: "TS", col: "#4fa3e3" },
  javascript: { tag: "JS", col: "#e8d44d" },
  python: { tag: "PY", col: "#6fb3df" },
  java: { tag: "JV", col: "#e8924f" },
  swift: { tag: "SW", col: "#f0764f" },
  rust: { tag: "RS", col: "#caa890" },
  html: { tag: "HT", col: "#e8694c" },
  css: { tag: "CSS", col: "#9b7ad6" },
  shell: { tag: "SH", col: "#89e051" },
  plpgsql: { tag: "SQL", col: "#5a9bd0" },
  react: { tag: "RE", col: "#61dafb" },
  nextjs: { tag: "NX", col: "#cfd3d6" },
  tailwindcss: { tag: "TW", col: "#38bdf8" },
  bun: { tag: "BUN", col: "#e7dcb6" },
  fastapi: { tag: "API", col: "#3fc7b4" },
  pytorch: { tag: "PT", col: "#ee6f4c" },
  postgresql: { tag: "PG", col: "#5a9bd0" },
  supabase: { tag: "SB", col: "#3ecf8e" },
  mongodb: { tag: "MDB", col: "#57a143" },
  redis: { tag: "RD", col: "#e0584c" },
  aws: { tag: "AWS", col: "#ff9d3b" },
  amazonwebservices: { tag: "AWS", col: "#ff9d3b" },
  googlecloud: { tag: "GCP", col: "#5b9bf5" },
  azure: { tag: "AZ", col: "#3ca7e6" },
  cloudflare: { tag: "CF", col: "#f0a03a" },
  docker: { tag: "DK", col: "#3a9aed" },
  kubernetes: { tag: "K8S", col: "#5b8def" },
  vim: { tag: "VIM", col: "#2aa84a" },
  apple: { tag: "APL", col: "#cccccc" },
  archlinux: { tag: "ARCH", col: "#3aa9e0" },
  raspberrypi: { tag: "RPI", col: "#e0507a" },
  nodejs: { tag: "NODE", col: "#83cd29" },
};
function techTag(name: string) {
  const key = name.toLowerCase().replace(/[.\s_-]/g, "");
  return TECH[key] ?? { tag: name.slice(0, 3).toUpperCase(), col: MUTED };
}
// curated stack (mirrors the GitHub icon set), grouped for the About screen
const MY_STACK: string[][] = [
  ["Apple", "Arch Linux", "Raspberry Pi"],
  ["Python", "Java", "JavaScript", "TypeScript", "Swift", "Rust"],
  ["React", "Next.js", "TailwindCSS"],
  ["Bun", "FastAPI", "PyTorch"],
  ["PostgreSQL", "Supabase", "MongoDB", "Redis"],
  ["AWS", "Google Cloud", "Azure", "Cloudflare"],
  ["Docker", "Kubernetes", "Vim"],
];
const LOCATIONS = "SF, CA  |  Sugar Land, TX  |  Boston, MA";

// The one link primitive. <a href> emits OSC 8 when the terminal supports it (clickable),
// otherwise renders as plain underlined accent text — never garbage.
function LinkLine({ label, href, text, bg }: { label: string; href: string; text: string; bg?: string }) {
  return (
    <text bg={bg}>
      <span fg={MUTED}>{label.padEnd(10)}</span>
      <a href={href} fg={ACCENT} attributes={TextAttributes.UNDERLINE}>
        {text}
      </a>
      <span fg={FAINT}> {EXTERNAL_LINK_ARROW}</span>
    </text>
  );
}

function ThinkingDots() {
  const frames = ["✶", "✳", "✻", "✽", "✻", "✳"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % frames.length), 120);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <text>
      <span fg={ACCENT}>{frames[i]} </span>
      <span fg={MUTED}>thinking…</span>
    </text>
  );
}

// Full-screen typed boot log. Used as the intro on connect (load-in) and on every screen
// change (load-out → swap → load-in). Lines type out, a bar fills, then onDone reveals.
const BOOT_LINES = [
  "$ ssh guest@xiao.sh",
  "Authenticating guest ............ OK",
  "$ ./xiao.sh --boot",
  "[ ok ] mount /home/jerry",
  "[ ok ] load profile.json",
  "[ ok ] index projects (9)",
  "[ ok ] connect spotify",
  "[ ok ] start ai-search daemon",
  "[ ok ] render tui",
  "ready.",
  "",
  "welcome — jerry xiao",
];

function bootLinesFor(to: Screen): string[] {
  return [`$ cd ~/${to}`, `[ ok ] open ${to}`];
}

function BootLine({ line }: { line: string }) {
  if (line.startsWith("[ ok ]")) {
    return (
      <text>
        <span fg={ACCENT}>[ ok ]</span>
        <span fg={MUTED}>{line.slice(6)}</span>
      </text>
    );
  }
  if (line.startsWith("$")) {
    return (
      <text>
        <span fg={ACCENT}>$</span>
        <span fg={INK}>{line.slice(1)}</span>
      </text>
    );
  }
  if (line === "ready." || line.startsWith("welcome")) return <text fg={ACCENT}>{line}</text>;
  return <text fg={MUTED}>{line}</text>;
}

function BootScreen({ lines, onDone }: { lines: string[]; onDone: () => void }) {
  const [n, setN] = useState(0);
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    let i = 0;
    const type = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= lines.length) {
        clearInterval(type);
        setTimeout(onDone, 300);
      }
    }, 80);
    const cur = setInterval(() => setBlink((b) => !b), 380);
    return () => {
      clearInterval(type);
      clearInterval(cur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = lines.length;
  const filled = Math.round((n / steps) * 24);
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", paddingLeft: 2, paddingTop: 1 }}>
      {lines.slice(0, n).map((l, i) => (
        <BootLine key={i} line={l} />
      ))}
      <text>
        <span fg={ACCENT}>{blink ? "▋" : " "}</span>
      </text>
      <box style={{ flexGrow: 1 }} />
      <text>
        <span fg={ACCENT}>{"▰".repeat(filled)}</span>
        <span fg={FAINT}>{"▱".repeat(Math.max(0, 24 - filled))}</span>
        <span fg={MUTED}>{`  ${Math.round((n / steps) * 100)}%`}</span>
      </text>
    </box>
  );
}

export default function App({
  linkedIn,
  visit,
  distinctId,
  onExit,
}: {
  linkedIn: LinkedInSnapshot;
  visit: VisitInfo;
  distinctId: string;
  onExit: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("home");
  const [booting, setBooting] = useState(true); // full-screen boot log on first mount
  const [transition, setTransition] = useState<Screen | null>(null);
  const [selected, setSelected] = useState(0);
  const go = useCallback(
    (target: Screen) => {
      capture(distinctId, "nav", { screen: target });
      setTransition(target);
    },
    [distinctId],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [scroll, setScroll] = useState(0); // chat history scrollback (0 = pinned to latest)
  const [picker, setPicker] = useState<{ items: SavedSession[]; index: number; mode: "resume" | "delete" } | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const inputRef = useRef(""); // mirror of `input` for the keyboard handler (avoids stale closure)
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chatActive = screen === "chat";
  const quit = useCallback(() => onExit(), [onExit]);

  const loadInto = useCallback((msgs: ChatMessage[]) => {
    messagesRef.current = msgs;
    setMessages(msgs);
    setScroll(0);
    setPicker(null);
  }, []);

  const handleInput = useCallback((v: string) => {
    inputRef.current = v;
    setInput(v);
  }, []);
  const resetInput = useCallback(() => {
    inputRef.current = "";
    setInput("");
    setInputKey((k) => k + 1);
  }, []);

  // full-screen koi pond shared state (rendered behind all content)
  const { width: termW, height: termH } = useTerminalDimensions();
  const pondMouse = useRef<{ x: number; y: number } | null>(null);
  const pondSplash = useRef<{ x: number; y: number; amp: number }[]>([]);
  const pondMoveN = useRef(0);

  // hide the terminal cursor (opentui Inputs draw their own caret)
  const renderer = useRenderer();
  useEffect(() => {
    renderer.setCursorPosition(0, 0, false);
  }, [renderer, screen, booting, transition]);

  const pushAssistant = useCallback((text: string) => {
    const withNote = [...messagesRef.current, { role: "assistant" as const, content: text }];
    messagesRef.current = withNote;
    setMessages(withNote);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || sending) return;
      // slash commands (claude-code-style) — handled locally, not sent to AI
      if (content.startsWith("/")) {
        resetInput();
        setScroll(0);
        const parts = content.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(" ").trim();
        // /home /projects /about /chat /links  (and single-char aliases h p a c l)
        const navTarget =
          (SCREENS.find((s) => s === cmd) as Screen | undefined) ?? NAV.find((n) => n.key === cmd)?.screen;
        if (navTarget) {
          if (navTarget !== "chat") go(navTarget);
          return;
        }
        if (cmd === "clear") {
          messagesRef.current = [];
          setMessages([]);
        } else if (cmd === "exit" || cmd === "quit") {
          go("home");
        } else if (cmd === "save") {
          if (messagesRef.current.length === 0) {
            pushAssistant("nothing to save yet.");
          } else {
            const s = saveSession(arg || autoName(messagesRef.current), messagesRef.current);
            pushAssistant(`saved as "${s.name}" (${s.count} messages). /resume to bring it back.`);
          }
        } else if (cmd === "resume") {
          if (arg) {
            const msgs = loadSession(arg);
            if (msgs) loadInto(msgs);
            else pushAssistant(`no saved chat "${arg}" — /resume with no name to pick one.`);
          } else {
            const items = listSessions();
            if (items.length === 0) pushAssistant("no saved chats yet — /save first.");
            else setPicker({ items, index: 0, mode: "resume" });
          }
        } else if (cmd === "delete" || cmd === "del" || cmd === "rm") {
          if (arg) {
            pushAssistant(deleteSession(arg) ? `deleted "${arg}".` : `no saved chat "${arg}".`);
          } else {
            const items = listSessions();
            if (items.length === 0) pushAssistant("no saved chats to delete.");
            else setPicker({ items, index: 0, mode: "delete" });
          }
        } else if (cmd === "help") {
          pushAssistant(HELP_TEXT);
        } else {
          pushAssistant(`unknown command: /${cmd} — try /help`);
        }
        return;
      }
      const next = [...messagesRef.current, { role: "user" as const, content }];
      messagesRef.current = next;
      setMessages(next);
      setScroll(0);
      resetInput();
      setSending(true);
      const result = await ask(next);
      const reply: ChatMessage = { role: "assistant", content: result.answer ?? result.error ?? "No response." };
      const withReply = [...messagesRef.current, reply];
      messagesRef.current = withReply;
      setMessages(withReply);
      setScroll(0);
      setSending(false);
    },
    [sending, resetInput, go, pushAssistant, loadInto],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();
    if (booting || transition) return; // ignore input during boot / transition
    // resume picker overlay takes all keys while open
    if (picker) {
      if (key.name === "up" || key.name === "k")
        return setPicker((p) => (p ? { ...p, index: Math.max(0, p.index - 1) } : p));
      if (key.name === "down" || key.name === "j")
        return setPicker((p) => (p ? { ...p, index: Math.min(p.items.length - 1, p.index + 1) } : p));
      if (key.name === "return" || key.name === "enter") {
        const sel = picker.items[picker.index];
        if (sel && picker.mode === "delete") {
          deleteSession(sel.slug);
          const items = listSessions();
          if (items.length === 0) setPicker(null);
          else setPicker((p) => (p ? { ...p, items, index: Math.min(p.index, items.length - 1) } : p));
          return;
        }
        const msgs = sel ? loadSession(sel.slug) : null;
        if (msgs) loadInto(msgs);
        else setPicker(null);
        return;
      }
      if (key.name === "escape") return setPicker(null);
      return;
    }
    if (chatActive) {
      if (key.name === "escape") {
        if (navTimer.current) clearTimeout(navTimer.current);
        navTimer.current = null;
        go("home");
        return;
      }
      // scroll chat history: PageUp/PageDown, or ↑/↓ when the input is empty
      if (key.name === "pageup") return setScroll((s) => s + 3);
      if (key.name === "pagedown") return setScroll((s) => Math.max(0, s - 3));
      if (inputRef.current === "" && key.name === "up") return setScroll((s) => s + 1);
      if (inputRef.current === "" && key.name === "down") return setScroll((s) => Math.max(0, s - 1));
      // any keystroke cancels a pending first-letter nav (means the user is actually typing)
      if (navTimer.current) {
        clearTimeout(navTimer.current);
        navTimer.current = null;
      }
      // first-letter nav: empty input + a nav letter held >250ms with no more typing → navigate
      if (inputRef.current === "" && typeof key.name === "string" && key.name.length === 1) {
        const nav = NAV.find((n) => n.key === key.name);
        if (nav && nav.screen !== "chat") {
          const target = nav.screen;
          const letter = key.name;
          navTimer.current = setTimeout(() => {
            navTimer.current = null;
            if (inputRef.current === letter) {
              resetInput();
              go(target);
            }
          }, 250);
        }
      }
      return;
    }
    if (key.name === "q") return quit();
    if (screen === "projects") {
      if (key.name === "up" || key.name === "k") {
        setSelected((s) => (s - 1 + projects.length) % projects.length);
        return;
      }
      if (key.name === "down" || key.name === "j") {
        setSelected((s) => (s + 1) % projects.length);
        return;
      }
    }
    const nav = NAV.find((n) => n.key === key.name);
    if (nav && nav.screen !== screen) go(nav.screen);
  });

  if (booting) {
    return <BootScreen key="boot" lines={BOOT_LINES} onDone={() => setBooting(false)} />;
  }
  if (transition) {
    return (
      <BootScreen
        key={transition}
        lines={bootLinesFor(transition)}
        onDone={() => {
          setScreen(transition);
          setTransition(null);
        }}
      />
    );
  }

  return (
    <box
      style={{ width: "100%", height: "100%" }}
      onMouseMove={(e: { x: number; y: number }) => {
        pondMouse.current = { x: e.x, y: e.y };
        if (pondMoveN.current++ % 2 === 0) pondSplash.current.push({ x: e.x, y: e.y, amp: 2.2 });
      }}
      onMouseDown={(e: { x: number; y: number }) => {
        pondSplash.current.push({ x: e.x, y: e.y, amp: 6 });
      }}
      onMouseOut={() => {
        pondMouse.current = null;
      }}
    >
      <KoiPond width={termW} height={termH} mouseRef={pondMouse} splashRef={pondSplash} />
      <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", flexDirection: "column", zIndex: 1 }}>
        <Header screen={screen} />
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          {screen === "home" && <Home visit={visit} />}
          {screen === "projects" && <Projects selected={selected} />}
          {screen === "about" && <About linkedIn={linkedIn} />}
          {screen === "links" && <Links />}
          {screen === "chat" && (
            <Chat
              messages={messages}
              sending={sending}
              input={input}
              inputKey={inputKey}
              scroll={scroll}
              inputActive={!picker}
              onInput={handleInput}
              onSubmit={send}
            />
          )}
        </box>
        <Footer screen={screen} chatActive={chatActive} />
      </box>
      {picker && (
        <ResumePicker items={picker.items} index={picker.index} mode={picker.mode} width={termW} height={termH} />
      )}
    </box>
  );
}

function Header({ screen }: { screen: Screen }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
        <text>
          <strong fg={INK}>xiao.sh</strong>
        </text>
        <text>
          <span fg={FAINT}>{"~/"}</span>
          <span fg={ACCENT}>{screen}</span>
        </text>
      </box>
      <Rule />
    </box>
  );
}

function Footer({ screen, chatActive }: { screen: Screen; chatActive: boolean }) {
  const hint = chatActive ? "Enter send · Esc back" : screen === "projects" ? "↑↓ / j k move · q quit" : "q quit";
  return (
    <box style={{ flexDirection: "column" }}>
      <Rule />
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <text>
          {NAV.map((n) => (
            <span key={n.key}>
              <span fg={ACCENT}>{n.key}</span>
              <span fg={n.screen === screen ? INK : MUTED}>{` ${n.screen}   `}</span>
            </span>
          ))}
        </text>
        <text fg={MUTED}>{hint}</text>
      </box>
    </box>
  );
}

type Cell = { ch: string; c: string };

// water surface as ascii, by wave amplitude (height-field magnitude)
// signed height -> glyph by amplitude, color by intensity AND sign (crest = bright cyan,
// trough = deep blue) for clear wave color contrast
function waterCell(v: number): Cell {
  const a = v < 0 ? -v : v;
  if (a < 0.07) return { ch: " ", c: "#0e2329" };
  const crest = v > 0;
  if (a > 0.6) return { ch: "≈", c: crest ? "#cdf2ff" : "#356fa6" };
  if (a > 0.32) return { ch: "~", c: crest ? "#86d6ec" : "#2c5f8c" };
  if (a > 0.16) return { ch: "˙", c: crest ? "#52a0b6" : "#274f72" };
  return { ch: "·", c: crest ? "#2f6b7a" : "#1d3c55" };
}

// koi rendered as ascii glyphs (not solid blocks), shaded by body coverage
function koiGlyph(count: number, color: string): string {
  if (color === EYE) return "•";
  return count === 2 ? "#" : "*";
}

// Pixel-art koi (top-down). Each char = one pixel; rendered with half-block ▀
// (top px = fg, bottom px = bg) so it has true 2x vertical resolution + correct aspect.
// W/w white body · o/r orange-red kohaku patches · b blue fins · k black eye · . transparent.
const KOI_PALETTE: Record<string, string> = {
  W: "#eef2f5",
  w: "#cdd6dc",
  o: "#ff8a3d",
  r: "#d94f28",
  b: "#6f93cf",
  k: "#0c1016",
};
const WHITE = KOI_PALETTE.W;
const ORANGE = KOI_PALETTE.o;
const RED = KOI_PALETTE.r;
const EYE = KOI_PALETTE.k;
const N_COILS = 12;
const COIL_SP = 3.0; // px between body coils (shorter body = less snake-like)
const MAX_BEND = 0.22; // max bend per joint (rad) — keeps the body fish-stiff, not snake-curly

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// body width profile: slim koi (tapered head/tail), scaled per fish
function coilRadius(i: number, size = 1) {
  const t = i / (N_COILS - 1);
  return (1.0 + 3.7 * Math.sin(t * Math.PI) + (t < 0.16 ? 0.8 : 0)) * size;
}
// irregular kohaku blotches on the white body (i, color, size ratio, side offset)
const KOI_BLOTCHES: { i: number; col: string; dr: number; off: number }[] = [
  { i: 2, col: ORANGE, dr: 0.6, off: -0.4 },
  { i: 4, col: RED, dr: 0.75, off: 0.2 },
  { i: 6, col: ORANGE, dr: 0.55, off: 0.45 },
  { i: 8, col: RED, dr: 0.5, off: -0.35 },
];

// lily pads (fractions of pond w/h, radius px) — drawn above koi, below text.
// each has a wedge slice removed (notch center angle + half-width); one bears a flower.
const PAD = "#3f6e3a";
const PAD_PETAL = "#f3a8c8";
const PAD_FLOWER_CENTER = "#f2d36b";
const LILY_PADS = [
  { fx: 0.86, fy: 0.2, r: 10, notch: 2.4, notchW: 0.4, flower: true }, // top-right (acute slice)
  { fx: 0.88, fy: 0.82, r: 11, notch: -2.3, notchW: 0.45, flower: false }, // bottom-right
  { fx: 0.12, fy: 0.84, r: 8, notch: -0.8, notchW: 0.35, flower: false }, // bottom-left
];

type KoiState = {
  s: number;
  spd: number;
  size: number;
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  ph: number;
  spine: { x: number; y: number }[];
};

// Full-screen koi pond behind all content; koi swim in from the edges, flee the cursor;
// cursor/koi leave wave-sim ripples. Mouse + splashes are fed in from the App root.
function KoiPond({
  width,
  height,
  mouseRef,
  splashRef,
}: {
  width: number;
  height: number;
  mouseRef: { current: { x: number; y: number } | null };
  splashRef: { current: { x: number; y: number; amp: number }[] };
}) {
  const W = Math.max(10, width);
  const H = Math.max(6, height);
  const PW = W;
  const PH = H * 2; // pixel rows (half-block)
  const koi = useRef<KoiState[]>([]);
  const hCur = useRef<Float32Array | null>(null);
  const hPrev = useRef<Float32Array | null>(null);
  const [, force] = useState(0);

  if (!hCur.current || hCur.current.length !== W * H) {
    hCur.current = new Float32Array(W * H);
    hPrev.current = new Float32Array(W * H);
  }
  function splash(x: number, y: number, amp: number) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return;
    hCur.current![yi * W + xi] -= amp;
  }

  useEffect(() => {
    const margin = 12;
    // each koi swims its own wandering loop (own center / amplitude / phase / speed)
    function leadFor(k: KoiState, s: number) {
      return {
        x: clamp(k.cx + k.ax * Math.sin(s + k.ph) + k.ax * 0.33 * Math.sin(2.7 * s + k.ph + 1.3), margin, PW - margin),
        y: clamp(k.cy + k.ay * Math.cos(0.9 * s + k.ph) + k.ay * 0.42 * Math.sin(1.6 * s + k.ph + 0.5), margin, PH - margin),
      };
    }
    if (koi.current.length === 0) {
      const defs: Omit<KoiState, "s" | "spine">[] = [
        { spd: 0.018, size: 1.0, cx: PW * 0.42, cy: PH * 0.5, ax: PW * 0.3, ay: PH * 0.26, ph: 0 },
        { spd: 0.023, size: 0.8, cx: PW * 0.6, cy: PH * 0.42, ax: PW * 0.24, ay: PH * 0.22, ph: 2.1 },
        { spd: 0.015, size: 0.62, cx: PW * 0.5, cy: PH * 0.62, ax: PW * 0.33, ay: PH * 0.2, ph: 4.2 },
      ];
      koi.current = defs.map((d) => {
        const k: KoiState = { ...d, s: d.ph, spine: [] };
        // start just off a random edge, body trailing further off-screen → swims in
        const edge = Math.floor(Math.random() * 4);
        let hx = 0;
        let hy = 0;
        let dx = 0;
        let dy = 0;
        if (edge === 0) {
          hx = Math.random() * PW;
          hy = -3;
          dy = -1;
        } else if (edge === 1) {
          hx = Math.random() * PW;
          hy = PH + 3;
          dy = 1;
        } else if (edge === 2) {
          hx = -3;
          hy = Math.random() * PH;
          dx = -1;
        } else {
          hx = PW + 3;
          hy = Math.random() * PH;
          dx = 1;
        }
        k.spine = Array.from({ length: N_COILS }, (_, i) => ({ x: hx + dx * i * COIL_SP, y: hy + dy * i * COIL_SP }));
        return k;
      });
    }
    const id = setInterval(() => {
      const m = mouseRef.current;
      for (const k of koi.current) {
        k.s += k.spd;
        const target = leadFor(k, k.s);
        const head = k.spine[0];
        if (m) {
          const dx = head.x - m.x;
          const dy = head.y - m.y * 2;
          const d = Math.hypot(dx, dy);
          if (d < 24 && d > 0.001) {
            const f = (24 - d) * 0.5;
            target.x += (dx / d) * f;
            target.y += (dy / d) * f;
          }
        }
        // separation: steer away from the nearest part of every other koi
        for (const o of koi.current) {
          if (o === k || o.spine.length === 0) continue;
          let best = Infinity;
          let bx = 0;
          let by = 0;
          for (const sp of o.spine) {
            const dd = (head.x - sp.x) ** 2 + (head.y - sp.y) ** 2;
            if (dd < best) {
              best = dd;
              bx = sp.x;
              by = sp.y;
            }
          }
          const sd = Math.sqrt(best);
          const sr = 5 * k.size + 5 * o.size + 5;
          if (sd < sr && sd > 0.001) {
            const f = (sr - sd) * 0.9;
            target.x += ((head.x - bx) / sd) * f;
            target.y += ((head.y - by) / sd) * f;
          }
        }
        // ease toward target but cap speed → natural constant-glide swim-in from edges
        const ex = (target.x - head.x) * 0.16;
        const ey = (target.y - head.y) * 0.16;
        const es = Math.hypot(ex, ey) || 1;
        const maxStep = 1.1;
        const scale = es > maxStep ? maxStep / es : 1;
        head.x += ex * scale;
        head.y += ey * scale;
        // follow chain with per-joint bend limit (fish-stiff, not snake-curly)
        for (let i = 1; i < N_COILS; i += 1) {
          const a = k.spine[i - 1];
          const b = k.spine[i];
          let ang = Math.atan2(b.y - a.y, b.x - a.x);
          if (i >= 2) {
            const p2 = k.spine[i - 2];
            const prevA = Math.atan2(a.y - p2.y, a.x - p2.x);
            let diff = ang - prevA;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            if (diff > MAX_BEND) ang = prevA + MAX_BEND;
            else if (diff < -MAX_BEND) ang = prevA - MAX_BEND;
          }
          b.x = a.x + Math.cos(ang) * COIL_SP;
          b.y = a.y + Math.sin(ang) * COIL_SP;
        }
      }
      // water height-field: wave propagation + damping (double-buffered), once per frame
      const cur = hCur.current!;
      const prev = hPrev.current!;
      for (let y = 1; y < H - 1; y += 1) {
        const row = y * W;
        for (let x = 1; x < W - 1; x += 1) {
          const i = row + x;
          let v = (cur[i - 1] + cur[i + 1] + cur[i - W] + cur[i + W]) / 2 - prev[i];
          v *= 0.93; // more damping → tighter, smaller ripples
          prev[i] = v;
        }
      }
      hCur.current = prev;
      hPrev.current = cur;
      // queued cursor splashes (fed from the App root mouse handler)
      const q = splashRef.current;
      for (let i = 0; i < q.length; i += 1) splash(q[i].x, q[i].y, q[i].amp);
      q.length = 0;
      // gentle koi wakes
      for (const k of koi.current) {
        splash(k.spine[0].x, k.spine[0].y / 2, 0.18);
        splash(k.spine[N_COILS - 1].x, k.spine[N_COILS - 1].y / 2, 0.12);
      }
      force((n) => (n + 1) & 0xffff);
    }, 33);
    return () => clearInterval(id);
  }, [PW, PH]);

  // water surface from the height field
  const field = hCur.current!;
  const grid: Cell[][] = [];
  for (let y = 0; y < H; y += 1) {
    const row: Cell[] = [];
    for (let x = 0; x < W; x += 1) row.push(waterCell(field[y * W + x]));
    grid.push(row);
  }
  // koi: draw the body chain into a pixel buffer, then half-block composite onto the grid
  {
    const buf: (string | null)[] = new Array(PW * PH).fill(null);
    const disk = (cx2: number, cy2: number, r: number, col: string) => {
      const r2 = r * r;
      const y0 = Math.max(0, Math.floor(cy2 - r));
      const y1 = Math.min(PH - 1, Math.ceil(cy2 + r));
      const x0 = Math.max(0, Math.floor(cx2 - r));
      const x1 = Math.min(PW - 1, Math.ceil(cx2 + r));
      for (let yy = y0; yy <= y1; yy += 1)
        for (let xx = x0; xx <= x1; xx += 1) {
          const dx = xx - cx2;
          const dy = yy - cy2;
          if (dx * dx + dy * dy <= r2) buf[yy * PW + xx] = col;
        }
    };
    const triFill = (ax2: number, ay2: number, bx2: number, by2: number, cx3: number, cy3: number, col: string) => {
      const minx = Math.max(0, Math.floor(Math.min(ax2, bx2, cx3)));
      const maxx = Math.min(PW - 1, Math.ceil(Math.max(ax2, bx2, cx3)));
      const miny = Math.max(0, Math.floor(Math.min(ay2, by2, cy3)));
      const maxy = Math.min(PH - 1, Math.ceil(Math.max(ay2, by2, cy3)));
      const den = (by2 - cy3) * (ax2 - cx3) + (cx3 - bx2) * (ay2 - cy3);
      if (Math.abs(den) < 1e-6) return;
      for (let yy = miny; yy <= maxy; yy += 1)
        for (let xx = minx; xx <= maxx; xx += 1) {
          const w1 = ((by2 - cy3) * (xx - cx3) + (cx3 - bx2) * (yy - cy3)) / den;
          const w2 = ((cy3 - ay2) * (xx - cx3) + (ax2 - cx3) * (yy - cy3)) / den;
          if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) buf[yy * PW + xx] = col;
        }
    };
    const setpx = (x: number, y: number, col: string) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi >= 0 && yi >= 0 && xi < PW && yi < PH) buf[yi * PW + xi] = col;
    };

    for (const k of koi.current) {
      const spine = k.spine;
      if (!spine.length) continue;
      const size = k.size;

      // body: white base + irregular kohaku blotches (no full-width stripes)
      for (let i = N_COILS - 1; i >= 0; i -= 1) disk(spine[i].x, spine[i].y, coilRadius(i, size), WHITE);
      for (const b of KOI_BLOTCHES) {
        const c = spine[b.i];
        const cp = spine[b.i - 1];
        const dl = Math.hypot(c.x - cp.x, c.y - cp.y) || 1;
        const ppx = -(c.y - cp.y) / dl;
        const ppy = (c.x - cp.x) / dl;
        const r = coilRadius(b.i, size);
        disk(c.x + ppx * b.off * r, c.y + ppy * b.off * r, r * b.dr, b.col);
      }

      // tail: distinct forked fin, set off by a gap, swaying
      const t0 = spine[N_COILS - 1];
      const t1 = spine[N_COILS - 2];
      const tl = Math.hypot(t0.x - t1.x, t0.y - t1.y) || 1;
      const ux = (t0.x - t1.x) / tl;
      const uy = (t0.y - t1.y) / tl;
      const bx0 = t0.x + ux * 1.6 * size;
      const by0 = t0.y + uy * 1.6 * size;
      const sway = Math.sin(k.s * 7) * 3.2 * size;
      const tailLen = 6 * size;
      for (const lobe of [1, -1]) {
        const spread = lobe * 3.4 * size + sway;
        const apx = bx0 + ux * tailLen + -uy * spread;
        const apy = by0 + uy * tailLen + ux * spread;
        triFill(bx0 + -uy * 0.7, by0 + ux * 0.7, bx0 - -uy * 0.7, by0 - ux * 0.7, apx, apy, WHITE);
      }

      // pectoral fins: triangles swept back toward the tail
      const mi = 3;
      const mc = spine[mi];
      const mp = spine[mi - 1];
      const ml = Math.hypot(mc.x - mp.x, mc.y - mp.y) || 1;
      const tx = (mc.x - mp.x) / ml;
      const ty = (mc.y - mp.y) / ml;
      const fpx = -ty;
      const fpy = tx;
      const flap = 1 + Math.sin(k.s * 5 + 1) * 0.35;
      const r0 = coilRadius(mi, size);
      const finLen = 6 * size;
      const finOut = 4.5 * flap * size;
      for (const side of [1, -1]) {
        const rfx = mc.x + fpx * side * r0 * 0.7 - tx * 2;
        const rfy = mc.y + fpy * side * r0 * 0.7 - ty * 2;
        const rbx = mc.x + fpx * side * r0 * 0.7;
        const rby = mc.y + fpy * side * r0 * 0.7;
        const tipx = mc.x + tx * finLen + fpx * side * (r0 + finOut);
        const tipy = mc.y + ty * finLen + fpy * side * (r0 + finOut);
        triFill(rfx, rfy, rbx, rby, tipx, tipy, KOI_PALETTE.w);
      }

      // eyes near the head
      const h0 = spine[0];
      const h1 = spine[1];
      const hl = Math.hypot(h0.x - h1.x, h0.y - h1.y) || 1;
      const epx = -(h0.y - h1.y) / hl;
      const epy = (h0.x - h1.x) / hl;
      const eo = 1.7 * size;
      setpx(h0.x + epx * eo, h0.y + epy * eo, EYE);
      setpx(h0.x - epx * eo, h0.y - epy * eo, EYE);
    }

    // lily pads: drawn AFTER koi (so koi swim under them), gently bobbing, with a flower
    const padTime = koi.current[0]?.s ?? 0;
    LILY_PADS.forEach((p, i) => {
      const cxp = p.fx * PW;
      const cyp = p.fy * PH + Math.sin(padTime * 1.4 + i) * 0.35;
      // draw the pad as a disk MINUS the wedge — the notch is never painted, so koi
      // (drawn earlier) stay visible through the cut instead of being erased
      const r2 = p.r * p.r;
      const y0 = Math.max(0, Math.floor(cyp - p.r));
      const y1 = Math.min(PH - 1, Math.ceil(cyp + p.r));
      const x0 = Math.max(0, Math.floor(cxp - p.r));
      const x1 = Math.min(PW - 1, Math.ceil(cxp + p.r));
      for (let yy = y0; yy <= y1; yy += 1)
        for (let xx = x0; xx <= x1; xx += 1) {
          const dx = xx - cxp;
          const dy = yy - cyp;
          if (dx * dx + dy * dy > r2) continue;
          let diff = Math.atan2(dy, dx) - p.notch;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (Math.abs(diff) < p.notchW) continue; // skip the wedge → leave koi/water
          buf[yy * PW + xx] = PAD;
        }
      // flower on the one designated pad: 5 petals + center
      if (p.flower) {
        for (let k = 0; k < 5; k += 1) {
          const a = (k * 2 * Math.PI) / 5 - 1.2;
          disk(cxp + Math.cos(a) * 2.4, cyp + Math.sin(a) * 2.4, 1.4, PAD_PETAL);
        }
        disk(cxp, cyp, 1.3, PAD_FLOWER_CENTER);
      }
    });

    // ascii composite: one glyph per cell, shaded by coverage of its two pixels
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1) {
        const top = buf[2 * y * PW + x];
        const bot = buf[(2 * y + 1) * PW + x];
        if (top || bot) {
          const col = (top ?? bot) as string;
          grid[y][x] = { ch: koiGlyph((top ? 1 : 0) + (bot ? 1 : 0), col), c: col };
        }
      }
  }

  // rows -> color-run spans
  const rows = grid.map((row, y) => {
    const spans: { c: string; text: string }[] = [];
    for (const cell of row) {
      const last = spans[spans.length - 1];
      if (last && last.c === cell.c) last.text += cell.ch;
      else spans.push({ c: cell.c, text: cell.ch });
    }
    return (
      <text key={y}>
        {spans.map((s, i) => (
          <span key={i} fg={s.c}>
            {s.text}
          </span>
        ))}
      </text>
    );
  });

  return (
    <box style={{ position: "absolute", left: 0, top: 0, width: W, height: H, zIndex: 0, flexDirection: "column" }}>
      {rows}
    </box>
  );
}

const BARS = "▁▂▃▄▅▆▇█";

function commas(n: number) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// daily-visits bar chart — multi-row, sub-cell block resolution, with a y-axis (max/0)
const CHART_ROWS = 7;
const BAR_W = 2; // cells per day column
function VisitorChart({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const rows = [];
  for (let r = CHART_ROWS - 1; r >= 0; r -= 1) {
    let bars = "";
    for (const v of data) {
      const level = (v / max) * CHART_ROWS - r; // fractional rows of this bar still above row r
      const ch = level >= 1 ? "█" : level <= 0 ? " " : BARS[Math.max(0, Math.min(7, Math.floor(level * 8)))];
      bars += ch.repeat(BAR_W);
    }
    const gutter = r === CHART_ROWS - 1 ? `${max}`.padStart(3) + " " : r === 0 ? "  0 " : "    ";
    rows.push({ gutter, bars });
  }
  const axisW = data.length * BAR_W;
  const caption = "14d ago".padEnd(Math.max(8, axisW - 5)) + "today";
  return (
    <box style={{ flexDirection: "column" }}>
      {rows.map((row, i) => (
        <text key={i} bg={PANEL}>
          <span fg={FAINT}>{row.gutter}</span>
          <span fg={ACCENT}>{row.bars}</span>
        </text>
      ))}
      <text bg={PANEL} fg={FAINT}>{"    " + "─".repeat(axisW)}</text>
      <text bg={PANEL} fg={FAINT}>{"    " + caption}</text>
    </box>
  );
}

// animated equalizer (deterministic sines, no RNG) shown while a track is playing
function Equalizer() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((n) => n + 1), 140);
    return () => clearInterval(id);
  }, []);
  const bars = Array.from({ length: 14 }, (_, i) => {
    const v = (Math.sin(t * 0.6 + i * 0.9) + Math.sin(t * 0.37 + i * 0.5)) * 0.25 + 0.5;
    return BARS[Math.max(0, Math.min(BARS.length - 1, Math.round(v * (BARS.length - 1))))];
  }).join("");
  return (
    <text bg={PANEL}>
      <span fg={ACCENT}>{bars}</span>
    </text>
  );
}

function ProgressBar({ progress, duration }: { progress: number; duration: number }) {
  const w = 18;
  const f = duration > 0 ? Math.max(0, Math.min(1, progress / duration)) : 0;
  const filled = Math.round(f * w);
  return (
    <text bg={PANEL}>
      <span fg={ACCENT}>{"▰".repeat(filled)}</span>
      <span fg={FAINT}>{"▱".repeat(w - filled)}</span>
      <span fg={MUTED}>{`  ${fmtMs(progress)} / ${fmtMs(duration)}`}</span>
    </text>
  );
}

// Spotify now-playing / recently-played. Polls server-side; hides entirely if Spotify isn't configured.
function NowPlaying() {
  const [state, setState] = useState<SpotifyState | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getSpotify()
        .then((s) => {
          if (alive) setState(s);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!state || !state.configured) return null;
  const t = state.track;
  return (
    <box style={{ flexDirection: "column" }}>
      <text bg={PANEL}>
        <span fg={MUTED}>{state.isPlaying ? "NOW PLAYING" : "LAST PLAYED"}</span>
        {state.isPlaying ? <span fg={ACCENT}>{"  ●"}</span> : null}
      </text>
      {t && t.name ? (
        <box style={{ flexDirection: "column" }}>
          <text bg={PANEL}>
            <span fg={ACCENT}>{"♫ "}</span>
            <span fg={INK}>{truncate(t.name, 40)}</span>
            <span fg={MUTED}>{t.artists.length ? `  —  ${truncate(t.artists.join(", "), 28)}` : ""}</span>
          </text>
          {state.isPlaying && state.progressMs != null && state.durationMs ? (
            <ProgressBar progress={state.progressMs} duration={state.durationMs} />
          ) : state.isPlaying ? (
            <Equalizer />
          ) : null}
        </box>
      ) : (
        <text bg={PANEL} fg={FAINT}>
          nothing recently
        </text>
      )}
    </box>
  );
}

function Home({ visit }: { visit: VisitInfo }) {
  return (
    <box style={{ flexDirection: "column", paddingLeft: 2, paddingTop: 2 }}>
      <text bg={PANEL}>
        <strong fg={INK}>{profile.name}</strong>
      </text>
      <text bg={PANEL} fg={MUTED}>
        CS @ Northeastern
      </text>
      <box style={{ height: 1 }} />
      <text bg={PANEL} fg={FAINT}>
        VISITORS
      </text>
      <text bg={PANEL}>
        <strong fg={ACCENT}>{`#${commas(visit.count)}`}</strong>
        <span fg={MUTED}>{`  all-time · ${visit.daily[visit.daily.length - 1] ?? 0} today`}</span>
      </text>
      <box style={{ height: 1 }} />
      <VisitorChart data={visit.daily} />
      <box style={{ height: 1 }} />
      <NowPlaying />
    </box>
  );
}

// arrow-key picker overlay for /resume and /delete
function ResumePicker({
  items,
  index,
  mode,
  width,
  height,
}: {
  items: SavedSession[];
  index: number;
  mode: "resume" | "delete";
  width: number;
  height: number;
}) {
  const w = Math.min(60, Math.max(28, width - 8));
  const rows = items.slice(0, 10);
  const accent = mode === "delete" ? ERR : ACCENT;
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(2, Math.floor((width - w) / 2)),
        top: Math.max(2, Math.floor(height / 2) - 8),
        width: w,
        zIndex: 10,
        flexDirection: "column",
        backgroundColor: PANEL,
        border: true,
        borderStyle: "rounded",
        borderColor: accent,
        padding: 1,
      }}
    >
      <text bg={PANEL} fg={accent}>
        {mode === "delete" ? "delete a chat" : "resume a chat"}
      </text>
      <text bg={PANEL} fg={FAINT}>
        {mode === "delete" ? "↑/↓ select · enter delete · esc cancel" : "↑/↓ select · enter open · esc cancel"}
      </text>
      <box style={{ height: 1 }} />
      {rows.map((s, i) => (
        <text key={s.slug} bg={i === index ? SEL_BG : PANEL}>
          <span fg={i === index ? accent : FAINT}>{i === index ? "▐ " : "  "}</span>
          <span fg={i === index ? INK : MUTED}>{truncate(s.name, w - 14)}</span>
          <span fg={FAINT}>{`  ${s.count}msg`}</span>
        </text>
      ))}
    </box>
  );
}

function ProjectItem({ title, active }: { title: string; active: boolean }) {
  const label = truncate(title, LIST_W - 4);
  return (
    <text bg={active ? SEL_BG : undefined}>
      <span fg={active ? ACCENT : FAINT}>{active ? " ▐▌ " : "    "}</span>
      <span fg={active ? INK : MUTED}>{label.padEnd(LIST_W - 4)}</span>
    </text>
  );
}

function ProjectLinks({ p }: { p: Project }) {
  // Full URLs as visible text: xterm's web-links addon only makes complete http(s) URLs
  // clickable in the browser (opentui does not emit OSC 8 over the ws shim). href carries
  // the same URL. LinkedIn post URLs are too long to show cleanly, so they're omitted here
  // (the About screen covers LinkedIn).
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={FAINT}>LINKS</text>
      <LinkLine label="GitHub" href={p.githubUrl} text={p.githubUrl} />
      {p.eventUrl && <LinkLine label="Event" href={p.eventUrl} text={p.eventUrl.split("?")[0]} />}
    </box>
  );
}

function Projects({ selected }: { selected: number }) {
  const p = projects[selected];
  const top3 = p.highlight?.toLowerCase().includes("top 3");
  const { width, height } = useTerminalDimensions();
  const bodyRows = Math.max(4, height - 5);
  const detailW = Math.max(20, width - LIST_W - 6);
  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ width: LIST_W, flexDirection: "column", paddingTop: 1 }}>
        <text fg={FAINT}>{"  PROJECTS"}</text>
        <box style={{ height: 1 }} />
        {projects.map((project, i) => (
          <ProjectItem key={project.title} title={project.title} active={i === selected} />
        ))}
      </box>

      <VRule rows={bodyRows} />

      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
        {p.highlight && <text fg={ACCENT}>{(top3 ? "★ " : "") + p.highlight.toUpperCase()}</text>}
        <text>
          <strong fg={INK}>{p.title}</strong>
        </text>
        <box style={{ height: 1 }} />
        <text fg={MUTED}>{p.summary}</text>
        <box style={{ height: 1 }} />
        <Rule w={detailW} />
        <box style={{ height: 1 }} />
        <text>
          <span fg={FAINT}>STACK   </span>
          {p.tags.map((t, i) => {
            const { tag, col } = techTag(t);
            return (
              <span key={i} fg={col}>{`● ${tag}   `}</span>
            );
          })}
        </text>
        <box style={{ height: 1 }} />
        <ProjectLinks p={p} />
      </box>
    </box>
  );
}

function About({ linkedIn }: { linkedIn: LinkedInSnapshot }) {
  const lp = linkedIn.profile;
  const languages = [
    ...new Set(((linkedIn.sections ?? []).find((s) => s.title === "Languages")?.items ?? []).map(compactLanguage)),
  ].filter(Boolean);
  // bg={PANEL} per line: an opaque strip behind each row of text so the koi pond shows
  // *around* the words (between rows, in the margins) but never bleeds through the spaces.
  return (
    <box style={{ flexDirection: "column", paddingLeft: 2, paddingTop: 2 }}>
      <text bg={PANEL}>
        <strong fg={INK}>{lp.name}</strong>
        {typeof lp.followerCount === "number" ? <span fg={MUTED}>{`   ${lp.followerCount} followers`}</span> : null}
      </text>
      {lp.title && <text bg={PANEL} fg={MUTED}>{truncate(lp.title, 72)}</text>}
      <box style={{ height: 1 }} />
      <text bg={PANEL}>
        <span fg={MUTED}>education   </span>
        <span fg={INK}>{profile.education}</span>
      </text>
      <text bg={PANEL}>
        <span fg={MUTED}>location    </span>
        <span fg={INK}>{LOCATIONS}</span>
      </text>
      {languages.length > 0 && (
        <text bg={PANEL}>
          <span fg={MUTED}>languages   </span>
          <span fg={INK}>{truncate(languages.join(" · "), 58)}</span>
        </text>
      )}
      <box style={{ height: 1 }} />
      <text bg={PANEL} fg={MUTED}>SOCIALS</text>
      <LinkLine label="LinkedIn" href={profile.links.linkedin} text={profile.links.linkedin} bg={PANEL} />
      <LinkLine label="GitHub" href={profile.links.github} text={profile.links.github} bg={PANEL} />
      <LinkLine label="Email" href={`mailto:${profile.links.email}`} text={profile.links.email} bg={PANEL} />
      <box style={{ height: 1 }} />
      <text bg={PANEL} fg={FAINT}>STACK</text>
      <text bg={PANEL}>
        {MY_STACK.map((group, gi) => (
          <span key={gi}>
            {gi > 0 ? <span fg={FAINT}>{"·  "}</span> : null}
            {group.map((t, ti) => {
              const { tag, col } = techTag(t);
              return (
                <span key={ti} fg={col}>{`● ${tag}  `}</span>
              );
            })}
          </span>
        ))}
      </text>
      <box style={{ height: 1 }} />
      <text bg={PANEL} fg={MUTED}>RECENT POSTS</text>
      {linkedIn.posts.slice(0, 3).map((post) => (
        <text key={post.url} bg={PANEL}>
          <span fg={FAINT}>· </span>
          <a href={post.url} fg={ACCENT} attributes={TextAttributes.UNDERLINE}>
            {truncate(post.headline ?? post.url, 64)}
          </a>
        </text>
      ))}
    </box>
  );
}

function Links() {
  const rows: [string, string, string][] = [
    ["Email", `mailto:${profile.links.email}`, profile.links.email],
    ["GitHub", profile.links.github, profile.links.github],
    ["LinkedIn", profile.links.linkedin, profile.links.linkedin],
  ];
  return (
    <box style={{ flexDirection: "column", paddingLeft: 2, paddingTop: 2 }}>
      <text fg={MUTED}>ELSEWHERE</text>
      <box style={{ height: 1 }} />
      {rows.map(([label, href, text]) => (
        <LinkLine key={label} label={label} href={href} text={text} />
      ))}
    </box>
  );
}

function Chat({
  messages,
  sending,
  input,
  inputKey,
  scroll,
  inputActive,
  onInput,
  onSubmit,
}: {
  messages: ChatMessage[];
  sending: boolean;
  input: string;
  inputKey: number;
  scroll: number;
  inputActive: boolean;
  onInput: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  const WINDOW = 12;
  const end = Math.max(0, messages.length - scroll);
  const start = Math.max(0, end - WINDOW);
  const recent = messages.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = messages.length - end;
  return (
    <box style={{ flexGrow: 1, flexDirection: "column", paddingTop: 1 }}>
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        {messages.length === 0 && (
          <text bg={PANEL} fg={FAINT}>Ask about Jerry — projects, wins, stack, links. Type /help for commands.</text>
        )}
        {hiddenAbove > 0 && <text bg={PANEL} fg={FAINT}>{`↑ ${hiddenAbove} earlier — PageUp`}</text>}
        {recent.map((m, i) => {
          const isErr = m.content.startsWith("OPENROUTER_API_KEY");
          return (
            <box key={start + i} style={{ flexDirection: "column", marginBottom: 1 }}>
              {m.role === "user" ? (
                <text bg={PANEL}>
                  <span fg={MUTED}>{"> "}</span>
                  <span fg={INK}>{m.content}</span>
                </text>
              ) : (
                m.content.split("\n").map((line, li) => (
                  <text key={li} bg={PANEL}>
                    <span fg={isErr ? ERR : ACCENT}>{li === 0 ? "⏺ " : "  "}</span>
                    <span fg={isErr ? ERR : INK}>{line}</span>
                  </text>
                ))
              )}
            </box>
          );
        })}
        {hiddenBelow > 0 && <text bg={PANEL} fg={FAINT}>{`↓ ${hiddenBelow} newer — PageDown`}</text>}
        {sending && <ThinkingDots />}
      </box>
      <Rule />
      <box style={{ flexDirection: "row", paddingLeft: 2, paddingRight: 2 }}>
        <text fg={ACCENT}>{"> "}</text>
        <input
          key={inputKey}
          focused={inputActive}
          placeholder="ask a question…   (/help)"
          value={input}
          onInput={onInput}
          style={{ flexGrow: 1 }}
          // opentui types onSubmit as an intersection over its own event type; guard at runtime.
          onSubmit={(value: unknown) => {
            if (typeof value === "string") onSubmit(value);
          }}
        />
      </box>
    </box>
  );
}
