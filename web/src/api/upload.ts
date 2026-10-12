import { api, json } from "./client";

type UploadInit = {
  uploadId: string;
  mode: "single" | "multipart";
  partSizeBytes?: number;
  url?: string;
};
type Part = { partNumber: number; url: string };

/** Every request has a deadline; no automatic restart can create another upload. */
export async function uploadMedia(
  file: File,
  signal: AbortSignal,
  progress: (text: string) => void,
) {
  const request = <T>(path: string, options: RequestInit) =>
    api<T>(path, {
      ...options,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
  let uploadId: string | undefined;
  let completing = false;
  try {
    progress("正在申请上传…");
    const init = await request<UploadInit>("/api/v1/media/uploads", {
      method: "POST",
      body: json({
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type || "video/mp4",
      }),
    });
    uploadId = init.uploadId;
    if (!uploadId) throw new Error("上传服务返回了无效的上传编号");
    const parts: { partNumber: number; etag: string }[] = [];
    const put = async (url: string, body: Blob, contentType?: string) => {
      const response = await fetch(url, {
        method: "PUT",
        body,
        headers: contentType ? { "Content-Type": contentType } : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      });
      if (!response.ok)
        throw new Error(
          `OSS 上传失败 (${response.status})，请检查签名、权限和跨域配置`,
        );
      return response;
    };
    if (init.mode === "single") {
      if (!init.url) throw new Error("上传服务未返回上传地址");
      progress("正在直传对象存储…");
      await put(init.url, file, file.type || "video/mp4");
    } else if (init.mode === "multipart") {
      const size = init.partSizeBytes;
      if (!size || !Number.isSafeInteger(size) || size <= 0)
        throw new Error("上传服务返回了无效的分片大小");
      const count = Math.ceil(file.size / size);
      if (count > 10000) throw new Error("影片分片数量超过上限");
      // Fetch only a small batch so later signatures do not expire during a long upload.
      for (let offset = 0; offset < count; offset += 10) {
        const batch = Array.from(
          { length: Math.min(10, count - offset) },
          (_, i) => offset + i + 1,
        );
        const signed = await request<{ parts: Part[] }>(
          `/api/v1/media/uploads/${uploadId}/parts`,
          {
            method: "POST",
            body: json({ partNumbers: batch }),
          },
        );
        const ordered = [...signed.parts].sort(
          (a, b) => a.partNumber - b.partNumber,
        );
        if (
          ordered.length !== batch.length ||
          ordered.some((p, i) => p.partNumber !== batch[i] || !p.url)
        )
          throw new Error("上传服务返回的分片列表缺失或重复，已停止上传");
        for (const p of ordered) {
          progress(
            `上传分片 ${parts.length + 1}/${count}（已完成 ${parts.length}）`,
          );
          const response = await put(
            p.url,
            file.slice(
              (p.partNumber - 1) * size,
              Math.min(file.size, p.partNumber * size),
            ),
          );
          const etag = response.headers.get("ETag");
          if (!etag)
            throw new Error(
              "对象存储 CORS 未暴露 ETag 响应头，请配置 ExposeHeaders: ETag",
            );
          parts.push({ partNumber: p.partNumber, etag });
        }
      }
    } else throw new Error("上传服务返回了无效的上传模式");
    signal.throwIfAborted();
    progress("分片传输完成，正在合并并校验媒体…");
    completing = true;
    await request(`/api/v1/media/uploads/${uploadId}/complete`, {
      method: "POST",
      body: json({ parts }),
    });
    progress("上传完成");
  } catch (error) {
    // A lost completion response may mean the object is already READY. Never
    // delete it automatically or restart the complete file in that situation.
    if (uploadId && !completing) {
      await api(`/api/v1/media/uploads/${uploadId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    const detail = signal.aborted
      ? "上传已取消"
      : (error as Error).name === "TimeoutError"
        ? "上传请求超时，请检查网络与 OSS 健康状态"
        : (error as Error).message;
    throw new Error(
      completing
        ? `${detail}；合并结果未确认，请刷新影片列表确认状态，勿重复上传`
        : detail,
    );
  }
}
