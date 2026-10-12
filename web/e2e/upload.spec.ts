import { expect, test } from "@playwright/test";

for (const missingETag of [false, true]) {
  test(`multipart upload ${missingETag ? "stops on missing ETag" : "completes shuffled parts once"}`, async ({
    page,
  }) => {
    let status = "";
    let starts = 0;
    let completes = 0;
    let aborts = 0;
    const uploaded: number[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = [];
      if (path.endsWith("/auth/me"))
        data = { id: "owner", nickname: "Test", guest: false };
      else if (path.endsWith("/auth/csrf")) data = { csrfToken: "test" };
      else if (path.endsWith("/storage/health"))
        data = { status: "ok", message: "OSS 存储桶连接正常", latencyMs: 1 };
      else if (path.endsWith("/uploads")) {
        starts++;
        status = "UPLOADING";
        data = { uploadId: "upload", mode: "multipart", partSizeBytes: 1 };
      } else if (path.endsWith("/parts")) {
        const numbers = route.request().postDataJSON().partNumbers as number[];
        data = {
          parts: [...numbers]
            .reverse()
            .map((partNumber) => ({
              partNumber,
              url: `https://oss.test/${partNumber}`,
            })),
        };
      } else if (path.endsWith("/complete")) {
        completes++;
        expect(
          route
            .request()
            .postDataJSON()
            .parts.map((p: { partNumber: number }) => p.partNumber),
        ).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
        status = "READY";
        data = { ready: true };
      } else if (route.request().method() === "DELETE") {
        aborts++;
        status = "FAILED";
        data = { aborted: true };
      } else if (path.endsWith("/media")) {
        data = status
          ? [
              {
                id: "media",
                originalFilename: "movie.mp4",
                sizeBytes: 12,
                status,
              },
            ]
          : [];
      }
      await route.fulfill({ json: { data } });
    });
    await page.route("https://oss.test/*", async (route) => {
      uploaded.push(Number(new URL(route.request().url()).pathname.slice(1)));
      await route.fulfill({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "ETag",
          ...(missingETag ? {} : { ETag: '"test"' }),
        },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "检测 OSS 连接" }).click();
    await expect(page.getByText("OSS 存储桶连接正常")).toBeVisible();
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: "movie.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("123456789012"),
      });
    if (missingETag) {
      await expect(page.getByText(/CORS 未暴露 ETag/)).toBeVisible();
      await expect(page.locator(".media-card")).toContainText("FAILED");
      expect(uploaded).toEqual([1]);
      expect(aborts).toBe(1);
      expect(completes).toBe(0);
    } else {
      await expect(page.getByText("上传完成", { exact: true })).toBeVisible();
      await expect(page.locator(".media-card")).toContainText("READY");
      expect(uploaded).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(completes).toBe(1);
      expect(aborts).toBe(0);
    }
    expect(starts).toBe(1);
    await expect(page.locator('input[type="file"]')).toBeEnabled();
    await expect(page.locator('input[type="file"]')).toHaveValue("");
  });
}
