import { describe, expect, it } from "vitest";
import {
  DRIFT_RELEASE_MS,
  DriftCorrector,
  HARD_SEEK_CONFIRM_MS,
  HARD_SEEK_COOLDOWN_MS,
  POST_SEEK_SETTLE_MS,
} from "./DriftCorrector";

describe("anti-jitter drift correction", () => {
  it("ignores clock and playback jitter inside the entry deadband", () => {
    const controller = new DriftCorrector();
    for (const drift of [-390, -180, 0, 210, 390]) {
      expect(controller.correct(10_000, 10_000 + drift, 1, 1000).type).toBe(
        "NOOP",
      );
    }
  });

  it("uses hysteresis until the drift returns to the smaller release band", () => {
    const controller = new DriftCorrector();
    expect(controller.correct(10_000, 9500, 1, 0).type).toBe("SOFT_SPEED_UP");
    expect(controller.correct(10_000, 9700, 1, 500).type).toBe("SOFT_SPEED_UP");
    expect(
      controller.correct(10_000, 10_000 + DRIFT_RELEASE_MS, 1, 1000).type,
    ).toBe("NOOP");
    expect(controller.correct(10_000, 9700, 1, 1500).type).toBe("NOOP");
  });

  it("requires sustained same-direction drift before a hard seek", () => {
    const controller = new DriftCorrector();
    expect(controller.correct(10_000, 7000, 1, 0).type).toBe("SOFT_SPEED_UP");
    expect(
      controller.correct(10_000, 7000, 1, HARD_SEEK_CONFIRM_MS - 1).type,
    ).toBe("SOFT_SPEED_UP");
    expect(controller.correct(10_000, 7000, 1, HARD_SEEK_CONFIRM_MS).type).toBe(
      "HARD_SEEK",
    );
  });

  it("cancels a hard-seek candidate when jitter reverses direction", () => {
    const controller = new DriftCorrector();
    controller.correct(10_000, 7000, 1, 0);
    controller.correct(10_000, 13_000, 1, 1200);
    expect(controller.correct(10_000, 13_000, 1, 2000).type).not.toBe(
      "HARD_SEEK",
    );
    expect(
      controller.correct(10_000, 13_000, 1, 1200 + HARD_SEEK_CONFIRM_MS).type,
    ).toBe("HARD_SEEK");
  });

  it("holds corrections after seeking and enforces a seek cooldown", () => {
    const controller = new DriftCorrector();
    controller.correct(10_000, 7000, 1, 0);
    controller.correct(10_000, 7000, 1, HARD_SEEK_CONFIRM_MS);
    expect(
      controller.correct(
        10_000,
        7000,
        1,
        HARD_SEEK_CONFIRM_MS + POST_SEEK_SETTLE_MS - 1,
      ).type,
    ).toBe("NOOP");

    const retryAt = HARD_SEEK_CONFIRM_MS + POST_SEEK_SETTLE_MS;
    controller.correct(10_000, 7000, 1, retryAt);
    expect(
      controller.correct(10_000, 7000, 1, retryAt + HARD_SEEK_CONFIRM_MS).type,
    ).not.toBe("HARD_SEEK");

    const afterCooldown = HARD_SEEK_CONFIRM_MS + HARD_SEEK_COOLDOWN_MS;
    expect(controller.correct(10_000, 7000, 1, afterCooldown).type).toBe(
      "HARD_SEEK",
    );
  });

  it("keeps proportional rate changes small", () => {
    const behind = new DriftCorrector().correct(10_000, 9000, 1.5, 0);
    const ahead = new DriftCorrector().correct(10_000, 11_000, 1.5, 0);
    expect(behind.rate).toBeGreaterThan(1.5);
    expect(behind.rate).toBeLessThanOrEqual(1.575);
    expect(ahead.rate).toBeLessThan(1.5);
    expect(ahead.rate).toBeGreaterThanOrEqual(1.455);
  });
});
