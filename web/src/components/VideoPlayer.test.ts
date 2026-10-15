import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { RoomBroadcastStream } from "../realtime/RoomBroadcastStream";
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

describe("player placeholder", () => {
  it("waits for a source without attaching the synchronizer", () => {
    const attach = vi.fn();
    const { getByText } = render(
      createElement(VideoPlayer, {
        isHost: true,
        controller: { attach } as unknown as SyncController,
        syncStatus: "synced",
        syncStatusVisible: true,
        broadcasts: new RoomBroadcastStream(),
        onSyncStatusToggle: vi.fn(),
      }),
    );
    expect(getByText("等待房主选择影片")).toBeTruthy();
    expect(attach).not.toHaveBeenCalled();
  });
});
