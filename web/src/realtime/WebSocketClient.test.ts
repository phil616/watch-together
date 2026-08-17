import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketClient } from "./WebSocketClient";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  send(value: string) {
    this.sent.push(value);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  drop(code = 1006, reason = "") {
    this.close(code, reason);
  }
}

describe("WebSocketClient reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconnects with backoff and stops after an explicit disconnect", () => {
    const statuses: string[] = [];
    const client = new WebSocketClient("ABC23456", (status) =>
      statuses.push(status),
    );
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/ABC23456/ws");
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].drop();
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]);

    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    client.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect a connection superseded by another tab", () => {
    const statuses: string[] = [];
    const client = new WebSocketClient("ABC23456", (status) =>
      statuses.push(status),
    );

    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].drop(4001, "replaced by reconnect");
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "connected", "superseded"]);
  });

  it.each([
    [1008, "ROOM_CLOSED", "closed"],
    [1008, "FORBIDDEN", "forbidden"],
    [1008, "ROOM_FULL", "full"],
    [1000, "room closed", "closed"],
  ])(
    "does not reconnect a permanent close (%s %s)",
    (code, reason, expected) => {
      const statuses: string[] = [];
      const client = new WebSocketClient("ABC23456", (status) =>
        statuses.push(status),
      );
      client.connect();
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].drop(code as number, reason as string);
      vi.advanceTimersByTime(60_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(statuses.at(-1)).toBe(expected);
    },
  );

  it("ignores close events from a socket replaced during remount", () => {
    const statuses: string[] = [];
    const client = new WebSocketClient("ABC23456", (status) =>
      statuses.push(status),
    );

    client.connect();
    const stale = FakeWebSocket.instances[0];
    client.disconnect();
    client.connect();
    const current = FakeWebSocket.instances[1];
    current.open();

    stale.drop();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(current.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses.at(-1)).toBe("connected");
  });

  it("backs off repeated short-lived connections until one is stable", () => {
    const client = new WebSocketClient("ABC23456", () => {});
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].drop();

    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].drop();
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].open();
    vi.advanceTimersByTime(10_000);
    FakeWebSocket.instances[2].drop();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });
});
