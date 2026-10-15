import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomBroadcastStream } from "../realtime/RoomBroadcastStream";
import { LiveBroadcastOverlay } from "./LiveBroadcastOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("live broadcast presentation", () => {
  it("shows without any media and expires without an animationend event", () => {
    vi.useFakeTimers();
    let now = 100;
    const stream = new RoomBroadcastStream(() => now);
    const { container } = render(
      createElement(LiveBroadcastOverlay, { stream }),
    );
    act(() => {
      stream.receive({
        id: "one",
        senderNickname: "Alice",
        content: "<img src=x>",
      });
    });
    expect(container.querySelector(".live-broadcast")?.textContent).toContain(
      "<img src=x>",
    );
    expect(container.querySelector("img")).toBeNull();
    act(() => {
      now = 8100;
      vi.advanceTimersByTime(8000);
    });
    expect(container.querySelector(".live-broadcast")).toBeNull();
    act(() => {
      stream.receive({
        id: "one",
        senderNickname: "Alice",
        content: "duplicate",
      });
    });
    expect(container.querySelector(".live-broadcast")).toBeNull();
  });
  it("does not retain a backlog across unmounts or visibility changes", () => {
    vi.useFakeTimers();
    let now = 0;
    const stream = new RoomBroadcastStream(() => now);
    const first = render(createElement(LiveBroadcastOverlay, { stream }));
    act(() => {
      stream.receive({ id: "one", senderNickname: "A", content: "old" });
    });
    act(() => {
      now = 9000;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(first.container.querySelector(".live-broadcast")).toBeNull();
    first.unmount();
    stream.receive({ id: "two", senderNickname: "A", content: "unobserved" });
    const second = render(createElement(LiveBroadcastOverlay, { stream }));
    expect(second.container.querySelector(".live-broadcast")).toBeNull();
  });
});
