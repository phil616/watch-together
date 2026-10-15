import { describe, expect, it, vi } from "vitest";
import {
  BROADCAST_LIFETIME_MS,
  RoomBroadcastStream,
} from "./RoomBroadcastStream";

const message = { id: "live-1", senderNickname: "Alice", content: "实时消息" };
describe("room broadcast delivery", () => {
  it("fans out immediately to every subscriber using receive time only", () => {
    const stream = new RoomBroadcastStream(() => 1200);
    const first = vi.fn(),
      second = vi.fn();
    stream.subscribe(first);
    stream.subscribe(second);
    stream.receive({ ...message, mediaPositionMs: 999999 } as typeof message);
    expect(first).toHaveBeenCalledWith({
      id: "live-1",
      author: "Alice",
      content: "实时消息",
      receivedAtMs: 1200,
      expiresAtMs: 1200 + BROADCAST_LIFETIME_MS,
    });
    expect(second.mock.calls).toEqual(first.mock.calls);
  });
  it("does not replay to late subscribers or deliver duplicate event IDs", () => {
    const stream = new RoomBroadcastStream();
    stream.receive(message);
    const receive = vi.fn();
    const unsubscribe = stream.subscribe(receive);
    expect(receive).not.toHaveBeenCalled();
    expect(stream.receive(message)).toBe(false);
    stream.receive({ ...message, id: "live-2" });
    expect(receive).toHaveBeenCalledOnce();
    unsubscribe();
    stream.receive({ ...message, id: "live-3" });
    expect(receive).toHaveBeenCalledOnce();
    stream.subscribe(receive);
    expect(receive).toHaveBeenCalledOnce();
  });
});
