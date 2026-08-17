type Sample = { rtt: number; offset: number };

const MAX_SAMPLES = 12;
const MAX_VALID_RTT_MS = 5000;
const OFFSET_NOISE_FLOOR_MS = 8;
const MAX_OFFSET_STEP_MS = 25;
const OFFSET_SMOOTHING = 0.2;

export class ClockSynchronizer {
  private samples: Sample[] = [];
  private pending = new Map<number, number>();
  private offset = Date.now() - performance.now();

  constructor(private monoNow = () => performance.now()) {}

  pingPayload() {
    const now = this.monoNow();
    this.pending.set(now, now);
    return { clientMonoMs: now };
  }

  acceptPong(payload: {
    clientMonoMs: number;
    serverRecvUnixMs: number;
    serverSendUnixMs: number;
  }) {
    const clientSend = this.pending.get(payload.clientMonoMs);
    if (clientSend === undefined) return;
    this.pending.delete(payload.clientMonoMs);

    const clientReceive = this.monoNow();
    const serverProcessing =
      payload.serverSendUnixMs - payload.serverRecvUnixMs;
    const rtt = clientReceive - clientSend - serverProcessing;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_VALID_RTT_MS) return;

    const offset =
      (payload.serverRecvUnixMs -
        clientSend +
        (payload.serverSendUnixMs - clientReceive)) /
      2;
    this.samples.push({ rtt, offset });
    this.samples.sort((a, b) => a.rtt - b.rtt);
    this.samples = this.samples.slice(0, MAX_SAMPLES);

    const best = this.samples
      .slice(0, Math.min(5, this.samples.length))
      .map((sample) => sample.offset)
      .sort((a, b) => a - b);
    const candidate = best[Math.floor(best.length / 2)];

    // The first NTP sample establishes the clock. Later samples are slewed in
    // small steps so a noisy route change cannot move the playback target by
    // hundreds of milliseconds in one synchronization tick.
    if (this.samples.length === 1) {
      this.offset = candidate;
      return;
    }
    const delta = candidate - this.offset;
    if (Math.abs(delta) <= OFFSET_NOISE_FLOOR_MS) return;
    const step = Math.max(
      -MAX_OFFSET_STEP_MS,
      Math.min(MAX_OFFSET_STEP_MS, delta * OFFSET_SMOOTHING),
    );
    this.offset += step;
  }

  serverNow() {
    return this.monoNow() + this.offset;
  }

  reset() {
    this.samples = [];
    this.pending.clear();
    this.offset = Date.now() - this.monoNow();
  }

  get sampleCount() {
    return this.samples.length;
  }
}
