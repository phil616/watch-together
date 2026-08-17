import type { PlaybackState } from "../realtime/protocol";
import type { WebSocketClient } from "../realtime/WebSocketClient";
import {
  DriftCorrector,
  POST_SEEK_SETTLE_MS,
  type Correction,
} from "./DriftCorrector";
import { acceptRevision, expectedPosition } from "./PlaybackModel";

export const SYNC_CHECK_INTERVAL_MS = 750;
export const HOST_HEARTBEAT_INTERVAL_MS = 5000;
export const BUFFER_CONFIRM_MS = 1800;
export const BUFFER_RECOVERY_STABLE_MS = 600;
export const PROGRAMMATIC_SEEK_BUFFER_GRACE_MS = 2500;

const TIMELINE_JUMP_MS = 1000;
const ALIGN_ON_TRANSITION_MS = 750;
const CORRECTION_STATUS_DELAY_MS = 2000;

export type SyncStatus =
  | "synced"
  | "correcting"
  | "local-buffering"
  | "host-buffering"
  | "autoplay-blocked";

/** Drives the local video element from room playback state and drift. */
export class SyncController {
  private video?: HTMLVideoElement;
  private state?: PlaybackState;
  private lastRevision = -1;
  private tickTimer?: number;
  private heartbeatTimer?: number;
  private playTimer?: number;
  private bufferConfirmTimer?: number;
  private recoveryTimer?: number;
  private pendingSeek?: number;
  private applyingRemoteState = false;
  private bufferSuspected = false;
  private confirmedBuffering = false;
  private hostBufferingReported = false;
  private memberBufferingReported = false;
  private ignoreBufferUntil = 0;
  private recoveryUntil = 0;
  private softCorrectionSince?: number;
  private autoplayBlocked = false;
  private currentStatus?: SyncStatus;
  private readonly drift = new DriftCorrector();

  constructor(
    private ws: WebSocketClient,
    private isHost: boolean,
    private status: (s: SyncStatus) => void,
  ) {}

  attach(video: HTMLVideoElement) {
    this.video = video;
    video.addEventListener("waiting", this.waiting);
    video.addEventListener("stalled", this.waiting);
    video.addEventListener("canplay", this.canPlay);
    video.addEventListener("playing", this.canPlay);
    video.addEventListener("progress", this.retrySeek);
    video.addEventListener("loadedmetadata", this.loadedMetadata);
    video.addEventListener("pause", this.nativePause);
    video.addEventListener("ended", this.ended);
    this.tickTimer = window.setInterval(
      () => this.tick(),
      SYNC_CHECK_INTERVAL_MS,
    );
    this.updateHeartbeat();
    if (this.state) this.apply(undefined, true);
  }

  setRoomState(next: PlaybackState, force = false) {
    if (!force && !acceptRevision(this.lastRevision, next.revision)) return;
    const previous = this.state;
    this.lastRevision = next.revision;
    this.state = next;
    this.apply(previous, force);
  }

  setHost(value: boolean) {
    if (this.isHost === value) return;
    this.isHost = value;
    const now = performance.now();
    this.drift.reset(now, POST_SEEK_SETTLE_MS);
    this.softCorrectionSince = undefined;
    this.updateHeartbeat();
    if (this.video && this.state) this.apply(undefined, true);
  }

  async onUserPlay() {
    if (!this.isHost || !this.video) return;
    this.autoplayBlocked = false;
    await this.ws.send("cmd.playback.play", {
      positionMs: Math.round(this.video.currentTime * 1000),
    });
  }

  async onUserPause() {
    if (!this.isHost || !this.video) return;
    this.cancelScheduledPlay();
    this.video.pause();
    await this.ws.send("cmd.playback.pause", {
      positionMs: Math.round(this.video.currentTime * 1000),
    });
  }

  async onUserSeek(positionMs: number) {
    if (!this.isHost) return;
    this.seek(positionMs);
    if (this.state?.phase === "playing") this.video?.pause();
    await this.ws.send("cmd.playback.seek", {
      positionMs: Math.round(positionMs),
    });
  }

  async onUserRateChange(playbackRate: number) {
    if (!this.isHost) return;
    if (this.video) this.video.playbackRate = playbackRate;
    await this.ws.send("cmd.playback.rate", {
      playbackRate,
      positionMs: Math.round((this.video?.currentTime ?? 0) * 1000),
    });
  }

  resumeLocal() {
    this.autoplayBlocked = false;
    this.tryPlay();
  }

  realign() {
    if (this.state) this.apply(undefined, true);
  }

  suspend() {
    if (!this.isHost) this.video?.pause();
  }

  destroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.cancelScheduledPlay();
    if (this.bufferConfirmTimer) clearTimeout(this.bufferConfirmTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const video = this.video;
    if (video) {
      video.removeEventListener("waiting", this.waiting);
      video.removeEventListener("stalled", this.waiting);
      video.removeEventListener("canplay", this.canPlay);
      video.removeEventListener("playing", this.canPlay);
      video.removeEventListener("progress", this.retrySeek);
      video.removeEventListener("loadedmetadata", this.loadedMetadata);
      video.removeEventListener("pause", this.nativePause);
      video.removeEventListener("ended", this.ended);
    }
    this.video = undefined;
    this.tickTimer = undefined;
    this.heartbeatTimer = undefined;
    this.bufferConfirmTimer = undefined;
    this.recoveryTimer = undefined;
  }

  private apply(previous?: PlaybackState, force = false) {
    const video = this.video;
    const state = this.state;
    if (!video || !state) return;

    const serverNow = this.ws.clock.serverNow();
    const target = expectedPosition(state, serverNow);
    const mediaChanged = !!previous && previous.mediaId !== state.mediaId;
    const phaseChanged = !previous || previous.phase !== state.phase;
    const timelineJump = this.isTimelineJump(previous, state);
    const shouldAlign = force || mediaChanged || timelineJump;

    this.applyingRemoteState = true;
    video.playbackRate = state.playbackRate;

    // The host's media element is the physical reference. Anchor refreshes
    // from its own heartbeat must never seek it. Members align only for a
    // snapshot/media change or a real timeline discontinuity.
    if (
      shouldAlign &&
      (!this.isHost || force || mediaChanged) &&
      state.phase !== "buffering" &&
      state.phase !== "loading" &&
      Math.abs(video.currentTime * 1000 - target) >= ALIGN_ON_TRANSITION_MS
    ) {
      this.seek(target);
    }

    if (state.phase === "playing") {
      if (phaseChanged || force || timelineJump) {
        this.schedulePlay(state.anchorServerTimeMs);
      }
      if (phaseChanged) {
        this.recoveryUntil = performance.now() + POST_SEEK_SETTLE_MS;
        this.drift.reset(performance.now(), POST_SEEK_SETTLE_MS);
      }
    } else {
      this.cancelScheduledPlay();
      video.pause();
      video.playbackRate = state.playbackRate;
      this.softCorrectionSince = undefined;
      this.drift.reset(performance.now());
      if (state.phase === "buffering") {
        this.emitStatus(this.isHost ? "local-buffering" : "host-buffering");
        if (
          this.isHost &&
          this.hostBufferingReported &&
          video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
        ) {
          this.scheduleRecovery();
        }
      } else {
        this.emitStatus("synced");
      }
    }
    queueMicrotask(() => (this.applyingRemoteState = false));
  }

  private tick() {
    const video = this.video;
    const state = this.state;
    if (!video || !state || video.readyState < HTMLMediaElement.HAVE_METADATA)
      return;

    if (state.phase !== "playing") return;
    if (this.ws.clock.serverNow() + 20 < state.anchorServerTimeMs) return;
    if (
      this.bufferSuspected ||
      this.confirmedBuffering ||
      video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      video.playbackRate = state.playbackRate;
      return;
    }

    if (this.isHost) {
      video.playbackRate = state.playbackRate;
      this.emitStatus("synced");
      if (video.paused && !this.applyingRemoteState) this.tryPlay();
      return;
    }

    const now = performance.now();
    if (now < this.recoveryUntil) {
      video.playbackRate = state.playbackRate;
      this.emitStatus("synced");
      if (video.paused) this.tryPlay();
      return;
    }

    const expected = expectedPosition(state, this.ws.clock.serverNow());
    const action = this.drift.correct(
      expected,
      video.currentTime * 1000,
      state.playbackRate,
      now,
    );
    this.applyCorrection(action, now);
    if (video.paused) this.tryPlay();
  }

  private applyCorrection(action: Correction, now: number) {
    const video = this.video;
    if (!video) return;
    video.playbackRate = action.rate;

    if (action.type === "HARD_SEEK" && action.targetMs !== undefined) {
      this.softCorrectionSince = undefined;
      this.emitStatus("correcting");
      this.seek(action.targetMs);
      return;
    }
    if (action.type === "NOOP") {
      this.softCorrectionSince = undefined;
      this.emitStatus("synced");
      return;
    }

    if (this.softCorrectionSince === undefined) this.softCorrectionSince = now;
    this.emitStatus(
      now - this.softCorrectionSince >= CORRECTION_STATUS_DELAY_MS
        ? "correcting"
        : "synced",
    );
  }

  private isTimelineJump(
    previous: PlaybackState | undefined,
    next: PlaybackState,
  ) {
    if (!previous || previous.mediaId !== next.mediaId) return true;
    if ((previous.timelineEpoch ?? 0) !== (next.timelineEpoch ?? 0))
      return true;
    if (previous.phase === "playing" && next.phase === "playing") {
      // A heartbeat refresh may move the anchor substantially after a long
      // host stall, but it keeps the same epoch and must be smoothed rather
      // than interpreted as an explicit user seek.
      return false;
    }
    return (
      previous.phase === next.phase &&
      Math.abs(previous.anchorPositionMs - next.anchorPositionMs) >=
        TIMELINE_JUMP_MS
    );
  }

  private schedulePlay(anchorServerTimeMs: number) {
    this.cancelScheduledPlay();
    const delay = Math.max(0, anchorServerTimeMs - this.ws.clock.serverNow());
    if (delay > 20 && this.video && !this.video.paused) this.video.pause();
    this.playTimer = window.setTimeout(() => {
      this.playTimer = undefined;
      if (!this.confirmedBuffering && this.state?.phase === "playing")
        this.tryPlay();
    }, delay);
  }

  private cancelScheduledPlay() {
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = undefined;
  }

  private tryPlay() {
    const video = this.video;
    if (!video || this.autoplayBlocked || this.confirmedBuffering) return;
    video
      .play()
      .then(() => {
        this.autoplayBlocked = false;
      })
      .catch(() => {
        this.autoplayBlocked = true;
        this.emitStatus("autoplay-blocked");
      });
  }

  private seek(ms: number) {
    const video = this.video;
    if (!video || !Number.isFinite(ms)) return;
    const seconds = Math.max(0, ms / 1000);
    if (Math.abs(video.currentTime - seconds) < 0.05) {
      this.pendingSeek = undefined;
      return;
    }

    const perform = () => {
      try {
        video.currentTime = seconds;
        this.pendingSeek = undefined;
        const now = performance.now();
        this.ignoreBufferUntil = now + PROGRAMMATIC_SEEK_BUFFER_GRACE_MS;
        this.recoveryUntil = now + POST_SEEK_SETTLE_MS;
        this.drift.reset(now, POST_SEEK_SETTLE_MS);
      } catch {
        this.pendingSeek = ms;
      }
    };

    for (let i = 0; i < video.seekable.length; i++) {
      if (
        seconds >= video.seekable.start(i) - 0.05 &&
        seconds <= video.seekable.end(i) + 0.05
      ) {
        perform();
        return;
      }
    }
    this.pendingSeek = ms;
    if (
      video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      Number.isFinite(video.duration) &&
      seconds <= video.duration
    ) {
      perform();
    }
  }

  private retrySeek = () => {
    if (this.pendingSeek !== undefined) this.seek(this.pendingSeek);
  };

  private loadedMetadata = () => {
    this.retrySeek();
    const video = this.video;
    const state = this.state;
    if (video && state?.mediaId) {
      this.ws
        .send("client.ready", {
          mediaId: state.mediaId,
          ready: true,
          durationMs: Math.round(video.duration * 1000),
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        .catch(() => {});
    }
  };

  private waiting = () => {
    const video = this.video;
    const state = this.state;
    if (
      !video ||
      state?.phase !== "playing" ||
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    )
      return;

    this.bufferSuspected = true;
    video.playbackRate = state.playbackRate;
    this.softCorrectionSince = undefined;
    this.drift.reset(performance.now());
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.bufferConfirmTimer) return;

    const delay = Math.max(
      BUFFER_CONFIRM_MS,
      this.ignoreBufferUntil - performance.now(),
    );
    this.bufferConfirmTimer = window.setTimeout(() => {
      this.bufferConfirmTimer = undefined;
      const current = this.video;
      if (
        !current ||
        this.state?.phase !== "playing" ||
        current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
      ) {
        this.bufferSuspected = false;
        return;
      }

      this.confirmedBuffering = true;
      this.emitStatus("local-buffering");
      if (this.isHost && !this.hostBufferingReported) {
        this.hostBufferingReported = true;
        current.pause();
        this.ws
          .send("cmd.playback.host_buffering", {
            positionMs: Math.round(current.currentTime * 1000),
          })
          .catch(() => {
            this.hostBufferingReported = false;
          });
      } else if (!this.isHost && !this.memberBufferingReported) {
        this.memberBufferingReported = true;
        this.ws
          .send(
            "telemetry.member.playback",
            {
              positionMs: Math.round(current.currentTime * 1000),
              buffering: true,
            },
            false,
          )
          .catch(() => {});
      }
    }, delay);
  };

  private canPlay = () => {
    if (this.bufferConfirmTimer) {
      clearTimeout(this.bufferConfirmTimer);
      this.bufferConfirmTimer = undefined;
    }
    this.bufferSuspected = false;
    if (!this.confirmedBuffering) {
      this.tick();
      return;
    }
    this.scheduleRecovery();
  };

  private scheduleRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = undefined;
      const video = this.video;
      const state = this.state;
      if (
        !video ||
        !state ||
        this.bufferSuspected ||
        video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      )
        return;

      // Data may recover before the server has processed the host's buffering
      // command. Keep the host paused until the authoritative buffering state
      // arrives; that state will schedule this stability check again.
      if (
        this.isHost &&
        this.hostBufferingReported &&
        state.phase !== "buffering"
      ) {
        this.confirmedBuffering = true;
        return;
      }

      this.confirmedBuffering = false;
      const now = performance.now();
      this.recoveryUntil = now + POST_SEEK_SETTLE_MS;
      this.drift.reset(now, POST_SEEK_SETTLE_MS);
      if (this.isHost && this.hostBufferingReported) {
        if (state.phase === "buffering") {
          this.ws
            .send("cmd.playback.host_ready", {
              positionMs: Math.round(video.currentTime * 1000),
            })
            .then(() => {
              this.hostBufferingReported = false;
            })
            .catch(() => {
              this.confirmedBuffering = true;
            });
        }
      } else if (!this.isHost && this.memberBufferingReported) {
        this.memberBufferingReported = false;
        this.ws
          .send(
            "telemetry.member.playback",
            {
              positionMs: Math.round(video.currentTime * 1000),
              buffering: false,
            },
            false,
          )
          .catch(() => {});
      }
      this.emitStatus(
        state.phase === "buffering" ? "host-buffering" : "synced",
      );
      if (state.phase === "playing") this.tryPlay();
    }, BUFFER_RECOVERY_STABLE_MS);
  }

  private nativePause = () => {
    if (
      !this.isHost &&
      !this.applyingRemoteState &&
      !this.confirmedBuffering &&
      this.state?.phase === "playing"
    )
      this.tryPlay();
  };

  private ended = () => {
    if (this.isHost && this.video) {
      this.ws
        .send("cmd.playback.ended", {
          positionMs: Math.round(this.video.duration * 1000),
        })
        .catch(() => {});
    }
  };

  private heartbeat() {
    const video = this.video;
    if (!video) return;
    this.ws
      .send(
        "telemetry.host.playback",
        {
          positionMs: Math.round(video.currentTime * 1000),
          paused: video.paused,
          readyState: video.readyState,
        },
        false,
      )
      .catch(() => {});
  }

  private updateHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.isHost && this.video) {
      this.heartbeatTimer = window.setInterval(
        () => this.heartbeat(),
        HOST_HEARTBEAT_INTERVAL_MS,
      );
    }
  }

  private emitStatus(next: SyncStatus) {
    if (this.autoplayBlocked && next !== "autoplay-blocked") return;
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    this.status(next);
  }
}
