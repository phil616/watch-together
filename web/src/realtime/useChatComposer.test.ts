import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatComposer } from "./useChatComposer";
afterEach(cleanup);
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("shared room chat draft", () => {
  it("sends once while pending and clears both entry points only after ACK", async () => {
    const ack = deferred();
    const ws = { send: vi.fn(() => ack.promise) };
    const { result } = renderHook(() => useChatComposer(ws, true));
    act(() => result.current.onDraftChange("一起看"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.onSend();
      void result.current.onSend();
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith("chat.send", { content: "一起看" });
    expect(result.current.draft).toBe("一起看");
    expect(result.current.sending).toBe(true);
    await act(async () => {
      ack.resolve();
      await pending;
    });
    expect(result.current.draft).toBe("");
    expect(result.current.sending).toBe(false);
  });
  it("preserves a new draft typed while the previous message is acknowledged", async () => {
    const ack = deferred();
    const ws = { send: () => ack.promise };
    const { result } = renderHook(() => useChatComposer(ws, true));
    act(() => result.current.onDraftChange("first"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.onSend();
    });
    act(() => result.current.onDraftChange("next"));
    await act(async () => {
      ack.resolve();
      await pending;
    });
    expect(result.current.draft).toBe("next");
  });
  it("keeps rejected content and reports the failure without retrying", async () => {
    const ws = { send: vi.fn().mockRejectedValue(new Error("发送过于频繁")) };
    const { result } = renderHook(() => useChatComposer(ws, true));
    act(() => result.current.onDraftChange("保留这条消息"));
    await act(async () => {
      await result.current.onSend();
    });
    expect(result.current.draft).toBe("保留这条消息");
    expect(result.current.error).toBe("发送过于频繁");
    expect(result.current.sending).toBe(false);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
  it("disables disconnected sends, keeps the draft through reconnect, and ignores whitespace", async () => {
    const ws = { send: vi.fn().mockResolvedValue(undefined) };
    const { result, rerender } = renderHook(
      ({ online }) => useChatComposer(ws, online),
      { initialProps: { online: true } },
    );
    act(() => result.current.onDraftChange("重连后发送"));
    rerender({ online: false });
    await act(async () => {
      await result.current.onSend();
    });
    expect(ws.send).not.toHaveBeenCalled();
    expect(result.current.disabled).toBe(true);
    rerender({ online: true });
    expect(result.current.draft).toBe("重连后发送");
    act(() => result.current.onDraftChange("  "));
    await act(async () => {
      await result.current.onSend();
    });
    expect(ws.send).not.toHaveBeenCalled();
  });
  it("does not clear a different room's draft when the old ACK arrives", async () => {
    const ack = deferred();
    const first = { send: vi.fn(() => ack.promise) };
    const second = { send: vi.fn(() => ack.promise) };
    const { result, rerender } = renderHook(
      ({ ws }) => useChatComposer(ws, true),
      { initialProps: { ws: first } },
    );
    act(() => result.current.onDraftChange("旧房间"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.onSend();
    });
    rerender({ ws: second });
    expect(result.current.draft).toBe("");
    act(() => result.current.onDraftChange("新房间"));
    await act(async () => {
      ack.resolve();
      await pending;
    });
    expect(result.current.draft).toBe("新房间");
  });
});
