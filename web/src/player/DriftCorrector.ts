export const DRIFT_RELEASE_MS = 220;
export const SOFT_CORRECTION_THRESHOLD_MS = 420;
export const HARD_SEEK_THRESHOLD_MS = 2400;
export const HARD_SEEK_CONFIRM_MS = 1800;
export const HARD_SEEK_COOLDOWN_MS = 12000;
export const POST_SEEK_SETTLE_MS = 3500;

export type Correction = {
  type: "NOOP" | "SOFT_SPEED_UP" | "SOFT_SLOW_DOWN" | "HARD_SEEK";
  rate: number;
  driftMs: number;
  targetMs?: number;
};

/**
 * Stateful drift controller with hysteresis. A single noisy clock/media sample
 * can request a tiny rate change, but it can never cause a seek. Large drift
 * must remain in the same direction before a seek is allowed.
 */
export class DriftCorrector {
  private correcting = false;
  private hardCandidateSince?: number;
  private hardCandidateDirection = 0;
  private lastHardSeekAt = Number.NEGATIVE_INFINITY;
  private holdUntil = 0;

  correct(
    expectedMs: number,
    actualMs: number,
    roomRate: number,
    nowMs: number,
  ): Correction {
    const driftMs = actualMs - expectedMs;
    const absoluteDrift = Math.abs(driftMs);

    if (nowMs < this.holdUntil) {
      return { type: "NOOP", rate: roomRate, driftMs };
    }

    if (absoluteDrift <= DRIFT_RELEASE_MS) {
      this.correcting = false;
      this.clearHardCandidate();
      return { type: "NOOP", rate: roomRate, driftMs };
    }

    if (!this.correcting && absoluteDrift < SOFT_CORRECTION_THRESHOLD_MS) {
      this.clearHardCandidate();
      return { type: "NOOP", rate: roomRate, driftMs };
    }

    this.correcting = true;
    if (absoluteDrift >= HARD_SEEK_THRESHOLD_MS) {
      const direction = Math.sign(driftMs);
      if (direction !== this.hardCandidateDirection) {
        this.hardCandidateDirection = direction;
        this.hardCandidateSince = nowMs;
      }
      if (
        this.hardCandidateSince !== undefined &&
        nowMs - this.hardCandidateSince >= HARD_SEEK_CONFIRM_MS &&
        nowMs - this.lastHardSeekAt >= HARD_SEEK_COOLDOWN_MS
      ) {
        this.lastHardSeekAt = nowMs;
        this.holdUntil = nowMs + POST_SEEK_SETTLE_MS;
        this.correcting = false;
        this.clearHardCandidate();
        return {
          type: "HARD_SEEK",
          rate: roomRate,
          driftMs,
          targetMs: expectedMs,
        };
      }
    } else {
      this.clearHardCandidate();
    }

    // Behind clients can catch up slightly faster than ahead clients slow
    // down. The adjustment is proportional and intentionally capped so audio
    // pitch/tempo changes remain unobtrusive.
    const scale = Math.min(
      1,
      Math.max(
        0,
        (absoluteDrift - DRIFT_RELEASE_MS) /
          (HARD_SEEK_THRESHOLD_MS - DRIFT_RELEASE_MS),
      ),
    );
    if (driftMs < 0) {
      const factor = 0.008 + scale * 0.042;
      return {
        type: "SOFT_SPEED_UP",
        rate: roomRate * (1 + factor),
        driftMs,
      };
    }
    const factor = 0.006 + scale * 0.024;
    return {
      type: "SOFT_SLOW_DOWN",
      rate: roomRate * (1 - factor),
      driftMs,
    };
  }

  reset(nowMs: number, settleMs = 0) {
    this.correcting = false;
    this.clearHardCandidate();
    this.holdUntil = Math.max(this.holdUntil, nowMs + settleMs);
  }

  private clearHardCandidate() {
    this.hardCandidateSince = undefined;
    this.hardCandidateDirection = 0;
  }
}
