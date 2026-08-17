/** Authenticated or guest identity returned by the backend. */
export type Identity = {
  id: string;
  nickname: string;
  roomId?: string;
  guest: boolean;
};

/** Public room metadata shared by room APIs and realtime snapshots. */
export type Room = {
  id: string;
  code: string;
  title: string;
  hostUserId: string;
  mediaId?: string;
  status: "OPEN" | "HOST_DISCONNECTED" | "CLOSED";
  maxMembers: number;
  createdAtMs: number;
};

/** User-uploaded media stored in the private object store. */
export type Media = {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  status: string;
};

/** Room participant shown in the member panel. */
export type Member = {
  id: string;
  nickname: string;
  role: "host" | "member";
  kind: "user" | "guest";
  online: boolean;
  ready: boolean;
};

/** Chat or danmaku message displayed in the room. */
export type ChatMessage = {
  id: string;
  senderId: string;
  senderNickname: string;
  senderKind: string;
  content: string;
  mediaPositionMs?: number;
  createdAtMs: number;
};
