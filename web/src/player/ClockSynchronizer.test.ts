import { describe, expect, it } from "vitest";
import { ClockSynchronizer } from "./ClockSynchronizer";

describe("clock synchronization", () => {
  it("uses the NTP midpoint for the initial offset", () => {
    let now = 100;
    const clock = new ClockSynchronizer(() => now);
    const ping = clock.pingPayload();
    now = 140;
    clock.acceptPong({
      clientMonoMs: ping.clientMonoMs,
      serverRecvUnixMs: 1110,
      serverSendUnixMs: 1112,
    });
    expect(clock.serverNow()).toBeCloseTo(1131, 0);
    expect(clock.sampleCount).toBe(1);
  });

  it("ignores unknown and implausibly slow pong samples", () => {
    let now = 100;
    const clock = new ClockSynchronizer(() => now);
    clock.acceptPong({
      clientMonoMs: 1,
      serverRecvUnixMs: 2,
      serverSendUnixMs: 3,
    });
    expect(clock.sampleCount).toBe(0);

    const ping = clock.pingPayload();
    now = 6000;
    clock.acceptPong({
      clientMonoMs: ping.clientMonoMs,
      serverRecvUnixMs: 2000,
      serverSendUnixMs: 2001,
    });
    expect(clock.sampleCount).toBe(0);
  });

  it("slews later clock changes instead of jumping the playback target", () => {
    let now = 100;
    const clock = new ClockSynchronizer(() => now);
    let ping = clock.pingPayload();
    now = 140;
    clock.acceptPong({
      clientMonoMs: ping.clientMonoMs,
      serverRecvUnixMs: 1110,
      serverSendUnixMs: 1110,
    });
    const first = clock.serverNow();

    // Two low-latency samples agree on an offset about 200 ms away. The
    // median changes, but each accepted update is capped at a 25 ms step.
    ping = clock.pingPayload();
    now += 40;
    clock.acceptPong({
      clientMonoMs: ping.clientMonoMs,
      serverRecvUnixMs: 1350,
      serverSendUnixMs: 1350,
    });
    ping = clock.pingPayload();
    now += 40;
    clock.acceptPong({
      clientMonoMs: ping.clientMonoMs,
      serverRecvUnixMs: 1390,
      serverSendUnixMs: 1390,
    });
    const elapsed = now - 140;
    expect(clock.serverNow() - first - elapsed).toBeLessThanOrEqual(50);
  });
});
