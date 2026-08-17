import type { PlaybackState } from "../realtime/protocol";

/** Compute the media position the room timeline should currently be at. */
export function expectedPosition(
  state: PlaybackState,
  serverNowMs: number,
): number {
  let position = state.anchorPositionMs;
  if (state.phase === "playing" && serverNowMs > state.anchorServerTimeMs)
    position += (serverNowMs - state.anchorServerTimeMs) * state.playbackRate;
  return Math.max(
    0,
    state.durationMs ? Math.min(position, state.durationMs) : position,
  );
}

/** Reject stale or out-of-order playback revisions. */
export function acceptRevision(lastRevision: number, nextRevision: number) {
  return nextRevision > lastRevision;
}
