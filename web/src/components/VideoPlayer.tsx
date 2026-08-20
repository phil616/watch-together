import { useEffect, useRef, useState } from "react";
import type { PlaybackState } from "../realtime/protocol";
import type { ChatMessage } from "../types";
import type { SyncController, SyncStatus } from "../player/SyncController";
import { DanmakuOverlay } from "./DanmakuOverlay";

/** Format milliseconds as `m:ss` or `h:mm:ss`. */
const format = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000)),
    h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

type WebKitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebKitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebKitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

/** Toggle the custom player fullscreen, with native iPhone video as fallback. */
export async function togglePlayerFullscreen(
  player: HTMLElement,
  video?: HTMLVideoElement | null,
) {
  const fullscreenDocument = document as WebKitFullscreenDocument;
  if (
    fullscreenDocument.fullscreenElement ||
    fullscreenDocument.webkitFullscreenElement
  ) {
    try {
      if (fullscreenDocument.exitFullscreen)
        await fullscreenDocument.exitFullscreen();
      else await fullscreenDocument.webkitExitFullscreen?.();
    } catch {
      // The browser owns fullscreen state; a failed exit needs no local repair.
    }
    return;
  }

  try {
    if (
      fullscreenDocument.fullscreenEnabled !== false &&
      player.requestFullscreen
    ) {
      await player.requestFullscreen({ navigationUI: "hide" });
      return;
    }

    const webkitPlayer = player as WebKitFullscreenElement;
    if (webkitPlayer.webkitRequestFullscreen) {
      await webkitPlayer.webkitRequestFullscreen();
      return;
    }
  } catch {
    // Some WebKit versions expose element fullscreen but reject it on iPhone.
  }

  if (!video) return;
  const webkitVideo = video as WebKitFullscreenVideo;
  try {
    if (webkitVideo.webkitEnterFullscreen) {
      webkitVideo.webkitEnterFullscreen();
      return;
    }
    await video.requestFullscreen?.({ navigationUI: "hide" });
  } catch {
    // Fullscreen is best-effort and can be denied by browser or system policy.
  }
}

/** Player controls, video element, danmaku overlay, and sync status pill. */
export function VideoPlayer({
  src,
  state,
  isHost,
  controller,
  syncStatus,
  syncStatusVisible,
  danmakuMessages,
  danmakuEnabled,
  onSyncStatusToggle,
  onDanmakuToggle,
  onMediaError,
}: {
  src?: string;
  state?: PlaybackState;
  isHost: boolean;
  controller: SyncController;
  syncStatus: SyncStatus;
  syncStatusVisible: boolean;
  danmakuMessages: ChatMessage[];
  danmakuEnabled: boolean;
  onSyncStatusToggle: () => void;
  onDanmakuToggle: () => void;
  onMediaError?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState(0);
  const [volume, setVolume] = useState(1);
  const [scrub, setScrub] = useState<number>();
  useEffect(() => {
    if (!ref.current) return;
    controller.attach(ref.current);
    return () => controller.destroy();
  }, [controller, src]);
  useEffect(() => {
    const id = setInterval(
      () => setCurrent((ref.current?.currentTime ?? 0) * 1000),
      250,
    );
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (state) controller.setRoomState(state);
  }, [state, controller]);
  const duration =
    state?.durationMs || (ref.current?.duration ?? 0) * 1000 || 0;
  const toggle = () => {
    if (!ref.current) return;
    if (state?.phase === "playing") controller.onUserPause().catch(() => {});
    else controller.onUserPlay().catch(() => {});
  };
  const statusText =
    syncStatus === "synced"
      ? "● 已同步"
      : syncStatus === "correcting"
        ? "● 正在平滑校准"
        : syncStatus === "local-buffering"
          ? "网络缓冲中，已暂停校准……"
          : syncStatus === "host-buffering"
            ? "房主缓冲中，等待统一恢复……"
            : "浏览器阻止了自动播放，点击继续";
  return (
    <section className="player-card" ref={playerRef}>
      <div className="video-stage" ref={stageRef}>
        {src ? (
          <video
            ref={ref}
            src={src}
            preload="metadata"
            playsInline
            onError={onMediaError}
          />
        ) : (
          <div className="empty-player">
            <span className="empty-glyph">▶</span>
            <p>等待房主选择影片</p>
          </div>
        )}
        <DanmakuOverlay messages={danmakuMessages} enabled={danmakuEnabled} />
        {syncStatus === "autoplay-blocked" ? (
          <button
            className={`sync-pill ${syncStatus}`}
            onClick={() => controller.resumeLocal()}
          >
            {statusText}
          </button>
        ) : syncStatusVisible ? (
          <div className={`sync-pill ${syncStatus}`}>{statusText}</div>
        ) : null}
      </div>
      <div className="controls">
        {isHost && (
          <button
            className="control-main"
            onClick={toggle}
            aria-label={state?.phase === "playing" ? "暂停" : "播放"}
          >
            {state?.phase === "playing" ? "Ⅱ" : "▶"}
          </button>
        )}
        <span className="timecode">
          {format(scrub ?? current)} / {format(duration)}
        </span>
        {isHost && (
          <input
            aria-label="播放进度"
            className="timeline"
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={100}
            value={scrub ?? current}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={() => {
              if (scrub !== undefined)
                controller.onUserSeek(scrub).finally(() => setScrub(undefined));
            }}
            onKeyUp={(e) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) &&
                scrub !== undefined
              )
                controller.onUserSeek(scrub).finally(() => setScrub(undefined));
            }}
          />
        )}
        <label className="volume">
          <span>音量</span>
          <input
            aria-label="音量"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              if (ref.current) ref.current.volume = v;
            }}
          />
        </label>
        {isHost && (
          <select
            aria-label="公共播放倍速"
            value={state?.playbackRate ?? 1}
            onChange={(e) =>
              controller.onUserRateChange(Number(e.target.value))
            }
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        )}
        <button
          className={`ghost small danmaku-toggle${danmakuEnabled ? " active" : ""}`}
          type="button"
          aria-label={danmakuEnabled ? "关闭弹幕" : "开启弹幕"}
          aria-pressed={danmakuEnabled}
          onClick={onDanmakuToggle}
        >
          <span aria-hidden="true">弹</span>
          {danmakuEnabled ? "弹幕开" : "弹幕关"}
        </button>
        <button
          className={`ghost small sync-status-toggle${syncStatusVisible ? " active" : ""}`}
          type="button"
          aria-label={syncStatusVisible ? "隐藏同步状态" : "显示同步状态"}
          aria-pressed={syncStatusVisible}
          onClick={onSyncStatusToggle}
        >
          <span aria-hidden="true">同</span>
          {syncStatusVisible ? "同步状态开" : "同步状态关"}
        </button>
        <button
          className="ghost small pip-button"
          type="button"
          onClick={() => ref.current?.requestPictureInPicture?.()}
          aria-label="画中画"
        >
          PiP
        </button>
        <button
          className="ghost small fullscreen-button"
          type="button"
          onClick={() => {
            if (playerRef.current)
              void togglePlayerFullscreen(playerRef.current, ref.current);
          }}
          aria-label="全屏"
        >
          全屏
        </button>
      </div>
    </section>
  );
}
