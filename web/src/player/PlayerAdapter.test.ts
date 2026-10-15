import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPlayer } from "./PlayerAdapter";
import type { SyncController } from "./SyncController";

afterEach(() => vi.restoreAllMocks());

describe("player room boundary", () => {
  it("routes UI actions once, but remote writes and asynchronous native events never echo", async () => {
    const nativePlay = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue();
    const nativePause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    let direct!: HTMLVideoElement;
    const controller = {
      attach: vi.fn((video: HTMLVideoElement) => {
        direct = video;
      }),
      destroy: vi.fn(),
      onUserPlay: vi.fn().mockResolvedValue(undefined),
      onUserPause: vi.fn().mockResolvedValue(undefined),
      onUserSeek: vi.fn().mockResolvedValue(undefined),
      onUserRateChange: vi.fn().mockResolvedValue(undefined),
    };
    const video = document.createElement("video");
    const disconnect = connectPlayer(
      video,
      controller as unknown as SyncController,
    );
    await video.play();
    video.pause();
    video.currentTime = 12;
    video.playbackRate = 1.5;
    expect(controller.onUserPlay).toHaveBeenCalledTimes(1);
    expect(controller.onUserPause).toHaveBeenCalledTimes(1);
    expect(controller.onUserSeek).toHaveBeenCalledWith(12000);
    expect(controller.onUserRateChange).toHaveBeenCalledWith(1.5);
    await direct.play();
    direct.pause();
    direct.currentTime = 30;
    direct.playbackRate = 1.1;
    await Promise.resolve();
    for (const event of ["play", "pause", "seeking", "seeked", "ratechange"])
      video.dispatchEvent(new Event(event));
    expect(video.currentTime).toBe(30);
    expect(video.playbackRate).toBe(1.1);
    expect(controller.onUserSeek).toHaveBeenCalledTimes(1);
    expect(controller.onUserRateChange).toHaveBeenCalledTimes(1);
    expect(controller.onUserPlay).toHaveBeenCalledTimes(1);
    expect(controller.onUserPause).toHaveBeenCalledTimes(1);
    expect(nativePlay).toHaveBeenCalledOnce();
    expect(nativePause).toHaveBeenCalledOnce();
    disconnect();
    expect(controller.destroy).toHaveBeenCalledOnce();
    video.currentTime = 40;
    expect(video.currentTime).toBe(40);
    expect(controller.onUserSeek).toHaveBeenCalledTimes(1);
  });
});
