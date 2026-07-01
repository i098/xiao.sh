import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core";
import { profile } from "@/lib/profile";
import { projects, type Project } from "@/lib/projects";
import { ask, type ChatMessage } from "@/lib/ai";
import { EXTERNAL_LINK_ARROW } from "@/lib/symbols";
import type { LinkedInSnapshot } from "@/lib/linkedin";
import type { VisitInfo } from "@/lib/visits";
import { capture } from "@/lib/analytics";
import { getSpotify, type SpotifyState } from "@/lib/spotify";
import { autoName, deleteSession, listSessions, loadSession, saveSession, type SavedSession } from "@/lib/sessions";
import { liveCount } from "@/lib/presence";
import { getGitHub, type GitHubPulse } from "@/lib/github";
import { recordQuestion } from "@/lib/questions";

// Editorial palette: green ACCENT reserved for links/active/live; neutral INK/MUTED/FAINT for hierarchy.
const ACCENT = "#43f08a";
const INK = "#e9ece9";
const MUTED = "#7c8a82";
const FAINT = "#2c3531";
const SEL_BG = "#15211b";
const ERR = "#fda4af";
// opaque strip behind text so the koi pond doesn't bleed through the spaces between words.
// matches the terminal bg (deep green) so the strips stay seamless.
const PANEL = "#030c0d";

const LIST_W = 30;

type Screen = "home" | "projects" | "about" | "chat";

const NAV: { key: string; screen: Screen }[] = [
  { key: "h", screen: "home" },
  { key: "p", screen: "projects" },
  { key: "a", screen: "about" },
  { key: "c", screen: "chat" },
];
const SCREENS: Screen[] = ["home", "projects", "about", "chat"];

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
  "  /home /projects /about /chat   (or press h p a c)",
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
// wrapMode none + explicit height: a text that exactly fills the terminal width
// measures as 2 wrapped rows (opentui edge case), overflowing tight column layouts
function Rule({ w }: { w?: number }) {
  const { width } = useTerminalDimensions();
  return <text fg={FAINT} wrapMode="none" style={{ height: 1 }}>{"-".repeat(Math.max(1, w ?? width))}</text>;
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

// shutdown log shown on quit before the connection closes
const SHUTDOWN_LINES = [
  "$ exit",
  "[ ok ] flush analytics",
  "[ ok ] stop ai-search daemon",
  "[ ok ] release koi pond",
  "[ ok ] unmount /home/jerry",
  "connection closed.",
  "goodbye — jerry xiao",
];

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
  if (line === "ready." || line.startsWith("welcome") || line.startsWith("goodbye"))
    return <text fg={ACCENT}>{line}</text>;
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
  const [quitting, setQuitting] = useState(false); // boot-down log before the connection closes
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
  const quit = useCallback(() => setQuitting(true), []);

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
  // narrow viewport (phones / small terminals): stack columns + compact footer
  const narrow = termW < 64;
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
      recordQuestion(content);
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

  if (quitting) {
    return <BootScreen key="bye" lines={SHUTDOWN_LINES} onDone={onExit} />;
  }
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
        // cap the queue so a fast cursor can't stockpile splash energy between wave ticks
        if (pondMoveN.current++ % 2 === 0 && pondSplash.current.length < 64) pondSplash.current.push({ x: e.x, y: e.y, amp: 2.2 });
      }}
      onMouseDown={(e: { x: number; y: number }) => {
        if (pondSplash.current.length < 64) pondSplash.current.push({ x: e.x, y: e.y, amp: 6 });
      }}
      onMouseOut={() => {
        pondMouse.current = null;
      }}
    >
      {/* smaller koi on a phone so they don't bleed through the sparse, narrow content */}
      <KoiPond width={termW} height={termH} scale={narrow ? 0.5 : 1} mouseRef={pondMouse} splashRef={pondSplash} />
      <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", flexDirection: "column", zIndex: 1 }}>
        <Header screen={screen} />
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          {screen === "home" && <Home visit={visit} narrow={narrow} />}
          {screen === "projects" && <Projects selected={selected} onSelect={setSelected} />}
          {screen === "about" && <About linkedIn={linkedIn} />}
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
        <Footer screen={screen} chatActive={chatActive} narrow={narrow} onNav={go} />
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

// one footer nav item — a tappable box (touch nav on mobile) that also shows the key hint
function NavTab({ item, active, onNav }: { item: { key: string; screen: Screen }; active: boolean; onNav: (s: Screen) => void }) {
  return (
    <box
      style={{ paddingRight: 2 }}
      onMouseDown={() => {
        if (!active) onNav(item.screen);
      }}
    >
      <text>
        <span fg={ACCENT}>{item.key}</span>
        <span fg={active ? INK : MUTED}>{` ${item.screen}`}</span>
      </text>
    </box>
  );
}

function Footer({
  screen,
  chatActive,
  narrow,
  onNav,
}: {
  screen: Screen;
  chatActive: boolean;
  narrow: boolean;
  onNav: (s: Screen) => void;
}) {
  const hint = chatActive ? "Enter send · Esc back" : screen === "projects" ? "↑↓ / j k move · q quit" : "q quit";
  return (
    <box style={{ flexDirection: "column", paddingBottom: 1 }}>
      <Rule />
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <box style={{ flexDirection: "row" }}>
          {NAV.map((n) => (
            <NavTab key={n.key} item={n} active={n.screen === screen} onNav={onNav} />
          ))}
        </box>
        {!narrow && <text fg={MUTED}>{hint}</text>}
      </box>
    </box>
  );
}

// The pond paints straight into the renderer's cell buffers (raw typed-array views over
// native memory — zero FFI, zero React reconciliation per frame). All colors are
// precomputed once as the 4×u16 RGBA quads the native buffer stores.
const u16 = (hex: string) => RGBA.fromHex(hex).buffer;

// water surface: amplitude bucket -> glyph codepoint; color by intensity AND sign
// (crest = bright cyan, trough = deep blue) for clear wave color contrast.
const WATER_CP = [0x20, 0xb7 /*·*/, 0x2d9 /*˙*/, 0x7e /*~*/, 0x2248 /*≈*/];
const WATER_CREST = [u16("#0e2329"), u16("#2f6b7a"), u16("#52a0b6"), u16("#86d6ec"), u16("#cdf2ff")];
const WATER_TROUGH = [u16("#0e2329"), u16("#1d3c55"), u16("#274f72"), u16("#2c5f8c"), u16("#356fa6")];
const POND_BG = u16(PANEL); // matches the terminal bg so the pond stays seamless

// koi/lily palette — pixel buffer stores palette indices (0 = transparent)
const C_WHITE = 1; // body base
const C_FIN = 2;
const C_ORANGE = 3;
const C_RED = 4;
const C_EYE = 5;
const C_SUMI = 6; // Sanke's small black markings — dark slate
const C_PAD = 7;
const C_PETAL = 8;
const C_FLOWER = 9;
const PAL_U16: Uint16Array[] = [
  new Uint16Array(4),
  u16("#eef2f5"),
  u16("#cdd6dc"),
  u16("#ff8a3d"),
  u16("#d94f28"),
  u16("#0c1016"),
  u16("#333c47"),
  u16("#3f6e3a"),
  u16("#f3a8c8"),
  u16("#f2d36b"),
];
// koi rendered as ascii glyphs (not solid blocks), shaded by body coverage
const CP_FULL = 0x23; // '#' both pixels covered
const CP_HALF = 0x2a; // '*'
const CP_EYE = 0x2022; // '•'
const N_COILS = 12;
const COIL_SP = 3.0; // px between body coils (shorter body = less snake-like)
const MAX_BEND = 0.22; // max bend per joint (rad) — keeps the body fish-stiff, not snake-curly

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// body width profile: slim koi (tapered head/tail), scaled per fish
function coilRadius(i: number, size = 1) {
  const t = i / (N_COILS - 1);
  return (1.0 + 3.7 * Math.sin(t * Math.PI) + (t < 0.16 ? 0.8 : 0)) * size;
}
// a blotch: which spine coil, palette color, size ratio of the body radius, sideways offset
type Blotch = { i: number; col: number; dr: number; off: number };
// one koi variety: body base color, fin color, and its overlaid blotches
type KoiVariety = { name: string; base: number; fin: number; blotches: Blotch[] };
const KOI_VARIETIES: KoiVariety[] = [
  // Kōhaku — white body, large red/orange markings
  {
    name: "kohaku",
    base: C_WHITE,
    fin: C_FIN,
    blotches: [
      { i: 3, col: C_RED, dr: 0.95, off: -0.2 },
      { i: 6, col: C_ORANGE, dr: 0.8, off: 0.3 },
      { i: 9, col: C_RED, dr: 0.7, off: -0.3 },
    ],
  },
  // Sanke — white base, red plus small black markings
  {
    name: "sanke",
    base: C_WHITE,
    fin: C_FIN,
    blotches: [
      { i: 3, col: C_RED, dr: 0.9, off: -0.15 },
      { i: 6, col: C_RED, dr: 0.7, off: 0.35 },
      { i: 5, col: C_SUMI, dr: 0.42, off: -0.55 },
      { i: 8, col: C_SUMI, dr: 0.36, off: 0.45 },
    ],
  },
];

// lily pads (fractions of pond w/h, radius px) — drawn above koi, below text.
// each has a wedge slice removed (notch center angle + half-width); one bears a flower.
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
  variety: KoiVariety;
  spine: { x: number; y: number }[];
};

// Wave-propagation hot loop. Plain JS: JSC's JIT vectorises this tight typed-array
// loop and there's no per-frame FFI marshalling (which added steady small GC hitches).
// Writes the next field into `prev` from `cur`'s neighbours; caller swaps.
// Anisotropic: horizontal coupling 4x vertical (terminal cells are ~2:1 tall) so a
// ripple renders as a circle on screen instead of a vertical ellipse.
function waveStep(cur: Float32Array, prev: Float32Array, w: number, h: number, damp: number): void {
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const i = row + x;
      prev[i] = (0.75 * cur[i] - prev[i] + 0.5 * (cur[i - 1] + cur[i + 1]) + 0.125 * (cur[i - w] + cur[i + w])) * damp;
    }
  }
}

// pixel-raster helpers over the koi half-block buffer (palette indices, 0 = transparent)
function diskPx(buf: Uint8Array, pw: number, ph: number, cx: number, cy: number, r: number, col: number): void {
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(ph - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(pw - 1, Math.ceil(cx + r));
  for (let yy = y0; yy <= y1; yy += 1)
    for (let xx = x0; xx <= x1; xx += 1) {
      const dx = xx - cx;
      const dy = yy - cy;
      if (dx * dx + dy * dy <= r2) buf[yy * pw + xx] = col;
    }
}
function triPx(
  buf: Uint8Array,
  pw: number,
  ph: number,
  ax2: number,
  ay2: number,
  bx2: number,
  by2: number,
  cx3: number,
  cy3: number,
  col: number,
): void {
  const minx = Math.max(0, Math.floor(Math.min(ax2, bx2, cx3)));
  const maxx = Math.min(pw - 1, Math.ceil(Math.max(ax2, bx2, cx3)));
  const miny = Math.max(0, Math.floor(Math.min(ay2, by2, cy3)));
  const maxy = Math.min(ph - 1, Math.ceil(Math.max(ay2, by2, cy3)));
  const den = (by2 - cy3) * (ax2 - cx3) + (cx3 - bx2) * (ay2 - cy3);
  if (Math.abs(den) < 1e-6) return;
  for (let yy = miny; yy <= maxy; yy += 1)
    for (let xx = minx; xx <= maxx; xx += 1) {
      const w1 = ((by2 - cy3) * (xx - cx3) + (cx3 - bx2) * (yy - cy3)) / den;
      const w2 = ((cy3 - ay2) * (xx - cx3) + (ax2 - cx3) * (yy - cy3)) / den;
      if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) buf[yy * pw + xx] = col;
    }
}
function setPx(buf: Uint8Array, pw: number, ph: number, x: number, y: number, col: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi >= 0 && yi >= 0 && xi < pw && yi < ph) buf[yi * pw + xi] = col;
}

// Full-screen koi pond behind all content; koi swim in from the edges, flee the cursor;
// cursor/koi leave wave-sim ripples. Mouse + splashes are fed in from the App root.
// Rendered as a `live` box that paints directly into the renderer's cell buffers each
// frame (renderAfter) — no per-frame React state/reconciliation, so cost is flat no
// matter how choppy the water or how much the koi overlap.
export function KoiPond({
  width,
  height,
  scale = 1,
  mouseRef,
  splashRef,
}: {
  width: number;
  height: number;
  scale?: number;
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
  // koi pixel scratch buffer reused every frame (allocated once per size)
  const pxRef = useRef<Uint8Array | null>(null);
  const waveAcc = useRef(0);

  if (!hCur.current || hCur.current.length !== W * H) {
    hCur.current = new Float32Array(W * H);
    hPrev.current = new Float32Array(W * H);
  }
  if (!pxRef.current || pxRef.current.length !== PW * PH) {
    pxRef.current = new Uint8Array(PW * PH);
  }

  const draw = useCallback(
    (buffer: OptimizedBuffer, deltaMs: number) => {
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
          { spd: 0.018, size: 1.0, cx: PW * 0.42, cy: PH * 0.5, ax: PW * 0.3, ay: PH * 0.26, ph: 0, variety: KOI_VARIETIES[0] },
          { spd: 0.023, size: 0.8, cx: PW * 0.6, cy: PH * 0.42, ax: PW * 0.24, ay: PH * 0.22, ph: 2.1, variety: KOI_VARIETIES[1] },
        ];
        koi.current = defs.map((d) => {
          const k: KoiState = { ...d, size: d.size * scale, s: d.ph, spine: [] };
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
      // koi kinematics run per frame; physics constants were tuned at a 33ms tick, so
      // `n` rescales the increments — 60fps doesn't double swim speed.
      const n = Math.min(deltaMs, 100) / 33;
      const ease = 1 - Math.pow(0.84, n); // 0.16 per 33ms tick
      const m = mouseRef.current;
      for (const k of koi.current) {
        k.s += k.spd * n;
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
        const ex = (target.x - head.x) * ease;
        const ey = (target.y - head.y) * ease;
        const es = Math.hypot(ex, ey) || 1;
        const maxStep = 1.1 * n;
        const stepScale = es > maxStep ? maxStep / es : 1;
        head.x += ex * stepScale;
        head.y += ey * stepScale;
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
      // water height-field: wave propagation + damping (double-buffered) on a fixed
      // 30Hz clock — the stencil's wave speed and damping are per-step, so stepping
      // per frame would tie ripple physics to fps. 0.93 damping → tighter ripples.
      const splashAt = (x: number, y: number, amp: number) => {
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return;
        hCur.current![yi * W + xi] -= amp;
      };
      waveAcc.current += Math.min(deltaMs, 100);
      let steps = 0;
      while (waveAcc.current >= 33 && steps < 4) {
        waveAcc.current -= 33;
        steps += 1;
        const cur = hCur.current!;
        const prev = hPrev.current!;
        waveStep(cur, prev, W, H, 0.93);
        hCur.current = prev;
        hPrev.current = cur;
        // queued cursor splashes (fed from the App root mouse handler)
        const q = splashRef.current;
        for (let i = 0; i < q.length; i += 1) splashAt(q[i].x, q[i].y, q[i].amp);
        q.length = 0;
        // gentle koi wakes
        for (const k of koi.current) {
          splashAt(k.spine[0].x, k.spine[0].y / 2, 0.18);
          splashAt(k.spine[N_COILS - 1].x, k.spine[N_COILS - 1].y / 2, 0.12);
        }
      }
      if (waveAcc.current >= 33) waveAcc.current = 0; // stalled — drop the backlog

      // koi: rasterize the body chain into the pixel buffer (palette indices)
      const buf = pxRef.current!;
      buf.fill(0);
      const disk = (cx2: number, cy2: number, r: number, col: number) => diskPx(buf, PW, PH, cx2, cy2, r, col);
      const triFill = (ax2: number, ay2: number, bx2: number, by2: number, cx3: number, cy3: number, col: number) =>
        triPx(buf, PW, PH, ax2, ay2, bx2, by2, cx3, cy3, col);
      const setpx = (x: number, y: number, col: number) => setPx(buf, PW, PH, x, y, col);

      for (const k of koi.current) {
        const spine = k.spine;
        if (!spine.length) continue;
        const size = k.size;
        const v = k.variety;

        // body: variety base color + its overlaid blotches (no full-width stripes)
        for (let i = N_COILS - 1; i >= 0; i -= 1) disk(spine[i].x, spine[i].y, coilRadius(i, size), v.base);
        for (const b of v.blotches) {
          const c = spine[b.i];
          const cp = spine[b.i - 1];
          const dl = Math.hypot(c.x - cp.x, c.y - cp.y) || 1;
          const ppx = -(c.y - cp.y) / dl;
          const ppy = (c.x - cp.x) / dl;
          const r = coilRadius(b.i, size);
          disk(c.x + ppx * b.off * r, c.y + ppy * b.off * r, r * b.dr, b.col);
        }

        // tail: a short forked caudal fin, then long thin whiskers trailing from each lobe
        // tip. The whiskers run ~half the body length and undulate in sync with the swim
        // (same wavyness as the fish) — only the whisker ends are long, not the whole fin.
        const t0 = spine[N_COILS - 1];
        const t1 = spine[N_COILS - 2];
        const tl = Math.hypot(t0.x - t1.x, t0.y - t1.y) || 1;
        const ux = (t0.x - t1.x) / tl; // backward, away from the head
        const uy = (t0.y - t1.y) / tl;
        const px = -uy; // lateral (perpendicular to the body axis)
        const py = ux;
        const bx0 = t0.x + ux * 1.6 * size;
        const by0 = t0.y + uy * 1.6 * size;
        const swim = k.s * 4; // shared swim phase → tail + whiskers share the body's wavyness
        const sway = Math.sin(swim) * 3.0 * size;
        const finLenT = 5 * size; // the solid fork stays short
        const whiskLen = N_COILS * COIL_SP * 0.35 * size; // whiskers ~a third of the fish length
        for (const lobe of [1, -1]) {
          // barely-forked: both lobes hug the centerline and ride the same sway, so the
          // pair reads as one flowing caudal fin (real koi) instead of two split streamers
          const spread = lobe * 0.9 * size + sway;
          const apx = bx0 + ux * finLenT + px * spread;
          const apy = by0 + uy * finLenT + py * spread;
          triFill(bx0 + px * 0.7, by0 + py * 0.7, bx0 - px * 0.7, by0 - py * 0.7, apx, apy, v.base);
          // wavy whisker from the lobe tip: same amplitude as the tail sway with a gentle
          // phase lag along the length, so fork → tip reads as ONE traveling wave (the old
          // 3.5-rad lag put the tip near-antiphase — whiskers looked detached from the tail)
          for (let s2 = 1; s2 <= 12; s2 += 1) {
            const f = s2 / 12;
            const along = f * whiskLen;
            const wave = Math.sin(swim - f * 1.8) * 3.0 * size * f; // grows root→tip, trails the sway
            const wx = apx + ux * along + px * wave;
            const wy = apy + uy * along + py * wave;
            disk(wx, wy, Math.max(0.4, (1 - f) * 1.0 * size + 0.3), v.fin);
          }
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
          triFill(rfx, rfy, rbx, rby, tipx, tipy, v.fin);
        }

        // eyes near the head
        const h0 = spine[0];
        const h1 = spine[1];
        const hl = Math.hypot(h0.x - h1.x, h0.y - h1.y) || 1;
        const epx = -(h0.y - h1.y) / hl;
        const epy = (h0.x - h1.x) / hl;
        const eo = 1.7 * size;
        setpx(h0.x + epx * eo, h0.y + epy * eo, C_EYE);
        setpx(h0.x - epx * eo, h0.y - epy * eo, C_EYE);
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
            buf[yy * PW + xx] = C_PAD;
          }
        // flower on the one designated pad: 5 petals + center
        if (p.flower) {
          for (let k = 0; k < 5; k += 1) {
            const a = (k * 2 * Math.PI) / 5 - 1.2;
            disk(cxp + Math.cos(a) * 2.4, cyp + Math.sin(a) * 2.4, 1.4, C_PETAL);
          }
          disk(cxp, cyp, 1.3, C_FLOWER);
        }
      });

      // composite water + koi straight into the renderer's raw cell buffers: one glyph
      // per cell, koi shaded by coverage of its two half-block pixels
      const raw = buffer.buffers;
      const bw = buffer.width;
      const cw = Math.min(W, bw);
      const chRows = Math.min(H, buffer.height);
      const chB = raw.char;
      const fgB = raw.fg;
      const bgB = raw.bg;
      const atB = raw.attributes;
      const field = hCur.current!;
      for (let y = 0; y < chRows; y += 1) {
        const rowOff = y * bw;
        const top0 = 2 * y * PW;
        const bot0 = top0 + PW;
        for (let x = 0; x < cw; x += 1) {
          const top = buf[top0 + x];
          const bot = buf[bot0 + x];
          let cp: number;
          let col: Uint16Array;
          if (top || bot) {
            const idx = top || bot;
            cp = idx === C_EYE ? CP_EYE : top && bot ? CP_FULL : CP_HALF;
            col = PAL_U16[idx];
          } else {
            const v = field[y * W + x];
            const a = v < 0 ? -v : v;
            const bkt = a < 0.07 ? 0 : a > 0.6 ? 4 : a > 0.32 ? 3 : a > 0.16 ? 2 : 1;
            cp = WATER_CP[bkt];
            col = v > 0 ? WATER_CREST[bkt] : WATER_TROUGH[bkt];
          }
          const ci = rowOff + x;
          const i4 = ci * 4;
          chB[ci] = cp;
          fgB[i4] = col[0];
          fgB[i4 + 1] = col[1];
          fgB[i4 + 2] = col[2];
          fgB[i4 + 3] = col[3];
          bgB[i4] = POND_BG[0];
          bgB[i4 + 1] = POND_BG[1];
          bgB[i4 + 2] = POND_BG[2];
          bgB[i4 + 3] = POND_BG[3];
          atB[ci] = 0;
        }
      }
    },
    [W, H, PW, PH, scale, mouseRef, splashRef],
  );

  // `live` keeps the renderer's frame loop running so renderAfter fires every frame
  return <box style={{ position: "absolute", left: 0, top: 0, width: W, height: H, zIndex: 0 }} live renderAfter={draw} />;
}

const BARS = "▁▂▃▄▅▆▇█";

function commas(n: number) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function compactNum(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}
function timeAgo(iso: string) {
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
const SEP = "  ·  ";
function Stat({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
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

// total visitors + live online (polled) on one row
function VisitorHead({ total }: { total: number }) {
  const [n, setN] = useState(() => liveCount());
  useEffect(() => {
    const id = setInterval(() => setN(liveCount()), 2000);
    return () => clearInterval(id);
  }, []);
  return (
    <text bg={PANEL}>
      <strong fg={ACCENT}>{`#${commas(total)}`}</strong>
      <span fg={MUTED}>{" total"}</span>
      <span fg={FAINT}>{SEP}</span>
      <span fg={ACCENT}>{"◉ "}</span>
      <span fg={INK}>{n}</span>
      <span fg={MUTED}>{" online"}</span>
    </text>
  );
}

// GitHub pulse: followers · repos · stars + last push
function GitHubPulse() {
  const [g, setG] = useState<GitHubPulse | null>(null);
  useEffect(() => {
    let alive = true;
    getGitHub()
      .then((d) => {
        if (alive) setG(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Stat label="GITHUB" meta={g?.lastPushAt ? `pushed ${timeAgo(g.lastPushAt)}` : undefined}>
      {g ? (
        <text bg={PANEL}>
          <span fg={INK}>{compactNum(g.followers)}</span>
          <span fg={MUTED}>{" followers"}</span>
          <span fg={FAINT}>{SEP}</span>
          <span fg={INK}>{g.repos}</span>
          <span fg={MUTED}>{" repos"}</span>
          <span fg={FAINT}>{SEP}</span>
          <span fg={ACCENT}>{`${compactNum(g.stars)}★`}</span>
        </text>
      ) : (
        <text bg={PANEL} fg={FAINT}>
          …
        </text>
      )}
    </Stat>
  );
}

// daily-visits bar chart — solid green bars with each day's count carved into the bar
// as a vertical (rotated) dark number in the center column.
const CHART_ROWS = 7;
const BAR_W = 3; // preferred cells per day column — center column holds the rotated count
const CARVE = "#030c0d"; // page bg → dark digit reads as a cutout in the green bar
type ChartCell = { ch: string; fg: string; bg?: string };
function VisitorChart({ data }: { data: number[] }) {
  // shrink bar width to fit the terminal so the chart never overflows a narrow phone
  const { width } = useTerminalDimensions();
  const bw = Math.max(1, Math.min(BAR_W, Math.floor((width - 4) / data.length)));
  const max = Math.max(1, ...data);
  const W = data.length * bw;
  const grid: ChartCell[][] = Array.from({ length: CHART_ROWS }, () =>
    Array.from({ length: W }, () => ({ ch: " ", fg: MUTED })),
  );
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    const barRows = v > 0 ? Math.max(1, Math.round((v / max) * CHART_ROWS)) : 0;
    // solid bar (green bg) from the bottom up
    for (let d = 0; d < barRows; d += 1) {
      const rowIdx = CHART_ROWS - 1 - d;
      for (let k = 0; k < bw; k += 1) grid[rowIdx][i * bw + k] = { ch: " ", fg: ACCENT, bg: ACCENT };
    }
    // count rotated 90° (one digit per row), carved dark into the bar, anchored at the bottom
    const digits = v > 0 ? String(v) : "";
    const cx = i * bw + Math.floor(bw / 2);
    for (let j = 0; j < digits.length; j += 1) {
      const rowIdx = CHART_ROWS - digits.length + j;
      if (rowIdx >= CHART_ROWS - barRows && rowIdx < CHART_ROWS) grid[rowIdx][cx] = { ch: digits[j], fg: CARVE, bg: ACCENT };
    }
  }
  const rowsOut = grid.map((cells, rowIdx) => {
    const spans: { fg: string; bg?: string; text: string }[] = [];
    for (const cell of cells) {
      const last = spans[spans.length - 1];
      if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.ch;
      else spans.push({ fg: cell.fg, bg: cell.bg, text: cell.ch });
    }
    return (
      <text key={rowIdx}>
        {spans.map((s, k) => (
          <span key={k} fg={s.fg} bg={s.bg}>
            {s.text}
          </span>
        ))}
      </text>
    );
  });
  const span = "14 days ago" + " ".repeat(Math.max(1, W - 16)) + "today";
  return (
    <box style={{ flexDirection: "column" }}>
      {rowsOut}
      <text fg={FAINT}>{"─".repeat(W)}</text>
      <text fg={FAINT}>{span}</text>
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
  const playing = state.isPlaying && state.current ? state.current : null;
  // 4 songs total: playing → current + 3 previous; idle → 4 most-recent
  const previous = state.recent
    .filter((e) => !playing || e.track.name !== playing.name)
    .slice(0, playing ? 3 : 4);
  if (!playing && previous.length === 0) {
    return (
      <Stat label="RECENTLY PLAYED">
        <text bg={PANEL} fg={FAINT}>
          nothing recently
        </text>
      </Stat>
    );
  }
  const meta = !playing && previous[0]?.playedAt ? timeAgo(previous[0].playedAt) : undefined;
  return (
    <Stat label={playing ? "NOW PLAYING" : "RECENTLY PLAYED"} meta={meta}>
      {playing ? (
        <box style={{ flexDirection: "column" }}>
          <text bg={PANEL}>
            <span fg={ACCENT}>{"♫ "}</span>
            {playing.songUrl ? (
              <a href={playing.songUrl} fg={INK} attributes={TextAttributes.UNDERLINE}>
                {truncate(playing.name, 34)}
              </a>
            ) : (
              <span fg={INK}>{truncate(playing.name, 34)}</span>
            )}
            <span fg={MUTED}>{playing.artists.length ? `  —  ${truncate(playing.artists.join(", "), 22)}` : ""}</span>
          </text>
          {state.progressMs != null && state.durationMs ? (
            <ProgressBar progress={state.progressMs} duration={state.durationMs} />
          ) : (
            <Equalizer />
          )}
        </box>
      ) : null}
      {previous.map((e, i) => (
        <text key={i} bg={PANEL}>
          <span fg={FAINT}>{"· "}</span>
          {e.track.songUrl ? (
            <a href={e.track.songUrl} fg={!playing && i === 0 ? INK : MUTED} attributes={TextAttributes.UNDERLINE}>
              {truncate(e.track.name, 32)}
            </a>
          ) : (
            <span fg={!playing && i === 0 ? INK : MUTED}>{truncate(e.track.name, 32)}</span>
          )}
          <span fg={MUTED}>{e.track.artists.length ? ` — ${truncate(e.track.artists.join(", "), 18)}` : ""}</span>
        </text>
      ))}
    </Stat>
  );
}

function Home({ visit, narrow }: { visit: VisitInfo; narrow: boolean }) {
  return (
    <box style={{ flexDirection: narrow ? "column" : "row", alignItems: "flex-start", paddingLeft: 2, paddingTop: 1 }}>
      <box style={{ flexDirection: "column", width: narrow ? undefined : 50 }}>
        <Stat label="VISITORS">
          <VisitorHead total={visit.count} />
          <box style={{ height: 1 }} />
          <VisitorChart data={visit.daily} />
        </Stat>
      </box>
      <box style={{ flexDirection: "column", paddingLeft: narrow ? 0 : 4 }}>
        <GitHubPulse />
        <NowPlaying />
      </box>
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

function ProjectItem({ title, active, index, onSelect }: { title: string; active: boolean; index: number; onSelect: (i: number) => void }) {
  const label = truncate(title, LIST_W - 4);
  return (
    <box onMouseDown={() => onSelect(index)}>
      <text bg={active ? SEL_BG : undefined}>
        <span fg={active ? ACCENT : FAINT}>{active ? " ▐▌ " : "    "}</span>
        <span fg={active ? INK : MUTED}>{label.padEnd(LIST_W - 4)}</span>
      </text>
    </box>
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

function ProjectDetail({ p, detailW }: { p: Project; detailW: number }) {
  const top3 = p.highlight?.toLowerCase().includes("top 3");
  return (
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
  );
}

function Projects({ selected, onSelect }: { selected: number; onSelect: (i: number) => void }) {
  const p = projects[selected];
  const { width, height } = useTerminalDimensions();
  const narrow = width < 64;
  const bodyRows = Math.max(4, height - 5);
  const detailW = Math.max(20, width - (narrow ? 4 : LIST_W + 6));

  // narrow: stack the (tappable) list above the selected project's detail
  if (narrow) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
        <text fg={FAINT}>{"  PROJECTS"}</text>
        {projects.map((project, i) => (
          <ProjectItem key={project.title} title={project.title} active={i === selected} index={i} onSelect={onSelect} />
        ))}
        <ProjectDetail p={p} detailW={detailW} />
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "row", flexGrow: 1 }}>
      <box style={{ width: LIST_W, flexDirection: "column", paddingTop: 1 }}>
        <text fg={FAINT}>{"  PROJECTS"}</text>
        <box style={{ height: 1 }} />
        {projects.map((project, i) => (
          <ProjectItem key={project.title} title={project.title} active={i === selected} index={i} onSelect={onSelect} />
        ))}
      </box>

      <VRule rows={bodyRows} />

      <ProjectDetail p={p} detailW={detailW} />
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
    <box style={{ flexDirection: "column", paddingLeft: 2, paddingTop: 1 }}>
      <text bg={PANEL}>
        <strong fg={INK}>{lp.name}</strong>
        {typeof lp.followerCount === "number" ? <span fg={MUTED}>{`   ${lp.followerCount} followers`}</span> : null}
      </text>
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
      {MY_STACK.map((group, gi) => (
        <text key={gi} bg={PANEL}>
          {group.map((t, ti) => {
            const { tag, col } = techTag(t);
            return (
              <span key={ti} fg={col}>{`● ${tag}  `}</span>
            );
          })}
        </text>
      ))}
    </box>
  );
}

// word-wrap to width, preserving explicit newlines; hard-breaks words longer than w
function wrapText(s: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    let line = "";
    for (const word of raw.split(" ")) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    while (line.length > w) {
      out.push(line.slice(0, w));
      line = line.slice(w);
    }
    out.push(line);
  }
  return out;
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
  // Word-wrap + row windowing done in plain JS: every rendered line is a fixed
  // height-1 <text>, so the layout can never overflow and push the input off-screen
  // (opentui text measurement has exact-fit quirks that broke flex/scrollbox layouts).
  const { width: termW, height: termH } = useTerminalDimensions();
  const bodyW = Math.max(10, termW - 6); // 2 pad each side + 2-char prefix
  const rows: { prefix: string; body: string; pc: string; bc: string }[] = [];
  for (const m of messages) {
    const isErr = m.content.startsWith("OPENROUTER_API_KEY");
    const wrapped = wrapText(m.content, bodyW);
    wrapped.forEach((line, li) => {
      if (m.role === "user") rows.push({ prefix: li === 0 ? "> " : "  ", body: line, pc: MUTED, bc: INK });
      else rows.push({ prefix: li === 0 ? "⏺ " : "  ", body: line, pc: isErr ? ERR : ACCENT, bc: isErr ? ERR : INK });
    });
    rows.push({ prefix: "", body: "", pc: MUTED, bc: INK }); // blank line between messages
  }
  if (rows.length > 0) rows.pop();
  // rows available: header 3 + chat paddingTop 1 + rule 1 + input 1 + footer 3 = 9
  const avail = Math.max(3, termH - 9 - (sending ? 1 : 0));
  const off = Math.min(scroll, Math.max(0, rows.length - avail));
  const visible = rows.slice(Math.max(0, rows.length - avail - off), rows.length - off);
  return (
    <box style={{ flexGrow: 1, flexDirection: "column", paddingTop: 1 }}>
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2 }}>
        {messages.length === 0 && (
          <text bg={PANEL} fg={FAINT} wrapMode="none" style={{ height: 1 }}>
            Ask about Jerry — projects, wins, stack, links. Type /help for commands.
          </text>
        )}
        {visible.map((r, i) => (
          <text key={i} bg={PANEL} wrapMode="none" style={{ height: 1 }}>
            <span fg={r.pc}>{r.prefix}</span>
            <span fg={r.bc}>{r.body}</span>
          </text>
        ))}
        {sending && <ThinkingDots />}
      </box>
      <Rule />
      <box style={{ flexDirection: "row", paddingLeft: 2, paddingRight: 2 }}>
        {/* trailing-space text also measures 2 wrapped rows (same quirk) — pin it */}
        <text fg={ACCENT} wrapMode="none" style={{ height: 1 }}>{"> "}</text>
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
