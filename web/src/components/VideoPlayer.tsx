import { useEffect, useMemo, useRef } from "react";
import Artplayer from "artplayer";
import { createPortal } from "react-dom";
import { LiveBroadcastOverlay } from "./LiveBroadcastOverlay";
import type { RoomBroadcastStream } from "../realtime/RoomBroadcastStream";
import { connectPlayer } from "../player/PlayerAdapter";
import type { PlaybackState } from "../realtime/protocol";
import type { SyncController, SyncStatus } from "../player/SyncController";

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
  } catch {
    // Try the prefixed API before falling back to native video fullscreen.
  }

  try {
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

export function VideoPlayer({
  src,
  state,
  isHost,
  controller,
  syncStatus,
  syncStatusVisible,
  broadcasts,
  onSyncStatusToggle,
  onMediaError,
}: {
  src?: string;
  state?: PlaybackState;
  isHost: boolean;
  controller: SyncController;
  syncStatus: SyncStatus;
  syncStatusVisible: boolean;
  broadcasts: RoomBroadcastStream;
  onSyncStatusToggle: () => void;
  onMediaError?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Artplayer | null>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  // Keep one portal target for the lifetime of this room view. Moving it between
  // player roots preserves active broadcasts when media elements are recreated.
  const broadcastHost = useMemo(() => {
    const host = document.createElement("div");
    host.className = "room-broadcast-host";
    return host;
  }, []);
  const latest = useRef({
    onMediaError,
    onSyncStatusToggle,
  });
  latest.current = {
    onMediaError,
    onSyncStatusToggle,
  };
  useEffect(() => {
    if (!src || !container.current) {
      placeholder.current?.appendChild(broadcastHost);
      return;
    }
    const art = new Artplayer({
      container: container.current,
      url: src,
      lang: "zh-cn",
      autoplay: false,
      autoPlayback: false,
      mutex: false,
      hotkey: true,
      gesture: true,
      setting: true,
      playbackRate: true,
      pip: true,
      fullscreen: true,
      fullscreenWeb: false,
      playsInline: true,
      controls: [
        {
          name: "room-sync",
          position: "right",
          html: "同步",
          tooltip: "显示/隐藏同步状态",
          click: () => latest.current.onSyncStatusToggle(),
        },
        {
          name: "room-fullscreen",
          position: "right",
          html: "全屏",
          tooltip: "全屏",
          click: () => {
            void togglePlayerFullscreen(art.template.$player, art.video);
          },
        },
      ],
    });
    art.template.$player.classList.add("room-player");
    art.template.$player.appendChild(broadcastHost);
    // Remove the duplicate native fullscreen button through the component API,
    // rather than relying on CSS specificity against injected plugin styles.
    art.controls.remove("fullscreen");
    for (const name of ["room-sync", "room-fullscreen"]) {
      const control = art.controls[name] as HTMLElement;
      control.setAttribute("role", "button");
      control.tabIndex = 0;
      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          control.click();
        }
      });
    }
    player.current = art;
    const disconnect = connectPlayer(art.video, controller);
    art.on("video:error", () => latest.current.onMediaError?.());
    art.on("control", (visible) => {
      art.template.$player.classList.toggle("room-controls-hidden", !visible);
    });
    return () => {
      broadcastHost.remove();
      player.current = null;
      disconnect();
      art.destroy();
    };
    // Toggle/settings updates must not recreate the video or reset its timeline.
  }, [src, controller, broadcastHost]);
  useEffect(() => {
    if (state) controller.setRoomState(state);
  }, [state, controller, src]);
  useEffect(() => {
    const art = player.current;
    if (!art) return;
    art.template.$player.classList.toggle("room-member", !isHost);
  }, [isHost, src, controller]);
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
  useEffect(() => {
    const art = player.current;
    if (!art) return;
    art.controls["room-sync"]?.setAttribute(
      "aria-pressed",
      String(syncStatusVisible),
    );
    if (art.layers["room-status"]) art.layers.remove("room-status");
    if (syncStatus !== "autoplay-blocked" && !syncStatusVisible) return;
    const button = document.createElement("button");
    button.className = `sync-pill ${syncStatus}`;
    button.textContent = statusText;
    button.onclick = () => controller.resumeLocal();
    button.disabled = syncStatus !== "autoplay-blocked";
    art.layers.add({ name: "room-status", html: button });
  }, [syncStatus, syncStatusVisible, statusText, src, controller]);
  return (
    <section className="player-card third-party-player">
      {src ? (
        <div ref={container} className="artplayer-container" />
      ) : (
        <div className="video-stage" ref={placeholder}>
          <div className="empty-player">
            <span className="empty-glyph">▶</span>
            <p>等待房主选择影片</p>
          </div>
        </div>
      )}
      {createPortal(
        <LiveBroadcastOverlay stream={broadcasts} />,
        broadcastHost,
      )}
    </section>
  );
}
