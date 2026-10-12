import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { uploadMedia } from "./upload";

vi.mock("./client", () => ({ api: vi.fn(), json: JSON.stringify }));
const mockedAPI = vi.mocked(api);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function setup(count = 12) {
  const requests: number[][] = [];
  mockedAPI.mockImplementation(async (path, options) => {
    if (path === "/api/v1/media/uploads")
      return { uploadId: "upload", mode: "multipart", partSizeBytes: 1 };
    if (path.endsWith("/parts")) {
      const batch = JSON.parse(options!.body as string).partNumbers as number[];
      requests.push(batch);
      return {
        parts: [...batch]
          .reverse()
          .map((partNumber) => ({
            partNumber,
            url: `https://oss.test/${partNumber}`,
          })),
      };
    }
    return {};
  });
  const put = vi
    .fn()
    .mockResolvedValue(new Response(null, { headers: { ETag: '"etag"' } }));
  vi.stubGlobal("fetch", put);
  const file = new File(["x".repeat(count)], "movie.mp4", {
    type: "video/mp4",
  });
  return { file, put, requests };
}

describe("browser multipart upload", () => {
  it("uploads shuffled signatures once in order with monotonic progress across batches", async () => {
    const { file, put, requests } = setup(23);
    const progress = vi.fn();
    await uploadMedia(file, new AbortController().signal, progress);
    expect(put.mock.calls.map((call) => call[0])).toEqual(
      Array.from({ length: 23 }, (_, i) => `https://oss.test/${i + 1}`),
    );
    expect(requests.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(
      progress.mock.calls
        .filter(([text]) => text.startsWith("上传分片"))
        .map(([text]) => text),
    ).toEqual(
      Array.from(
        { length: 23 },
        (_, i) => `上传分片 ${i + 1}/23（已完成 ${i}）`,
      ),
    );
    const completions = mockedAPI.mock.calls.filter(([path]) =>
      path.endsWith("/complete"),
    );
    expect(completions).toHaveLength(1);
    expect(JSON.parse(completions[0][1]!.body as string).parts).toHaveLength(
      23,
    );
    expect(
      mockedAPI.mock.calls.filter(([path]) => path === "/api/v1/media/uploads"),
    ).toHaveLength(1);
  });
  it("stops on missing ETag, aborts unfinished upload, and never restarts", async () => {
    const { file, put } = setup();
    put.mockResolvedValue(new Response(null));
    await expect(
      uploadMedia(file, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("ETag");
    expect(put).toHaveBeenCalledTimes(1);
    expect(mockedAPI).toHaveBeenLastCalledWith(
      "/api/v1/media/uploads/upload",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
  it("does not delete or re-upload an object after an uncertain completion response", async () => {
    const { file, put } = setup(1);
    const implementation = mockedAPI.getMockImplementation()!;
    mockedAPI.mockImplementation((path, options) =>
      path.endsWith("/complete")
        ? Promise.reject(new DOMException("timeout", "TimeoutError"))
        : implementation(path, options),
    );
    await expect(
      uploadMedia(file, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("勿重复上传");
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      mockedAPI.mock.calls.some(([, options]) => options?.method === "DELETE"),
    ).toBe(false);
  });
  it("rejects duplicate or missing signed parts before uploading any bytes", async () => {
    const { file, put } = setup(2);
    const implementation = mockedAPI.getMockImplementation()!;
    mockedAPI.mockImplementation((path, options) =>
      path.endsWith("/parts")
        ? Promise.resolve({
            parts: [
              { partNumber: 1, url: "https://oss.test/1" },
              { partNumber: 1, url: "https://oss.test/1" },
            ],
          })
        : implementation(path, options),
    );
    await expect(
      uploadMedia(file, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("缺失或重复");
    expect(put).not.toHaveBeenCalled();
  });
});
