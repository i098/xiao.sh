// In-browser VolumeChannel: the DOM app runs in the same tab as the audio, so the
// OSC 777/778 + WS amp/dur relay collapses into direct function calls. Port of the
// audio half of the old xterm client (server/web.ts): shared <audio>, gesture-built
// analyser/gain graph, ambient now-playing loop, visitor preview playback, band feed.
// The object shape is tui/music.tsx's VolumeChannel (checked structurally in web/main.ts).

export function createVolumeChannel() {
  const song = new Audio();
  (window as unknown as { __song?: HTMLAudioElement }).__song = song; // debug handle
  song.crossOrigin = "anonymous"; // p.scdn.co sends ACAO:* — lets the analyser read real data
  song.loop = true;
  song.preload = "auto";
  song.volume = 0;

  let songKey = ""; // identity of the current ambient track
  let manual = false; // visitor-driven playback owns the idle state
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let unlockArmed = false;

  // listening volume: whisper-quiet default; persisted across visits
  let vol = 0.04;
  try {
    const s = parseFloat(localStorage.getItem("xiao-vol") ?? "");
    if (!isNaN(s)) vol = Math.min(1, Math.max(0, s));
  } catch {}

  // Web Audio graph (built on first gesture — AudioContext needs user activation):
  // song → analyser → gain → speakers. Loudness lives in the gain node so the analyser
  // sees the full-scale signal; setLevel/getLevel abstract over both worlds.
  let actx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let analyser: AnalyserNode | null = null;
  const setLevel = (v: number) => {
    if (gainNode) gainNode.gain.value = v;
    else song.volume = v;
  };
  const getLevel = () => (gainNode ? gainNode.gain.value : song.volume);
  function initAudioGraph() {
    if (actx) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      const src = actx.createMediaElementSource(song);
      analyser = actx.createAnalyser();
      analyser.fftSize = 128; // 64 bins — finer low-end resolution for the 8-rung bar
      analyser.smoothingTimeConstant = 0.55;
      gainNode = actx.createGain();
      gainNode.gain.value = song.volume;
      src.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(actx.destination);
      song.volume = 1; // loudness now lives in the gain node
    } catch {
      actx = null;
      gainNode = null;
      analyser = null;
    }
  }
  const gestureInit = () => {
    removeEventListener("pointerdown", gestureInit);
    removeEventListener("keydown", gestureInit);
    initAudioGraph();
    actx?.resume().catch(() => {});
  };
  addEventListener("pointerdown", gestureInit);
  addEventListener("keydown", gestureInit);

  function fadeTo(target: number, ms: number, done?: () => void) {
    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
    if (getLevel() === target) {
      done?.();
      return;
    }
    const step = (target - getLevel()) / (ms / 50);
    fadeTimer = setInterval(() => {
      const v = getLevel() + step;
      if ((step > 0 && v >= target) || (step < 0 && v <= target)) {
        setLevel(target);
        if (fadeTimer) clearInterval(fadeTimer);
        fadeTimer = null;
        done?.();
      } else {
        setLevel(v);
      }
    }, 50);
  }

  function startSong(url: string) {
    song.loop = true; // ambient previews loop while my track plays
    song.src = url;
    const p = song.play();
    // autoplay blocked → retry on the first interaction
    p?.catch?.(() => {
      if (unlockArmed) return;
      unlockArmed = true;
      const unlock = () => {
        removeEventListener("pointerdown", unlock);
        removeEventListener("keydown", unlock);
        song.play().then(() => fadeTo(vol, 3000)).catch(() => {});
      };
      addEventListener("pointerdown", unlock);
      addEventListener("keydown", unlock);
    });
    fadeTo(vol, 3000);
  }

  // ambient audio: whisper-quiet preview of whatever I'm playing right now
  function pollSong() {
    fetch("/api/now-playing")
      .then((r) => r.json())
      .then((d: { playing: boolean; name: string | null; artists: string[]; previewUrl: string | null }) => {
        const key = d.playing ? `${d.name} - ${d.artists.join(", ")}` : "";
        document.title = key ? `♫ ${key} · xiao.sh` : "xiao.sh";
        if (d.playing && d.previewUrl) manual = false; // my live playback takes the audio back
        else if (manual) return; // visitor playback owns the idle state
        if (key === songKey) return;
        songKey = key;
        if (d.playing && d.previewUrl) {
          if (song.paused) startSong(d.previewUrl);
          else fadeTo(0, 1000, () => startSong(d.previewUrl!));
        } else {
          // drop the src too, or an armed autoplay-unlock handler would replay the stale preview
          fadeTo(0, 1000, () => {
            song.pause();
            song.removeAttribute("src");
          });
        }
      })
      .catch(() => {});
  }
  pollSong();
  setInterval(pollSong, 5000);

  const volSubs = new Set<(v: number) => void>();
  const ampSubs = new Set<(v: number[]) => void>();
  const durSubs = new Set<(ms: number) => void>();

  // previews vary in length (iTunes cuts can be 90s) — report the real number so the
  // progress bar and auto-advance match what's actually playing
  song.addEventListener("durationchange", () => {
    if (manual && isFinite(song.duration) && song.duration > 0)
      durSubs.forEach((fn) => fn(Math.round(song.duration * 1000)));
  });

  // While a visitor preview plays, feed 8 frequency bands (bass→treble, 0..1) so the
  // volume bar dances to the actual music. Bands are stretched between a slowly-adapting
  // floor/ceiling — see the tuning notes in the original client; values are unchanged.
  const bandLo = new Array<number>(8).fill(0.1);
  const bandHi = new Array<number>(8).fill(0.75);
  setInterval(() => {
    if (!analyser || !manual || song.paused) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    // music lives in the lower ~2/3 of the spectrum; log-space the 8 bands across that
    const span = Math.floor(bins.length * 0.66);
    const bands: number[] = [];
    for (let b = 0; b < 8; b++) {
      const s = Math.floor(Math.pow(b / 8, 1.7) * span);
      const e2 = Math.max(s + 1, Math.floor(Math.pow((b + 1) / 8, 1.7) * span));
      let m = 0;
      for (let k = s; k < e2 && k < span; k++) m = Math.max(m, bins[k]);
      const raw = m / 255;
      bandLo[b] = Math.min(raw, bandLo[b] + 0.004, 0.5); // floor creeps up, capped
      bandHi[b] = Math.max(raw, bandHi[b] - 0.004, bandLo[b] + 0.4); // ceiling drifts down, wide min span
      const out = Math.pow(Math.max(0, Math.min(1, (raw - bandLo[b]) / (bandHi[b] - bandLo[b]))), 1.15);
      bands.push(Math.round(out * 100) / 100);
    }
    // all-zero frames (CORS-tainted or silent) are not fed — the TUI falls back to sine
    if (bands.some((x) => x > 0)) ampSubs.forEach((fn) => fn(bands));
  }, 100);

  return {
    get: () => vol,
    set(v: number, _source: "tui" | "client") {
      vol = Math.min(1, Math.max(0, v));
      try {
        localStorage.setItem("xiao-vol", String(vol));
      } catch {}
      if (fadeTimer) {
        clearInterval(fadeTimer);
        fadeTimer = null; // a bar click overrides any fade in flight
      }
      setLevel(vol);
      volSubs.forEach((fn) => fn(vol));
    },
    subscribe(fn: (v: number) => void) {
      volSubs.add(fn);
      return () => {
        volSubs.delete(fn);
      };
    },
    // visitor-driven playback of my recent tracks (« ▶ » controls while I'm offline)
    play(url: string | null) {
      if (url === null) {
        manual = false;
        song.loop = true; // restore ambient behavior
        fadeTo(0, 400, () => {
          song.pause();
          song.removeAttribute("src");
        });
      } else {
        manual = true;
        song.loop = false; // previews play once; the TUI advances to the next track
        song.src = url;
        song.play().then(() => fadeTo(vol, 800)).catch(() => {});
      }
    },
    feedAmp(v: number[]) {
      ampSubs.forEach((fn) => fn(v));
    },
    onAmp(fn: (v: number[]) => void) {
      ampSubs.add(fn);
      return () => {
        ampSubs.delete(fn);
      };
    },
    feedDur(ms: number) {
      durSubs.forEach((fn) => fn(ms));
    },
    onDur(fn: (ms: number) => void) {
      durSubs.add(fn);
      return () => {
        durSubs.delete(fn);
      };
    },
  };
}
