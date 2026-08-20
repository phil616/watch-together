import { afterEach, describe, expect, it, vi } from "vitest";
import { togglePlayerFullscreen } from "./VideoPlayer";

const fullscreenEnabledDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "fullscreenEnabled",
);

afterEach(() => {
  vi.restoreAllMocks();
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
