// Music surface: Spotify now-playing widget, visitor preview playback, and the
// audio-reactive volume bar. Talks to the browser tab through a per-session
// VolumeChannel (OSC 777 volume / OSC 778 playback, amp bands back over the WS).
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { getSpotify, type SpotifyState } from "@/lib/spotify";
import { getPreviewUrl } from "@/lib/preview";
import { ACCENT, BARS, FAINT, INK, MUTED, PANEL, Stat, fmtMs, timeAgo, truncate } from "./ui";

// Two-way link between the TUI volume bar and the browser tab's ambient audio.
// web.ts creates one per websocket session; ssh sessions have no audio, so no channel.
export type VolumeChannel = {
  get(): number;
  set(v: number, source: "tui" | "client"): void;
  subscribe(fn: (v: number) => void): () => void;
  // visitor-driven playback: start a 30s preview in the tab (null stops it)
  play(url: string | null): void;
  // live frequency bands (bass→treble, 0..1) from the tab's analyser while a preview plays
  feedAmp(v: number[]): void;
  onAmp(fn: (v: number[]) => void): () => void;
};

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

// left-anchored eighth blocks — the vertical bar's cells pulse in width, not height
const HBARS = "▏▎▍▌▋▊▉█";

// The horizontal volume bar rotated 90°: same shimmering ramp cells, stacked bottom-up,
// with the cell fill direction rotated too (cells widen instead of rise).
// Click a rung to set the level, click the ♪ to mute. Position uses the same square curve
// as the audio side (position = sqrt(volume)) for fine control at the quiet end.
// Exported for nowplaying.test.tsx.
// bar geometry + rung→volume mapping shared by click/drag/scroll/arrow-key paths
export const VOL_RUNGS = 8;
export function rungOf(vol: number): number {
  return Math.round(Math.sqrt(Math.max(0, Math.min(1, vol))) * VOL_RUNGS);
}
export function volAtRung(rung: number): number {
  return (Math.max(0, Math.min(VOL_RUNGS, rung)) / VOL_RUNGS) ** 2;
}

export function VolumeBar({ channel }: { channel: VolumeChannel }) {
  const [vol, setVol] = useState(channel.get());
  const [t, setT] = useState(0);
  // live analyser bands from the tab while a preview plays; stale data (>500ms) means the
  // music stopped, so the sine animation takes back over
  const [amp, setAmp] = useState<{ v: number[]; at: number } | null>(null);
  // where the drag started: the rung grabbed and the screen row it was at.
  // dragging N rows up from there = N rungs louder — no layout math needed.
  const drag = useRef<{ rung: number; y: number } | null>(null);
  useEffect(() => channel.subscribe(setVol), [channel]);
  useEffect(() => channel.onAmp((v) => setAmp({ v, at: Date.now() })), [channel]);
  useEffect(() => {
    const id = setInterval(() => setT((n) => n + 1), 90);
    return () => clearInterval(id);
  }, []);
  const live = amp && Date.now() - amp.at < 500 ? amp.v : null;
  const H = VOL_RUNGS;
  const sqrtVol = Math.sqrt(Math.max(0, Math.min(1, vol)));
  const pos = Math.round(sqrtVol * H); // filled rungs, from the bottom
  const onDrag = (e: { y: number }) => {
    const d = drag.current;
    if (!d) return;
    channel.set(volAtRung(d.rung + (d.y - e.y)), "tui");
  };
  const nudge = (dir: 1 | -1) => channel.set(volAtRung(rungOf(channel.get()) + dir), "tui");
  // every row is exactly 5 cells with manual centering: the bar is 3 cells (odd), so the
  // single-glyph ♪/▲/▼ and a 3-char "NN%" sit dead-center over it — no half-cell drift
  const pad5 = (s: string) => {
    const left = Math.floor((5 - s.length) / 2);
    return " ".repeat(Math.max(0, left)) + s + " ".repeat(Math.max(0, 5 - s.length - left));
  };
  return (
    <box
      style={{ flexDirection: "column", alignItems: "flex-start" }}
      onMouseScroll={(e: { scroll?: { direction: string } }) => {
        if (e.scroll?.direction === "up") nudge(1);
        else if (e.scroll?.direction === "down") nudge(-1);
      }}
    >
      <box onMouseDown={(e: { y: number }) => { drag.current = { rung: 0, y: e.y }; channel.set(0, "tui"); }} onMouseDrag={onDrag}>
        <text bg={PANEL} fg={FAINT}>{pad5("♪")}</text>
      </box>
      <box onMouseDown={() => nudge(1)}>
        <text bg={PANEL} fg={MUTED}>{pad5("▲")}</text>
      </box>
      {Array.from({ length: H }, (_, i) => {
        const rung = H - i; // the level this row represents, in rows from the bottom
        const on = rung <= pos;
        // every rung waves; the level only decides the color (green below, greyed above).
        // with live analyser data the rungs track the music (bass at the bottom); otherwise
        // a dominant traveling sine (wavelength ≈ the whole bar) with a small counter-phase
        // ripple: crests sweep the full 3-col width, troughs thin to a sliver — no clipping.
        const wave = live
          ? live[rung - 1] ?? 0
          : (0.85 * Math.sin(t * 0.3 + rung * 0.5) + 0.15 * Math.sin(t * 0.19 - rung * 0.33)) * 0.5 + 0.5;
        // 3 cells filled continuously in 24 eighths
        let e8 = Math.max(1, Math.round(1 + wave * 23));
        let cells = "";
        for (let c = 0; c < 3; c += 1) {
          const take = Math.max(0, Math.min(8, e8));
          cells += take === 8 ? "█" : take > 0 ? HBARS[take - 1] : " ";
          e8 -= 8;
        }
        return (
          <box
            key={i}
            onMouseDown={(e: { y: number }) => { drag.current = { rung, y: e.y }; channel.set(volAtRung(rung), "tui"); }}
            onMouseDrag={onDrag}
          >
            <text bg={PANEL} fg={on ? ACCENT : FAINT}>{` ${cells} `}</text>
          </box>
        );
      })}
      <box onMouseDown={() => nudge(-1)}>
        <text bg={PANEL} fg={MUTED}>{pad5("▼")}</text>
      </box>
      {/* fixed 5-wide label: 0% -> 100% never resizes or re-centers anything */}
      <text bg={PANEL} fg={FAINT}>{pad5(`${Math.round(sqrtVol * 100)}%`)}</text>
    </box>
  );
}

// Spotify now-playing / recently-played. Polls server-side; hides entirely if Spotify isn't configured.
// When idle, `volume` (web sessions) enables visitor playback: « ▶ » controls under the list
// play the 30s previews of my recent tracks in the visitor's tab.
// Exported for nowplaying.test.tsx.
export function NowPlaying({ volume, controlsWidth }: { volume?: VolumeChannel; controlsWidth?: number }) {
  const [state, setState] = useState<SpotifyState | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0); // when progressMs was fetched, for per-second interpolation
  const [now, setNow] = useState(() => Date.now());
  const loadRef = useRef<() => void>(() => {});
  const endRefetched = useRef(false); // one end-of-track refetch per poll, so we never loop
  useEffect(() => {
    let alive = true;
    const load = () =>
      getSpotify()
        .then((s) => {
          if (alive) {
            setState(s);
            setFetchedAt(Date.now());
            setNow(Date.now());
            // re-arm only when the fresh poll isn't already sitting at the end of the track
            endRefetched.current = s.progressMs != null && s.durationMs != null && s.progressMs >= s.durationMs;
          }
        })
        .catch(() => {});
    loadRef.current = load;
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const isPlaying = Boolean(state?.isPlaying && state.current);
  // visitor playback (idle only): which recent track is loaded and whether it's sounding
  const [sel, setSel] = useState(0);
  const [listening, setListening] = useState(false);
  const [listenStart, setListenStart] = useState(0); // when the current preview started (30s loop)
  useEffect(() => {
    if (!isPlaying && !listening) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isPlaying, listening]);
  const stopListen = useCallback(() => {
    volume?.play(null);
    setListening(false);
  }, [volume]);
  // my live playback taking over kills visitor playback (the client audio switches anyway)
  useEffect(() => {
    if (isPlaying && listening) setListening(false);
  }, [isPlaying, listening]);
  // the idle list the visitor can browse (same slice the idle render shows)
  const idleList = !isPlaying && state?.configured ? state.recent.slice(0, 6) : [];
  // resolve the track's preview server-side (this component runs on the server) and ship it
  // to the visitor's tab over the volume channel
  const startListen = (n: number) => {
    if (!volume || idleList.length === 0) return;
    const m = ((n % idleList.length) + idleList.length) % idleList.length;
    const id = idleList[m]?.track.songUrl?.split("/track/")[1]?.split("?")[0];
    if (!id) return;
    getPreviewUrl(id)
      .then((url) => {
        if (url) {
          volume.play(url);
          setSel(m);
          setListening(true);
          setListenStart(Date.now());
          setNow(Date.now());
        }
      })
      .catch(() => {});
  };
  // « / » / ←→: move the selection down the list as rendered (right/» = down = older);
  // switch playback immediately if something is already sounding
  const moveSel = (d: 1 | -1) => {
    if (idleList.length === 0) return;
    const n = (sel + d + idleList.length) % idleList.length;
    setSel(n);
    if (listening) startListen(n);
  };
  useKeyboard((key) => {
    if (!volume || isPlaying || idleList.length === 0) return;
    if (key.name === "left") return moveSel(-1);
    if (key.name === "right") return moveSel(1);
    if (key.name === "space" || key.sequence === " ") {
      if (listening) stopListen();
      else startListen(sel);
    }
  });
  // radio mode: when the 30s preview runs out, roll to the next track (once per start)
  const advancedFor = useRef(0);
  useEffect(() => {
    if (!listening || isPlaying) return;
    if (now - listenStart >= 30_000 && advancedFor.current !== listenStart) {
      advancedFor.current = listenStart;
      startListen(sel + 1);
    }
  });
  // displayed progress advances between 10s polls; refetch once when the track runs out
  const shownProgress =
    state?.progressMs != null && state.durationMs
      ? Math.min(state.durationMs, state.progressMs + Math.max(0, now - fetchedAt))
      : null;
  useEffect(() => {
    if (shownProgress != null && state?.durationMs && shownProgress >= state.durationMs && !endRefetched.current) {
      endRefetched.current = true;
      loadRef.current();
    }
  }, [shownProgress, state]);
  if (!state || !state.configured) return null;
  const playing = state.isPlaying && state.current ? state.current : null;
  // playing → 2 previous + current + 2 up next; idle → 6 most-recent
  const previous = state.recent
    .filter((e) => !playing || e.track.name !== playing.name)
    .slice(0, playing ? 2 : 6);
  if (playing) previous.reverse(); // oldest first, so the timeline reads previous -> current -> up next
  if (!playing && previous.length === 0) {
    return (
      <Stat label="RECENTLY PLAYED">
        <text bg={PANEL} fg={FAINT}>
          nothing recently
        </text>
      </Stat>
    );
  }
  // the focus block: my live track, or the preview the visitor is playing — same layout.
  // Around it: dim rows above (history / newer neighbours) and » rows below (queue / older).
  const preview = !playing && listening ? previous[sel] : undefined;
  const focus = playing ?? preview?.track ?? null;
  // preview window: one less track than the flat list shows, so window rows + the progress
  // row always equal the flat list height — starting/stopping/navigating never shifts layout
  // (at the list edges the window extends the other way instead of shrinking)
  const winSize = Math.min(5, Math.max(1, previous.length - 1));
  const winStart = Math.max(0, Math.min(sel - 2, previous.length - winSize));
  const beforeRows = playing || !preview ? previous : previous.slice(winStart, sel);
  const nextTracks = playing
    ? state.queue.slice(0, 2)
    : preview
      ? previous.slice(sel + 1, winStart + winSize).map((e) => e.track)
      : [];
  // previews are hard-capped at 30s by Spotify (the CDN file itself); play once, no loop
  const focusProgress = playing ? shownProgress : preview ? Math.min(30_000, now - listenStart) : null;
  const focusDuration = playing ? state.durationMs : preview ? 30_000 : null;
  const flat = !focus; // plain browsable list (idle, nothing sounding)
  const meta = flat && previous[0]?.playedAt ? timeAgo(previous[0].playedAt) : undefined;
  // hierarchy: dim indented history above, bright focus block set off by blank lines,
  // dim indented queue below, controls centered at the bottom. Secondary rows stay
  // clickable but drop the underline so only the focus track carries visual weight.
  return (
    <Stat label={playing ? "NOW PLAYING" : preview ? "PREVIEW" : "RECENTLY PLAYED"} meta={meta}>
      {beforeRows.map((e, i) => {
        const isSel = flat && Boolean(volume) && i === sel; // browsable selection (web idle only)
        const rowFg = !flat ? FAINT : isSel || (!volume && i === 0) ? INK : MUTED;
        return (
          <text key={i} bg={PANEL}>
            <span fg={isSel ? MUTED : FAINT}>{!flat ? "  · " : isSel ? "▸ " : "· "}</span>
            {e.track.songUrl ? (
              <a href={e.track.songUrl} fg={rowFg} attributes={flat ? TextAttributes.UNDERLINE : undefined}>
                {truncate(e.track.name, 32)}
              </a>
            ) : (
              <span fg={rowFg}>{truncate(e.track.name, 32)}</span>
            )}
            <span fg={FAINT}>{e.track.artists.length ? ` — ${truncate(e.track.artists.join(", "), 18)}` : ""}</span>
          </text>
        );
      })}
      {focus ? (
        <box style={{ flexDirection: "column" }}>
          {/* breathing room only for my live playback; the preview window keeps rows tight
              (indentation carries the hierarchy) so navigating never shifts the layout */}
          {playing && beforeRows.length ? <box style={{ height: 1 }} /> : null}
          <text bg={PANEL}>
            <span fg={ACCENT}>{"♫ "}</span>
            {focus.songUrl ? (
              <a href={focus.songUrl} fg={INK} attributes={TextAttributes.UNDERLINE}>
                {truncate(focus.name, 34)}
              </a>
            ) : (
              <span fg={INK}>{truncate(focus.name, 34)}</span>
            )}
            <span fg={MUTED}>{focus.artists.length ? `  —  ${truncate(focus.artists.join(", "), 22)}` : ""}</span>
          </text>
          {focusProgress != null && focusDuration ? (
            <ProgressBar progress={focusProgress} duration={focusDuration} />
          ) : (
            <Equalizer />
          )}
          {playing && nextTracks.length ? <box style={{ height: 1 }} /> : null}
        </box>
      ) : null}
      {nextTracks.map((t, i) => (
        <text key={`q${i}`} bg={PANEL}>
          <span fg={FAINT}>{"  » "}</span>
          {t.songUrl ? (
            <a href={t.songUrl} fg={MUTED}>
              {truncate(t.name, 32)}
            </a>
          ) : (
            <span fg={MUTED}>{truncate(t.name, 32)}</span>
          )}
          <span fg={FAINT}>{t.artists.length ? ` — ${truncate(t.artists.join(", "), 18)}` : ""}</span>
        </text>
      ))}
      {!playing && volume ? (
        <box style={{ flexDirection: "column" }}>
          <box style={{ height: 1 }} />
          {/* « selects up the list, » down (as rendered); space toggles, ←/→ move too.
              fixed-width box spanning the GITHUB stats row above: « sits on its first
              column, » exactly on the ★ column — nothing moves across flat/preview modes */}
          <box style={{ flexDirection: "row", justifyContent: "space-between", width: controlsWidth ?? 33, alignSelf: "flex-start" }}>
            <box onMouseDown={() => moveSel(-1)}>
              <text bg={PANEL} fg={MUTED}>{"«"}</text>
            </box>
            <box onMouseDown={() => (listening ? stopListen() : startListen(sel))}>
              <text bg={PANEL} fg={listening ? ACCENT : MUTED}>{listening ? "■" : "▶"}</text>
            </box>
            <box onMouseDown={() => moveSel(1)}>
              <text bg={PANEL} fg={MUTED}>{"»"}</text>
            </box>
          </box>
        </box>
      ) : null}
    </Stat>
  );
}
