import { expect, test } from "@playwright/test";
import { expectBroadcastPainted } from "../e2e/assertions/broadcast";
import { execFileSync } from "node:child_process";
const media = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:r=10",
  "-t",
  "20",
  "-c:v",
  "libvpx",
  "-f",
  "webm",
  "pipe:1",
]);
test.beforeEach(async ({ page }) => {
  await page.route("**/missing.mp4*", (route) =>
    route.fulfill({ contentType: "video/webm", body: media }),
  );
});

test("player controls route through sync while broadcasts survive source recreation", async ({
  page,
}) => {
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/player-e2e/");
  const video = await page.locator("video").elementHandle();
  await page.locator(".art-control-playAndPause").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls))
    .toEqual(["play"]);
  await expect(
    page.locator(".artplayer-plugin-danmuku,.art-control-room-danmaku"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "发送测试广播" }).click();
  const card = await page.locator(".live-broadcast").elementHandle();
  await expectBroadcastPainted(page, "聊天框实时广播");
  await page.clock.fastForward(6000);
  await page.locator(".art-control-room-sync").click();
  await page.getByText("切换来源", { exact: true }).click();
  expect(await video!.evaluate((el) => el.isConnected)).toBe(false);
  expect(await card!.evaluate((el) => el.isConnected)).toBe(true);
  await page.clock.fastForward(2100);
  await expect(page.locator(".live-broadcast")).toHaveCount(0);
  await page.getByText("切换身份", { exact: true }).click();
  await expect(page.locator(".art-control-playAndPause")).toBeHidden();
  expect(errors).toEqual([]);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`broadcasts are mandatory without a video and never replay (${reducedMotion})`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(() =>
      localStorage.setItem("movie-sync:danmaku", "off"),
    );
    await page.goto("/player-e2e/?empty");
    await expect(page.locator("video")).toHaveCount(0);
    await page.getByRole("button", { name: "发送测试广播" }).click();
    await expect(page.locator(".live-broadcast")).toContainText(
      "聊天框实时广播",
    );
    await page.clock.fastForward(8100);
    await expect(page.locator(".live-broadcast")).toHaveCount(0);
    await page.getByText("切换来源", { exact: true }).click();
    await expect(page.locator("video")).toHaveCount(1);
    await page.evaluate(() =>
      (window as any).broadcasts.receive({
        id: "broadcast-0",
        senderNickname: "测试用户",
        content: "duplicate",
      }),
    );
    await expect(page.locator(".live-broadcast")).toHaveCount(0);
  });
}

test("pause, buffering, playback rate and backward seeks never stop or replay broadcasts", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/player-e2e/");
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  await page.getByRole("button", { name: "发送测试广播" }).click();
  await expect(page.locator(".live-broadcast")).toBeVisible();
  await page.evaluate(() => {
    const video = (window as any).direct as HTMLVideoElement;
    video.currentTime = 10;
    video.playbackRate = 2;
    video.pause();
    document.querySelector("video")!.dispatchEvent(new Event("waiting"));
  });
  await page.clock.fastForward(8100);
  await expect(page.locator(".live-broadcast")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).direct.currentTime = 0;
  });
  await page.clock.fastForward(1000);
  await expect(page.locator(".live-broadcast")).toHaveCount(0);
});

test("fullscreen canvas resizes and idle controls do not hide live broadcasts", async ({
  page,
}) => {
  await page.goto("/player-e2e/");
  await page.locator(".art-control-room-fullscreen").click();
  const chrome = await page.context().newCDPSession(page);
  for (const [width, height] of [
    [844, 390],
    [568, 320],
    [390, 844],
    [844, 340],
  ]) {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
    await expect
      .poll(() => page.locator(".art-video-player").boundingBox())
      .toEqual({ x: 0, y: 0, width, height });
  }
  await page.evaluate(async () => {
    const video = (window as any).direct as HTMLVideoElement;
    video.muted = true;
    await video.play();
  });
  // Publish while in fullscreen via the same event stream, with controls idle.
  await page.evaluate(() =>
    (window as any).broadcasts.receive({
      id: "fullscreen",
      senderNickname: "A",
      content: "全屏广播",
    }),
  );
  await page.mouse.move(200, 150);
  await expect(page.locator(".art-video-player")).toHaveClass(
    /room-controls-hidden/,
    { timeout: 6000 },
  );
  await expect(page.locator(".sync-pill")).toHaveCSS("opacity", "0");
  await expect(page.locator(".live-broadcast")).toContainText("全屏广播");
  await expectBroadcastPainted(page, "全屏广播");
  await expect(page.locator(".live-broadcast")).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
});
