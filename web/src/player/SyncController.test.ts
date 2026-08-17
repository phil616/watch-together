// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState } from "../realtime/protocol";
import type { WebSocketClient } from "../realtime/WebSocketClient";
import {
  BUFFER_CONFIRM_MS,
  BUFFER_RECOVERY_STABLE_MS,
  SyncController,
  type SyncStatus,
} from "./SyncController";

function playback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    mediaId: "media",
    revision: 1,
    timelineEpoch: 0,
    phase: "playing",
    anchorPositionMs: 10_000,
    anchorServerTimeMs: 100_000,
    playbackRate: 1,
    durationMs: 120_000,
    ...overrides,
  };
}

function mediaElement(current = 10) {
  const video = document.createElement("video");
  let currentTime = current;
  let readyState: number = HTMLMediaElement.HAVE_ENOUGH_DATA;
  let paused = false;
  let seekWrites = 0;
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        seekWrites++;
      },
    },
    readyState: { configurable: true, get: () => readyState },
    duration: { configurable: true, get: () => 120 },
    paused: { configurable: true, get: () => paused },
    seekable: {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 120 }),
    },
  });
  video.play = vi.fn(async () => {
    paused = false;
  });
  video.pause = vi.fn(() => {
    paused = true;
  });
  return {
    video,
    setReadyState: (value: number) => {
      readyState = value;
    },
    seekWrites: () => seekWrites,
  };
}

function socket(serverNow = 100_000) {
  const send = vi.fn(async () => {});
  return {
    send,
    client: {
      send,
      clock: { serverNow: () => serverNow },
    } as unknown as WebSocketClient,
  };
}

describe("SyncController anti-jitter integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("never seeks the host in response to a heartbeat anchor refresh", () => {
    const { client } = socket();
    const media = mediaElement();
    const controller = new SyncController(client, true, vi.fn());
    controller.setRoomState(playback(), true);
    controller.attach(media.video);

    controller.setRoomState(
      playback({
        revision: 2,
        anchorPositionMs: 7000,
        anchorServerTimeMs: 101_000,
      }),
    );
    expect(media.seekWrites()).toBe(0);
    controller.destroy();
  });

  it("does not seek a member for an anchor refresh in the same epoch", () => {
    const { client } = socket();
    const media = mediaElement();
    const controller = new SyncController(client, false, vi.fn());
    controller.setRoomState(playback(), true);
    controller.attach(media.video);

    controller.setRoomState(
      playback({
        revision: 2,
        anchorPositionMs: 7000,
        anchorServerTimeMs: 101_000,
      }),
    );
    expect(media.seekWrites()).toBe(0);
    controller.destroy();
  });

  it("immediately aligns a member after an explicit timeline epoch", () => {
    const { client } = socket();
    const media = mediaElement();
    const controller = new SyncController(client, false, vi.fn());
    controller.setRoomState(playback(), true);
    controller.attach(media.video);

    controller.setRoomState(
      playback({
        revision: 2,
        timelineEpoch: 1,
        anchorPositionMs: 20_000,
        anchorServerTimeMs: 101_000,
      }),
    );
    expect(media.seekWrites()).toBe(1);
    controller.destroy();
  });

  it("filters a transient waiting event without announcing buffering", () => {
    const { client, send } = socket();
    const statuses: SyncStatus[] = [];
    const media = mediaElement();
    const controller = new SyncController(client, false, (status) =>
      statuses.push(status),
    );
    controller.setRoomState(playback(), true);
    controller.attach(media.video);

    media.setReadyState(HTMLMediaElement.HAVE_CURRENT_DATA);
    media.video.dispatchEvent(new Event("waiting"));
    vi.advanceTimersByTime(BUFFER_CONFIRM_MS - 1);
    media.setReadyState(HTMLMediaElement.HAVE_FUTURE_DATA);
    media.video.dispatchEvent(new Event("canplay"));
    vi.advanceTimersByTime(BUFFER_RECOVERY_STABLE_MS);

    expect(statuses).not.toContain("local-buffering");
    expect(send).not.toHaveBeenCalledWith(
      "telemetry.member.playback",
      expect.objectContaining({ buffering: true }),
      false,
    );
    controller.destroy();
  });

  it("reports host buffering only after it persists", async () => {
    const { client, send } = socket();
    const media = mediaElement();
    const controller = new SyncController(client, true, vi.fn());
    controller.setRoomState(playback(), true);
    controller.attach(media.video);

    media.setReadyState(HTMLMediaElement.HAVE_CURRENT_DATA);
    media.video.dispatchEvent(new Event("waiting"));
    vi.advanceTimersByTime(BUFFER_CONFIRM_MS - 1);
    expect(send).not.toHaveBeenCalledWith(
      "cmd.playback.host_buffering",
      expect.anything(),
    );
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith("cmd.playback.host_buffering", {
      positionMs: 10_000,
    });
    expect(media.video.pause).toHaveBeenCalledTimes(1);

    // Local data recovery must not restart the host before the server has
    // entered the authoritative buffering phase.
    const playCalls = vi.mocked(media.video.play).mock.calls.length;
    media.setReadyState(HTMLMediaElement.HAVE_FUTURE_DATA);
    media.video.dispatchEvent(new Event("canplay"));
    await vi.advanceTimersByTimeAsync(BUFFER_RECOVERY_STABLE_MS);
    expect(media.video.play).toHaveBeenCalledTimes(playCalls);
    expect(send).not.toHaveBeenCalledWith(
      "cmd.playback.host_ready",
      expect.anything(),
    );

    controller.setRoomState(
      playback({ revision: 2, phase: "buffering", resumeIntent: "playing" }),
    );
    await vi.advanceTimersByTimeAsync(BUFFER_RECOVERY_STABLE_MS);
    expect(send).toHaveBeenCalledWith("cmd.playback.host_ready", {
      positionMs: 10_000,
    });
    controller.destroy();
  });
});
