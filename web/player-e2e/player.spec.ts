import { devices, expect, test } from "@playwright/test";
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
    const inputBounds = await page
      .getByRole("textbox", { name: "播放器消息输入" })
      .boundingBox();
    expect(inputBounds!.width).toBeGreaterThan(65);
    expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(width);
    expect(inputBounds!.y + inputBounds!.height).toBeLessThanOrEqual(height);
    await expect(
      page.getByRole("textbox", { name: "播放器消息输入" }),
    ).toBeVisible();
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
  await page.mouse.move(250, 170);
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "1");
  await page
    .getByRole("textbox", { name: "播放器消息输入" })
    .fill("全屏直接发消息");
  await page.getByRole("textbox", { name: "播放器消息输入" }).press("Enter");
  await expectBroadcastPainted(page, "全屏直接发消息");
  await expect
    .poll(() => page.evaluate(() => (window as any).calls))
    .toContainEqual(["chat.send", "全屏直接发消息"]);
  await page.evaluate(
    () => document.fullscreenElement && document.exitFullscreen(),
  );
});

test("typing and submitting in the player never triggers media shortcuts or recreates the video", async ({
  page,
}) => {
  await page.goto("/player-e2e/");
  const video = await page.locator("video").elementHandle();
  const input = page.getByRole("textbox", { name: "播放器消息输入" });
  await input.fill("hello");
  await input.press("End");
  await input.press("Space");
  await input.press("f");
  await input.press("ArrowLeft");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as any).calls))
    .toEqual([["chat.send", "hello f"]]);
  await expect(input).toHaveValue("");
  expect(await video!.evaluate((el) => el.isConnected)).toBe(true);
  await input.fill("换源时保留草稿");
  await page.getByRole("button", { name: "切换来源", exact: true }).click();
  await expect(input).toHaveValue("换源时保留草稿");
});

test("desktop double click includes the native chat control in fullscreen", async ({
  page,
}) => {
  await page.goto("/player-e2e/");
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  await page.locator("video").dblclick({ position: { x: 80, y: 80 } });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains("room-player"),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("textbox", { name: "播放器消息输入" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "播放器消息输入" })
    .fill("全屏换源保留");
  await page.evaluate(() =>
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === "切换来源")
      ?.click(),
  );
  await expect(
    page.getByRole("textbox", { name: "播放器消息输入" }),
  ).toHaveValue("全屏换源保留");
  await page.evaluate(
    () => document.fullscreenElement && document.exitFullscreen(),
  );
});

test("chat is inside native controls, shares idle hiding, and stays visible for keyboard editing", async ({
  page,
}) => {
  await page.goto("/player-e2e/");
  const input = page.getByRole("textbox", { name: "播放器消息输入" });
  expect(
    await input.evaluate(
      (el) => !!el.closest(".art-controls-right .art-control-room-chat"),
    ),
  ).toBe(true);
  expect(await page.locator(".player-card > .player-chat").count()).toBe(0);
  await page.evaluate(async () => {
    const video = (window as any).direct;
    video.muted = true;
    await video.play();
  });
  await page.mouse.move(200, 150);
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "0", {
    timeout: 6000,
  });
  await page.mouse.move(240, 170);
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "1");
  // Programmatic focus models entering with Tab, without ArtPlayer's click-only
  // isInput bookkeeping. Focus must prevent the library's idle hide attempt.
  await input.focus();
  await page.mouse.move(260, 180);
  await page.waitForTimeout(3500);
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "1");
  await input.fill("保持输入");
  await input.evaluate((el) => (el as HTMLInputElement).blur());
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "0", {
    timeout: 6000,
  });
  await page.mouse.move(280, 200);
  await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "1");
  await expect(input).toHaveValue("保持输入");
});

test("mobile native controls fit the canvas and wake together on touch", async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    baseURL,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.route("**/missing.mp4*", (route) =>
      route.fulfill({ contentType: "video/webm", body: media }),
    );
    await page.goto("/player-e2e/");
    await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
    const input = page.getByRole("textbox", { name: "播放器消息输入" });
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box!.width).toBeGreaterThan(65);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(
      await input.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return (
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) ===
          el
        );
      }),
    ).toBe(true);
    await page.locator("video").tap({ position: { x: 100, y: 90 } });
    await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "0");
    await page.waitForTimeout(350);
    await page.locator("video").tap({ position: { x: 110, y: 90 } });
    await expect(page.locator(".art-bottom")).toHaveCSS("opacity", "1");
    await input.tap();
    await input.fill("手机控制栏发消息");
    await page.getByRole("button", { name: "播放器发送", exact: true }).tap();
    await expectBroadcastPainted(page, "手机控制栏发消息");
    await page.screenshot({
      path: testInfo.outputPath("native-chat-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
});
