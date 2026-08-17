import { describe, expect, it } from "vitest";
import { acceptRevision, expectedPosition } from "./PlaybackModel";
import type { PlaybackState } from "../realtime/protocol";
const state = (rate: number): PlaybackState => ({
  mediaId: "m",
  revision: 1,
  phase: "playing",
  anchorPositionMs: 100000,
  anchorServerTimeMs: 1000000,
  playbackRate: rate,
  durationMs: 200000,
});
describe("authoritative timeline", () => {
  it("advances at 1x", () =>
    expect(expectedPosition(state(1), 1005000)).toBe(105000));
  it("advances at 1.5x", () =>
    expect(expectedPosition(state(1.5), 1005000)).toBe(107500));
  it("clamps to duration", () =>
    expect(expectedPosition(state(2), 1100000)).toBe(200000));
  it("rejects stale revisions", () => {
    let revision = 100;
    for (const next of [102, 101])
      if (acceptRevision(revision, next)) revision = next;
    expect(revision).toBe(102);
  });
});
