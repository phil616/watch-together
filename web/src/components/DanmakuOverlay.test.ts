import { describe, expect, it } from "vitest";
import {
  calculateLaneCount,
  formatDanmakuContent,
  scheduleLane,
} from "./DanmakuOverlay";

describe("danmaku layout", () => {
  it("adapts the number of lanes to narrow and wide players", () => {
    expect(calculateLaneCount(390, 220)).toBe(3);
    expect(calculateLaneCount(760, 430)).toBe(5);
    expect(calculateLaneCount(1280, 720)).toBe(8);
  });

  it("uses the earliest available lane and delays it without collision", () => {
    expect(scheduleLane([5000, 2200, 3000], 2000, 1800, 3)).toEqual({
      lane: 1,
      delayMs: 200,
      availableAt: 4000,
    });
  });

  it("normalizes whitespace and caps long on-screen messages", () => {
    expect(formatDanmakuContent("  一起看\n电影  ")).toBe("一起看 电影");
    const formatted = formatDanmakuContent("好".repeat(100));
    expect(Array.from(formatted)).toHaveLength(73);
    expect(formatted.endsWith("…")).toBe(true);
  });
});
