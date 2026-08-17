import { ClockSynchronizer } from "../player/ClockSynchronizer";
import { parseEnvelope, PROTOCOL_VERSION, type Envelope } from "./protocol";

type Listener = (message: Envelope) => void;
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "superseded"
  | "closed"
  | "forbidden"
  | "full";
type Pending = {
  resolve: () => void;
  reject: (e: Error) => void;
  timeout: number;
};

const CONNECTION_SUPERSEDED = 4001;
const STABLE_CONNECTION_MS = 10_000;

/** WebSocket client with auto-reconnect, acknowledgements, and clock sync. */
export class WebSocketClient {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private stableTimer?: number;
  private attempts = 0;
  private stopped = true;
  private listeners = new Set<Listener>();
  private pending = new Map<string, Pending>();
  private resyncTimer?: number;
  readonly clock = new ClockSynchronizer();
  constructor(
    private roomRef: string,
    private onStatus: (s: ConnectionStatus) => void,
  ) {}
  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  disconnect() {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "leaving room");
    this.rejectPending("Disconnected");
  }
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private open() {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.onStatus("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/v1/rooms/${encodeURIComponent(this.roomRef)}/ws`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.onStatus("connected");
      this.clock.reset();
      this.sampleClock();
      if (this.resyncTimer) clearInterval(this.resyncTimer);
      this.resyncTimer = window.setInterval(() => this.sampleClock(), 30000);
      this.stableTimer = window.setTimeout(() => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN)
          this.attempts = 0;
      }, STABLE_CONNECTION_MS);
    };
    socket.onmessage = (e) => {
      if (this.socket === socket && !this.stopped) this.receive(String(e.data));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.lost(event);
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
  }
  private lost(event: CloseEvent) {
    if (this.stopped) return;
    this.clearConnectionTimers();
    this.rejectPending("Connection lost");
    let terminal: ConnectionStatus | undefined;
    if (
      event.code === CONNECTION_SUPERSEDED ||
      event.reason === "replaced by reconnect"
    )
      terminal = "superseded";
    else if (event.reason === "ROOM_CLOSED" || event.reason === "room closed")
      terminal = "closed";
    else if (
      event.reason === "FORBIDDEN" ||
      event.reason === "removed from room"
    )
      terminal = "forbidden";
    else if (event.reason === "ROOM_FULL") terminal = "full";
    if (terminal) {
      this.stopped = true;
      this.onStatus(terminal);
      return;
    }
    this.onStatus("disconnected");
    const base = Math.min(10000, 1000 * 2 ** this.attempts++);
    this.reconnectTimer = window.setTimeout(
      () => this.open(),
      base * (0.8 + Math.random() * 0.4),
    );
  }
  private receive(raw: string) {
    try {
      const message = parseEnvelope(raw);
      if (message.type === "clock.pong")
        this.clock.acceptPong(
          message.payload as Parameters<ClockSynchronizer["acceptPong"]>[0],
        );
      for (const listener of this.listeners) listener(message);
      if (
        message.requestId &&
        (message.type === "ack" || message.type === "error")
      ) {
        const p = this.pending.get(message.requestId);
        if (p) {
          clearTimeout(p.timeout);
          this.pending.delete(message.requestId);
          message.type === "ack"
            ? p.resolve()
            : p.reject(
                new Error(
                  (message.payload as { message?: string })?.message ??
                    "Command rejected",
                ),
              );
        }
      }
    } catch (e) {
      console.warn("Dropped invalid realtime message", e);
    }
  }
  /** Send a command and optionally wait for the server acknowledgement. */
  send(type: string, payload: unknown = {}, ack = true) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Connection unavailable"));
    const requestId = crypto.randomUUID();
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        requestId,
        roomId: undefined,
        payload,
      }),
    );
    if (!ack) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Command acknowledgement timed out"));
      }, 6000);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
  }
  private sampleClock() {
    for (let i = 0; i < 5; i++)
      window.setTimeout(
        () =>
          this.send("clock.ping", this.clock.pingPayload(), false).catch(
            () => {},
          ),
        i * 120,
      );
  }
  private rejectPending(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  private clearConnectionTimers() {
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.resyncTimer = undefined;
    this.stableTimer = undefined;
  }
  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearConnectionTimers();
  }
}
