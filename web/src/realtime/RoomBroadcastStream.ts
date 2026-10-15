import type { ChatMessage } from "../types";

export const BROADCAST_LIFETIME_MS = 8000;
const RECENT_IDS_LIMIT = 4096;

/** A live delivery has a receive-time lifetime, never a media timestamp. */
export type LiveBroadcast = Readonly<{
  id: string;
  author: string;
  content: string;
  receivedAtMs: number;
  expiresAtMs: number;
}>;

type Listener = (broadcast: LiveBroadcast) => void;

/** Room-scoped transient fan-out. Subscription does not replay previous events. */
export class RoomBroadcastStream {
  private readonly listeners = new Set<Listener>();
  private readonly seen = new Set<string>();

  constructor(readonly now: () => number = () => performance.now()) {}

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  receive(message: Pick<ChatMessage, "id" | "senderNickname" | "content">) {
    if (this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    if (this.seen.size > RECENT_IDS_LIMIT)
      this.seen.delete(this.seen.values().next().value!);
    const receivedAtMs = this.now();
    const broadcast: LiveBroadcast = {
      id: message.id,
      author: message.senderNickname,
      content: message.content,
      receivedAtMs,
      expiresAtMs: receivedAtMs + BROADCAST_LIFETIME_MS,
    };
    for (const listener of this.listeners) listener(broadcast);
    return true;
  }
}
