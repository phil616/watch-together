import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());
it("does not treat an interrupted completion response as success", async () => {
  const controller = new AbortController();
  const timeout = new DOMException("timeout", "TimeoutError");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort(timeout);
        throw timeout;
      },
    }),
  );
  await expect(api("/complete", { signal: controller.signal })).rejects.toThrow(
    "timeout",
  );
});
it("passes cancellation through the CSRF bootstrap request", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn().mockRejectedValue(controller.signal.reason);
  vi.stubGlobal("fetch", fetch);
  await expect(
    api("/upload", { method: "POST", signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/auth/csrf",
    expect.objectContaining({ signal: controller.signal }),
  );
});
