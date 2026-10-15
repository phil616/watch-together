/** Authenticated or guest identity returned by the backend. */
export type Identity = {
  role?: "USER" | "SUPER_ADMIN";
  username?: string;
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

/** A server-broadcast room message; archived copies are only a sidebar log. */
export type ChatMessage = {
  id: string;
  senderId: string;
  senderNickname: string;
  senderKind: string;
  content: string;
  /** Legacy archive metadata. Never used to schedule or replay broadcasts. */
  mediaPositionMs?: number;
  createdAtMs: number;
};
