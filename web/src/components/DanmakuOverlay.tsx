import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ChatMessage } from "../types";

const MAX_CONTENT_LENGTH = 72;
const MAX_ACTIVE_ITEMS = 32;
const MAX_QUEUE_DELAY_MS = 6000;
const LANE_HEIGHT_PX = 42;

type Metrics = { width: number; height: number; lanes: number };
type ActiveDanmaku = {
  id: string;
  author: string;
  content: string;
  lane: number;
  delayMs: number;
  durationMs: number;
  travelPx: number;
  accent: string;
};

export function formatDanmakuContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > MAX_CONTENT_LENGTH
    ? `${characters.slice(0, MAX_CONTENT_LENGTH).join("")}…`
    : normalized;
}

export function calculateLaneCount(width: number, height: number) {
  const heightLimited = Math.floor((height - 72) / LANE_HEIGHT_PX);
  const widthLimit = width < 520 ? 3 : width < 900 ? 5 : 8;
  return Math.max(2, Math.min(widthLimit, heightLimited || 2));
}

export function scheduleLane(
  availableAt: readonly number[],
  nowMs: number,
  occupancyMs: number,
  laneCount: number,
) {
  let lane = 0;
  let earliest = availableAt[0] ?? nowMs;
  for (let i = 1; i < laneCount; i++) {
    const candidate = availableAt[i] ?? nowMs;
    if (candidate < earliest) {
      lane = i;
      earliest = candidate;
    }
  }
  const startsAt = Math.max(nowMs, earliest);
  return {
    lane,
    delayMs: startsAt - nowMs,
    availableAt: startsAt + occupancyMs,
  };
}

function colorFor(senderId: string) {
  const colors = ["#ffd166", "#72ddf7", "#a7f3d0", "#f9a8d4", "#c4b5fd"];
  let hash = 0;
  for (const character of senderId)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function timing(width: number, contentLength: number) {
  const bubbleWidth = Math.min(640, 132 + contentLength * 15);
  const durationMs = Math.max(
    8000,
    Math.min(16000, ((width + bubbleWidth) / 96) * 1000),
  );
  const occupancyMs = Math.max(
    1900,
    Math.min(5200, (bubbleWidth / 96) * 1000 + 500),
  );
  return { durationMs, occupancyMs, travelPx: width + bubbleWidth + 48 };
}

export function DanmakuOverlay({
  messages,
  enabled,
}: {
  messages: ChatMessage[];
  enabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const laneAvailableAt = useRef<number[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({
    width: 960,
    height: 540,
    lanes: 8,
  });
  const [active, setActive] = useState<ActiveDanmaku[]>([]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => {
      const bounds = node.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      setMetrics({
        width: bounds.width,
        height: bounds.height,
        lanes: calculateLaneCount(bounds.width, bounds.height),
      });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled) {
      for (const message of messages) seen.current.add(message.id);
      setActive([]);
      return;
    }

    const additions: ActiveDanmaku[] = [];
    const now = performance.now();
    for (const message of messages) {
      if (seen.current.has(message.id)) continue;
      seen.current.add(message.id);
      const content = formatDanmakuContent(message.content);
      if (!content) continue;
      const itemTiming = timing(metrics.width, Array.from(content).length);
      const scheduled = scheduleLane(
        laneAvailableAt.current,
        now,
        itemTiming.occupancyMs,
        metrics.lanes,
      );
      laneAvailableAt.current[scheduled.lane] = scheduled.availableAt;
      if (scheduled.delayMs > MAX_QUEUE_DELAY_MS) continue;
      additions.push({
        id: message.id,
        author: message.senderNickname,
        content,
        lane: scheduled.lane,
        delayMs: scheduled.delayMs,
        durationMs: itemTiming.durationMs,
        travelPx: itemTiming.travelPx,
        accent: colorFor(message.senderId),
      });
    }
    if (additions.length) {
      setActive((items) => [...items, ...additions].slice(-MAX_ACTIVE_ITEMS));
    }
  }, [enabled, messages, metrics]);

  return (
    <div
      ref={root}
      className={`danmaku-layer${enabled ? " enabled" : ""}`}
      aria-hidden="true"
      data-testid="danmaku-layer"
    >
      {enabled &&
        active.map((item) => (
          <div
            className="danmaku-item"
            data-lane={item.lane}
            key={item.id}
            onAnimationEnd={() =>
              setActive((items) => items.filter(({ id }) => id !== item.id))
            }
            style={
              {
                top: `${52 + item.lane * LANE_HEIGHT_PX}px`,
                "--danmaku-delay": `${item.delayMs}ms`,
                "--danmaku-duration": `${item.durationMs}ms`,
                "--danmaku-travel": `${-item.travelPx}px`,
                "--danmaku-accent": item.accent,
              } as CSSProperties
            }
          >
            <span className="danmaku-author">{item.author}</span>
            <span className="danmaku-content">{item.content}</span>
          </div>
        ))}
    </div>
  );
}
