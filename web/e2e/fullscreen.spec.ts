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
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width: 844,
    height: 390,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 844,
    screenHeight: 390,
  });

  const boxes = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".player-card")!;
    const stage = document.querySelector<HTMLElement>(".video-stage")!;
    return {
      card: card.getBoundingClientRect().toJSON(),
      stage: stage.getBoundingClientRect().toJSON(),
      maxHeight: getComputedStyle(stage).maxHeight,
    };
  });

  expect(boxes.maxHeight).toBe("none");
  expect(boxes.stage.width).toBe(boxes.card.width);
  expect(boxes.stage.height).toBe(boxes.card.height);
});
