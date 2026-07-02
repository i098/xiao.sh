import { expect, test, mock } from "bun:test";
import { ManualClock } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { SpotifyState, SpotifyTrack } from "@/lib/spotify";

const track = (name: string, artist: string): SpotifyTrack => ({
  id: null,
  name,
  artists: [artist],
  album: null,
  songUrl: `https://open.spotify.com/track/${name}`,
  imageUrl: null,
});

// swap this between tests; the mock closes over it
let state: SpotifyState;
mock.module("@/lib/spotify", () => ({ getSpotify: async () => state }));
const { NowPlaying, VolumeBar } = await import("./music");
type VolumeChannel = import("./music").VolumeChannel;

function fakeChannel(initial: number) {
  let value = initial;
  const subs = new Set<(v: number) => void>();
  const channel: VolumeChannel = {
    get: () => value,
    set(v, _source) {
      value = v;
      subs.forEach((fn) => fn(v));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    play(_url) {},
    feedAmp(_v) {},
    onAmp(_fn) {
      return () => {};
    },
  };
  return channel;
}

async function renderWidget() {
  const clock = new ManualClock();
  const r = await testRender(<NowPlaying />, { width: 70, height: 12, clock });
  // let the widget's async getSpotify() poll resolve, then paint
  await new Promise((res) => setTimeout(res, 20));
  await r.renderOnce();
  return r;
}

test("playing: 2 previous (oldest first), now playing, 2 up next", async () => {
  state = {
    configured: true,
    isPlaying: true,
    current: track("Current Song", "Artist C"),
    progressMs: 65_000,
    durationMs: 180_000,
    recent: [
      { track: track("Prev Newest", "Artist B"), playedAt: null },
      { track: track("Prev Oldest", "Artist A"), playedAt: null },
      { track: track("Prev Ancient", "Artist Z"), playedAt: null },
    ],
    queue: [track("Next One", "Artist D"), track("Next Two", "Artist E")],
  };
  const { renderer, captureCharFrame } = await renderWidget();
  const frame = captureCharFrame();
  expect(frame).toContain("NOW PLAYING");
  expect(frame).toContain("1:05 / 3:00");
  // timeline order: oldest history at the top, queue below the current track
  const order = ["Prev Oldest", "Prev Newest", "♫ Current Song", "» Next One", "» Next Two"];
  const at = order.map((s) => frame.indexOf(s));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // only 2 history rows while playing
  expect(frame).not.toContain("Prev Ancient");
  renderer.destroy();
});

test("progress advances by the second between polls", async () => {
  state = {
    configured: true,
    isPlaying: true,
    current: track("Ticking Song", "Artist T"),
    progressMs: 60_000,
    durationMs: 180_000,
    recent: [],
    queue: [],
  };
  const { renderer, renderOnce, captureCharFrame } = await renderWidget();
  expect(captureCharFrame()).toContain("1:00 / 3:00");
  // the widget's 1s ticker runs on real timers; ~2.1s later the bar should read +2s
  await new Promise((res) => setTimeout(res, 2_100));
  await renderOnce();
  expect(captureCharFrame()).toContain("1:02 / 3:00");
  renderer.destroy();
});

test("volume bar renders position and follows channel updates", async () => {
  const channel = fakeChannel(0.04); // sqrt(0.04)=0.2 -> 20%
  const clock = new ManualClock();
  const { renderer, renderOnce, captureCharFrame } = await testRender(<VolumeBar channel={channel} />, {
    width: 10,
    height: 16,
    clock,
  });
  await renderOnce();
  expect(captureCharFrame()).toContain("20%");
  channel.set(0.25, "client"); // sqrt(0.25)=0.5 -> 50%
  await new Promise((res) => setTimeout(res, 10));
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("50%");
  // every rung waves (level is color-only, invisible in a char frame): 8 glyph rows
  expect(frame.split("\n").filter((l) => /[▎▍▌▋▊▉█▏]/.test(l)).length).toBe(8);
  renderer.destroy();
});

test("idle: recently played list, no queue rows", async () => {
  state = {
    configured: true,
    isPlaying: false,
    current: null,
    progressMs: null,
    durationMs: null,
    recent: [
      { track: track("Song 1", "A1"), playedAt: null },
      { track: track("Song 2", "A2"), playedAt: null },
      { track: track("Song 3", "A3"), playedAt: null },
      { track: track("Song 4", "A4"), playedAt: null },
    ],
    queue: [track("Ghost Queue", "Nobody")],
  };
  const { renderer, captureCharFrame } = await renderWidget();
  const frame = captureCharFrame();
  expect(frame).toContain("RECENTLY PLAYED");
  for (const s of ["Song 1", "Song 2", "Song 3", "Song 4"]) expect(frame).toContain(s);
  expect(frame).not.toContain("Ghost Queue");
  expect(frame).not.toContain("♫");
  renderer.destroy();
});
