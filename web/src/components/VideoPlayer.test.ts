import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { SyncController } from "../player/SyncController";
import { VideoPlayer, togglePlayerFullscreen } from "./VideoPlayer";

const fullscreenEnabledDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "fullscreenEnabled",
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "webkitFullscreenElement");
  if (fullscreenEnabledDescriptor)
    Object.defineProperty(
      document,
      "fullscreenEnabled",
      fullscreenEnabledDescriptor,
    );
  else Reflect.deleteProperty(document, "fullscreenEnabled");
});

describe("togglePlayerFullscreen", () => {
  it("requests standard fullscreen for the complete player", async () => {
    const player = document.createElement("section");
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(player, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });

    await togglePlayerFullscreen(player, document.createElement("video"));

    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
  });

  it("tries WebKit element fullscreen after the standard API rejects", async () => {
    const player = document.createElement("section");
    const requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error("unsupported"));
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.assign(player, { requestFullscreen, webkitRequestFullscreen });
    await togglePlayerFullscreen(player);
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
  });

  it("uses native video fullscreen when element fullscreen is unavailable", async () => {
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: false,
    });
    const video = document.createElement("video");
    const webkitEnterFullscreen = vi.fn();
    Object.defineProperty(video, "webkitEnterFullscreen", {
      configurable: true,
      value: webkitEnterFullscreen,
    });

    await togglePlayerFullscreen(document.createElement("section"), video);

    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
  });
});

describe("fullscreen controls", () => {
  function mountPlayer() {
    vi.useFakeTimers();
    const result = render(
      createElement(VideoPlayer, {
        isHost: true,
        controller: { destroy: vi.fn() } as unknown as SyncController,
        syncStatus: "synced",
        syncStatusVisible: true,
        danmakuMessages: [],
        danmakuEnabled: false,
        onSyncStatusToggle: vi.fn(),
        onDanmakuToggle: vi.fn(),
      }),
    );
    const player = result.container.querySelector("section")!;
    return { ...result, player };
  }
  function fullscreen(element: Element | null, webkit = false) {
    Object.defineProperty(
      document,
      webkit ? "webkitFullscreenElement" : "fullscreenElement",
      {
        configurable: true,
        value: element,
      },
    );
    fireEvent(
      document,
      new Event(webkit ? "webkitfullscreenchange" : "fullscreenchange"),
    );
  }
  it.each([false, true])(
    "hides idle controls, wakes on touch and restores on exit (webkit=%s)",
    (webkit) => {
      const { player, getByRole } = mountPlayer();
      act(() => vi.advanceTimersByTime(3500));
      expect(player.classList.contains("controls-hidden")).toBe(false);
      fullscreen(player, webkit);
      expect(getByRole("button", { name: "退出全屏" })).toBeTruthy();
      act(() => vi.advanceTimersByTime(3000));
      expect(player.classList.contains("controls-hidden")).toBe(true);
      fireEvent.pointerDown(player.querySelector(".video-stage")!);
      expect(player.classList.contains("controls-hidden")).toBe(false);
      act(() => vi.advanceTimersByTime(3000));
      expect(player.classList.contains("controls-hidden")).toBe(true);
      fullscreen(null, webkit);
      expect(player.classList.contains("controls-hidden")).toBe(false);
      expect(getByRole("button", { name: "全屏" })).toBeTruthy();
    },
  );
  it("keeps keyboard controls visible and does not activate for another fullscreen element", () => {
    const { player, getByRole } = mountPlayer();
    fullscreen(document.body);
    expect(player.classList.contains("is-fullscreen")).toBe(false);
    fullscreen(player);
    act(() => getByRole("button", { name: "退出全屏" }).focus());
    act(() => vi.advanceTimersByTime(3500));
    expect(player.classList.contains("controls-hidden")).toBe(false);
  });
  it("cleans up the idle timer on unmount", () => {
    const { player, unmount } = mountPlayer();
    fullscreen(player);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
