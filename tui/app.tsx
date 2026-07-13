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
import { getPreviewUrl } from "@/lib/preview";
import { autoName, deleteSession, listSessions, loadSession, saveSession, type SavedSession } from "@/lib/sessions";
import { liveCount } from "@/lib/presence";
import { getGitHub, type GitHubPulse } from "@/lib/github";
import { recordQuestion } from "@/lib/questions";
import {
  PondSim,
  PAL_HEX,
  POND_BG_HEX,
  WATER_CP,
  WATER_CREST_HEX,
  WATER_TROUGH_HEX,
  CP_FULL,
  CP_HALF,
  CP_EYE,
  C_EYE,
  waterBucket,
  MOVE_AMP,
  DOWN_AMP,
  SPLASH_CAP,
} from "@/lib/pond";
import { ACCENT, BARS, ERR, FAINT, INK, MUTED, PANEL, SEL_BG, SEP, Stat, commas, compactNum, timeAgo, truncate } from "./ui";
import { NowPlaying, VolumeBar, type VolumeChannel } from "./music";

const LIST_W = 30;
const MAX_CHAT_INPUT_CHARS = 2_000;
const MAX_CHAT_MESSAGES = 50;

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
const PUBLIC_SSH_HELP_TEXT = [
  "COMMANDS",
  "  /help              show this",
  "  /clear             wipe history",
  "  /exit              back to home",
  "NAVIGATE",
  "  /home /projects /about /chat   (or press h p a c)",
  "SCROLL",
  "  PageUp / PageDown   ·   ↑ / ↓ when the input is empty",
  "",
  "Saved chats are disabled on public SSH sessions.",
].join("\n");

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
  return <text bg={PANEL} fg={FAINT} wrapMode="none" style={{ height: 1 }}>{"-".repeat(Math.max(1, w ?? width))}</text>;
}
// one multi-line text node (not one per row) with pinned size — cheap and layout-stable
function VRule({ rows }: { rows: number }) {
  const n = Math.max(1, rows);
  return (
    <text bg={PANEL} fg={FAINT} wrapMode="none" style={{ width: 1, height: n }}>
      {Array.from({ length: n }, () => "╎").join("\n")}
    </text>
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
    <text bg={bg ?? PANEL}>
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
    <text bg={PANEL}>
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
  "[ ok ] index projects (15)",
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
      <text bg={PANEL}>
        <span fg={ACCENT}>[ ok ]</span>
        <span fg={MUTED}>{line.slice(6)}</span>
      </text>
    );
  }
  if (line.startsWith("$")) {
    return (
      <text bg={PANEL}>
        <span fg={ACCENT}>$</span>
        <span fg={INK}>{line.slice(1)}</span>
      </text>
    );
  }
  if (line === "ready." || line.startsWith("welcome") || line.startsWith("goodbye"))
    return <text bg={PANEL} fg={ACCENT}>{line}</text>;
  return <text bg={PANEL} fg={MUTED}>{line}</text>;
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
      <text bg={PANEL}>
        <span fg={ACCENT}>{blink ? "▋" : " "}</span>
      </text>
      <box style={{ flexGrow: 1 }} />
      <text bg={PANEL}>
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
  volume,
  pond = true,
  allowSavedSessions = true,
}: {
  linkedIn: LinkedInSnapshot;
  visit: VisitInfo;
  distinctId: string;
  onExit: () => void;
  volume?: VolumeChannel;
  // web sessions render the pond client-side on a canvas (web/pond.ts); ssh/local keep it here
  pond?: boolean;
  // Public SSH has no visitor identity, so persisted transcripts would be shared globally.
  allowSavedSessions?: boolean;
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
    const bounded = v.slice(0, MAX_CHAT_INPUT_CHARS);
    inputRef.current = bounded;
    setInput(bounded);
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
        } else if (!allowSavedSessions && ["save", "resume", "delete", "del", "rm"].includes(cmd)) {
          pushAssistant("saved chats are disabled on public SSH sessions.");
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
          pushAssistant(allowSavedSessions ? HELP_TEXT : PUBLIC_SSH_HELP_TEXT);
        } else {
          pushAssistant(`unknown command: /${cmd} — try /help`);
        }
        return;
      }
      recordQuestion(content);
      const next = [...messagesRef.current, { role: "user" as const, content }].slice(-MAX_CHAT_MESSAGES);
      messagesRef.current = next;
      setMessages(next);
      setScroll(0);
      resetInput();
      setSending(true);
      const result = await ask(next);
      const reply: ChatMessage = { role: "assistant", content: result.answer ?? result.error ?? "No response." };
      const withReply = [...messagesRef.current, reply].slice(-MAX_CHAT_MESSAGES);
      messagesRef.current = withReply;
      setMessages(withReply);
      setScroll(0);
      setSending(false);
    },
    [allowSavedSessions, sending, resetInput, go, pushAssistant, loadInto],
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
    // web only: chat input can be blurred by clicking away — keys then act as plain
    // hotkeys (instant nav), not typing. The TUI never blurs, so inputFocused is absent.
    if (chatActive && ((key as { inputFocused?: boolean }).inputFocused ?? true)) {
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
    // home ↑/↓ belong to the volume bar, which handles them itself (every surface)
    // ←/→ cycle screens — except where the arrows already mean something: chat keeps them
    // for the input caret (handled above), home's music browser owns them on every surface
    if (screen !== "home" && (key.name === "left" || key.name === "right")) {
      const i = SCREENS.indexOf(screen);
      go(SCREENS[(i + (key.name === "right" ? 1 : -1) + SCREENS.length) % SCREENS.length]);
      return;
    }
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
  // NOTE: the transition BootScreen is an opaque OVERLAY, not an early return — unmounting
  // and remounting the main tree makes opentui mis-measure remounted text rows (the header
  // row collapses to zero height and every screen shifts up one row until a resize).

  return (
    <box
      style={{ width: "100%", height: "100%" }}
      onMouseMove={(e: { x: number; y: number }) => {
        pondMouse.current = { x: e.x, y: e.y };
        // cap the queue so a fast cursor can't stockpile splash energy between wave ticks
        if (pondMoveN.current++ % 2 === 0 && pondSplash.current.length < SPLASH_CAP) pondSplash.current.push({ x: e.x, y: e.y, amp: MOVE_AMP });
      }}
      onMouseDown={(e: { x: number; y: number }) => {
        if (pondSplash.current.length < SPLASH_CAP) pondSplash.current.push({ x: e.x, y: e.y, amp: DOWN_AMP });
      }}
      onMouseOut={() => {
        pondMouse.current = null;
      }}
    >
      {/* smaller koi on a phone so they don't bleed through the sparse, narrow content */}
      {/* ponytail: when pond=false the root mouse handlers above still fill these refs; harmless, capped at 64 */}
      {pond && <KoiPond width={termW} height={termH} scale={narrow ? 0.5 : 1} mouseRef={pondMouse} splashRef={pondSplash} />}
      <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", flexDirection: "column", zIndex: 1 }}>
        <Header screen={screen} />
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          {screen === "home" && <Home visit={visit} narrow={narrow} volume={volume} />}
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
      {transition && (
        <box style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 50, backgroundColor: POND_BG_HEX }}>
          <BootScreen
            key={transition}
            lines={bootLinesFor(transition)}
            onDone={() => {
              setScreen(transition);
              setTransition(null);
            }}
          />
        </box>
      )}
    </box>
  );
}

function Header({ screen }: { screen: Screen }) {
  return (
    // flexShrink 0: if a screen's body ever overflows again, crush the body, never the header
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
        <text bg={PANEL}>
          <strong fg={INK}>xiao.sh</strong>
        </text>
        <text bg={PANEL}>
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
      <text bg={PANEL}>
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
  const hint = chatActive
    ? "Enter send · Esc back"
    : screen === "projects"
      ? "↑↓ / j k move · ← → nav · q quit"
      : screen === "home"
        ? "← → tracks · ↑↓ vol · q quit"
        : "← → nav · q quit";
  return (
    <box style={{ flexDirection: "column", paddingBottom: 1 }}>
      <Rule />
      <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 2, paddingRight: 2 }}>
        <box style={{ flexDirection: "row" }}>
          {NAV.map((n) => (
            <NavTab key={n.key} item={n} active={n.screen === screen} onNav={onNav} />
          ))}
        </box>
        {!narrow && <text bg={PANEL} fg={MUTED}>{hint}</text>}
      </box>
    </box>
  );
}

// The pond simulation lives in @/lib/pond (shared with the browser canvas renderer in
// web/pond.ts). Server-side it paints straight into the renderer's cell buffers (raw
// typed-array views over native memory — zero FFI, zero React reconciliation per frame).
// All colors are precomputed once as the 4×u16 RGBA quads the native buffer stores.
const u16 = (hex: string) => RGBA.fromHex(hex).buffer;
const WATER_CREST = WATER_CREST_HEX.map(u16);
const WATER_TROUGH = WATER_TROUGH_HEX.map(u16);
const POND_BG = u16(POND_BG_HEX); // matches the terminal bg so the pond stays seamless
const PAL_U16: Uint16Array[] = [new Uint16Array(4), ...PAL_HEX.slice(1).map(u16)];

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
  // shared sim (same code drives the browser canvas); recreated on resize — koi
  // re-enter from the edges, which reads as the intentional swim-in intro
  const simRef = useRef<PondSim | null>(null);
  if (!simRef.current || simRef.current.W !== W || simRef.current.H !== H || simRef.current.scale !== scale) {
    simRef.current = new PondSim(W, H, scale);
  }

  const draw = useCallback(
    (buffer: OptimizedBuffer, deltaMs: number) => {
      const sim = simRef.current!;
      // feed inputs from the App-root refs, then advance the shared simulation
      sim.mouse = mouseRef.current;
      const q = splashRef.current;
      for (let i = 0; i < q.length; i += 1) sim.splash(q[i].x, q[i].y, q[i].amp);
      q.length = 0;
      sim.step(deltaMs);

      // composite water + koi straight into the renderer's raw cell buffers: one glyph
      // per cell, koi shaded by coverage of its two half-block pixels
      const buf = sim.px;
      const field = sim.field;
      const PW = sim.PW;
      const raw = buffer.buffers;
      const bw = buffer.width;
      const cw = Math.min(W, bw);
      const chRows = Math.min(H, buffer.height);
      const chB = raw.char;
      const fgB = raw.fg;
      const bgB = raw.bg;
      const atB = raw.attributes;
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
            const bkt = waterBucket(v < 0 ? -v : v);
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
    [W, H, mouseRef, splashRef],
  );

  // `live` keeps the renderer's frame loop running so renderAfter fires every frame
  return <box style={{ position: "absolute", left: 0, top: 0, width: W, height: H, zIndex: 0 }} live renderAfter={draw} />;
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

// the GITHUB stats row as plain text — its width anchors the music controls' alignment
// (the » lands on the ★ column)
// wide separator: the stats row spans the whole music-widget box (its width feeds
// controlsWidth), so « ▶ » and the ★ column frame the track list underneath
const GH_SEP = "    ·    ";
function ghStatsWidth(g: GitHubPulse): number {
  return `${compactNum(g.commits)} commits${GH_SEP}${compactNum(g.contributions)} contributions${GH_SEP}${compactNum(g.stars)}★`.length;
}

// GitHub pulse: followers · repos · stars + last push
function GitHubPulse({ g }: { g: GitHubPulse | null }) {
  return (
    <Stat label="GITHUB" meta={g?.lastPushAt ? `pushed ${timeAgo(g.lastPushAt)}` : undefined}>
      {g ? (
        <text bg={PANEL}>
          <span fg={INK}>{compactNum(g.commits)}</span>
          <span fg={MUTED}>{" commits"}</span>
          <span fg={FAINT}>{GH_SEP}</span>
          <span fg={INK}>{compactNum(g.contributions)}</span>
          <span fg={MUTED}>{" contributions"}</span>
          <span fg={FAINT}>{GH_SEP}</span>
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
      <text key={rowIdx} bg={PANEL}>
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
      <text bg={PANEL} fg={FAINT}>{"─".repeat(W)}</text>
      <text bg={PANEL} fg={FAINT}>{span}</text>
    </box>
  );
}

function Home({ visit, narrow, volume }: { visit: VisitInfo; narrow: boolean; volume?: VolumeChannel }) {
  // github data lives here so the music controls can align to the stats row's ★ column
  const [gh, setGh] = useState<GitHubPulse | null>(null);
  useEffect(() => {
    let alive = true;
    getGitHub()
      .then((d) => {
        if (alive) setGh(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // stretch row: headers align at the top; the left column pins its chart to the row's
  // bottom edge so the chart baseline meets the bottom of the right block
  return (
    <box style={{ flexDirection: narrow ? "column" : "row", alignItems: narrow ? "flex-start" : "stretch", paddingLeft: 2, paddingTop: 1 }}>
      {/* 43 = 14-day chart (42) + 1; anything wider is dead space before the volume bar */}
      <box style={{ flexDirection: "column", width: narrow ? undefined : 43 }}>
        <text bg={PANEL} fg={MUTED}>VISITORS</text>
        <VisitorHead total={visit.count} />
        {narrow ? <box style={{ height: 1 }} /> : <box style={{ flexGrow: 1, minHeight: 1 }} />}
        {/* marginBottom mirrors Stat's, so the chart baseline == the right block's bottom */}
        <box style={{ flexDirection: "column", marginBottom: 1 }}>
          <VisitorChart data={visit.daily} />
        </box>
      </box>
      {/* the bar hugs the visitors chart tighter than the plain column gap (4) */}
      <box style={{ flexDirection: "row", alignItems: "flex-start", paddingLeft: narrow ? 0 : 1 }}>
        {/* vertical volume runs down the left edge, top-aligned with the GITHUB header;
            ssh gets it too — adjustable, labelled X since no audio can reach the client */}
        {!narrow ? (
          <box style={{ flexDirection: "column", paddingRight: 2 }}>
            <VolumeBar channel={volume} />
          </box>
        ) : null}
        <box style={{ flexDirection: "column" }}>
          <GitHubPulse g={gh} />
          <NowPlaying volume={volume} controlsWidth={gh ? ghStatsWidth(gh) : undefined} />
        </box>
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
        backgroundColor: POND_BG_HEX,
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
      <text bg={active ? SEL_BG : PANEL}>
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
      <text bg={PANEL} fg={FAINT}>LINKS</text>
      <LinkLine label="GitHub" href={p.githubUrl} text={p.githubUrl} />
      {p.eventUrl && <LinkLine label="Event" href={p.eventUrl} text={p.eventUrl.split("?")[0]} />}
    </box>
  );
}

function ProjectDetail({ p, detailW }: { p: Project; detailW: number }) {
  const top3 = p.highlight?.toLowerCase().includes("top 3");
  return (
    <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}>
      {p.highlight && <text bg={PANEL} fg={ACCENT}>{(top3 ? "★ " : "") + p.highlight.toUpperCase()}</text>}
      <text bg={PANEL}>
        <strong fg={INK}>{p.title}</strong>
      </text>
      <box style={{ height: 1 }} />
      <text bg={PANEL} fg={MUTED}>{p.summary}</text>
      <box style={{ height: 1 }} />
      <Rule w={detailW} />
      <box style={{ height: 1 }} />
      <text bg={PANEL}>
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
  // header (pad+title+rule = 3) + footer (rule+nav+pad = 3): anything taller overflows the
  // screen and yoga flex-shrinks the HEADER by the excess — the title row silently vanishes
  const bodyRows = Math.max(4, height - 6);
  const detailW = Math.max(20, width - (narrow ? 4 : LIST_W + 6));

  // narrow: stack the (tappable) list above the selected project's detail
  if (narrow) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
        <text bg={PANEL} fg={FAINT}>{"  PROJECTS"}</text>
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
        <text bg={PANEL} fg={FAINT}>{"  PROJECTS"}</text>
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
        <text bg={PANEL} fg={ACCENT} wrapMode="none" style={{ height: 1 }}>{"> "}</text>
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
