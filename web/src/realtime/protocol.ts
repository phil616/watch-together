import type { Member, Room } from "../types";

/** Version shared by the server and the browser client. */
export const PROTOCOL_VERSION = 1;

export type PlaybackPhase =
  | "no_media"
  | "loading"
  | "paused"
  | "playing"
  | "buffering"
  | "ended";
export type PlaybackState = {
  mediaId?: string;
  revision: number;
  timelineEpoch?: number;
  phase: PlaybackPhase;
  anchorPositionMs: number;
  anchorServerTimeMs: number;
  playbackRate: number;
  durationMs?: number;
  resumeIntent?: PlaybackPhase;
};
export type RoomSnapshot = {
  room: Room;
  playback: PlaybackState;
  members: Member[];
};
export type Envelope<T = unknown> = {
  v: number;
  type: string;
  requestId?: string;
  roomId?: string;
  revision?: number;
  serverTimeMs?: number;
  payload?: T;
};
/** Parse and validate a raw WebSocket message before dispatching it. */
export function parseEnvelope(raw: string): Envelope {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid message");
  const e = value as Envelope;
  if (e.v !== PROTOCOL_VERSION || typeof e.type !== "string")
    throw new Error("Unsupported protocol");
  return e;
}
