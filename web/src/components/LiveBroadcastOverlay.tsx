import { useEffect, useState } from "react";
import {
  RoomBroadcastStream,
  type LiveBroadcast,
} from "../realtime/RoomBroadcastStream";

/** Receive once, show immediately, expire by elapsed time. No media dependency. */
export function LiveBroadcastOverlay({
  stream,
}: {
  stream: RoomBroadcastStream;
}) {
  const [active, setActive] = useState<readonly LiveBroadcast[]>([]);
  useEffect(() => {
    setActive([]);
    return stream.subscribe((broadcast) => {
      setActive((current) => [
        broadcast,
        ...current.filter((item) => item.expiresAtMs > stream.now()),
      ]);
    });
  }, [stream]);
  useEffect(() => {
    if (!active.length) return;
    const expire = () =>
      setActive((current) =>
        current.filter((item) => item.expiresAtMs > stream.now()),
      );
    const deadline = Math.min(...active.map((item) => item.expiresAtMs));
    const timer = window.setTimeout(
      expire,
      Math.max(0, deadline - stream.now()),
    );
    // Background tabs can throttle timers; overdue broadcasts must not return.
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [active, stream]);
  return (
    <div
      className="live-broadcasts"
      aria-hidden="true"
      data-testid="live-broadcasts"
    >
      {active.map((item) => (
        <article
          className="live-broadcast"
          data-broadcast-id={item.id}
          key={item.id}
        >
          <strong>{item.author}</strong>
          <span>{item.content}</span>
        </article>
      ))}
    </div>
  );
}
