import { expect, test } from "@playwright/test";
import path from "node:path";

test("fullscreen player fills the viewport after rotating to landscape", async ({
  context,
  page,
}) => {
  await page.setContent(`
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <section class="player-card">
      <div class="video-stage"><video></video></div>
      <div class="controls"><button type="button">全屏</button></div>
    </section>
  `);
  await page.addStyleTag({ path: path.resolve("src/styles.css") });
  await page.getByRole("button", { name: "全屏" }).evaluate((button) => {
    button.addEventListener("click", () => {
      void document
        .querySelector<HTMLElement>(".player-card")
        ?.requestFullscreen();
    });
  });
  await page.getByRole("button", { name: "全屏" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("player-card");

  const chrome = await context.newCDPSession(page);
  // Rotation and browser bars changing the available height must both resize
  // the picture, including small landscape devices below the 700px breakpoint.
  for (const [width, height] of [
    [844, 390],
    [844, 340],
    [844, 390],
    [568, 320],
    [390, 844],
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
      .poll(() =>
        page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(".player-card")!;
          const stage = document.querySelector<HTMLElement>(".video-stage")!;
          const video = stage.querySelector("video")!;
          const bounds = (el: Element) => {
            const { x, y, width, height } = el.getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            card: bounds(card),
            stage: bounds(stage),
            video: bounds(video),
            maxHeight: getComputedStyle(stage).maxHeight,
          };
        }),
      )
      .toEqual({
        card: { x: 0, y: 0, width, height },
        stage: { x: 0, y: 0, width, height },
        video: { x: 0, y: 0, width, height },
        maxHeight: "none",
      });
  }
  await page.evaluate(() => document.exitFullscreen());
  await expect
    .poll(() =>
      page
        .locator(".video-stage")
        .evaluate((el) => getComputedStyle(el).aspectRatio),
    )
    .toBe("16 / 9");
});

test("prefixed fullscreen layout and hidden bars leave the complete canvas available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.setContent(`
    <section class="player-card is-fullscreen controls-hidden">
      <div class="video-stage"><video></video><div class="sync-pill">已同步</div></div>
      <div class="controls"><button>退出全屏</button></div>
    </section>
  `);
  await page.addStyleTag({ path: path.resolve("src/styles.css") });
  await expect(page.locator(".controls")).toHaveCSS("opacity", "0");
  await expect(page.locator(".sync-pill")).toHaveCSS("opacity", "0");
  expect(await page.locator(".video-stage").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 568,
    height: 320,
  });
  await page
    .locator(".player-card")
    .evaluate((el) => el.classList.remove("controls-hidden"));
  await expect(page.locator(".controls")).toHaveCSS("opacity", "1");
  expect(await page.locator(".video-stage").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 568,
    height: 320,
  });
});
