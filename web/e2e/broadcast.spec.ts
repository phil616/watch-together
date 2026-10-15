import { provisionUser } from "./accounts";
import { expect, test, type Page } from "@playwright/test";
import { expectBroadcastPainted } from "./assertions/broadcast";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "room-broadcast-"));
const mediaPath = path.join(directory, "broadcast.webm");
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=navy:s=640x360:r=15",
  "-t",
  "60",
  "-c:v",
  "libvpx",
  mediaPath,
]);
const media = readFileSync(mediaPath);
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function visibleBroadcast(page: Page, text: string) {
  await expect(
    page.locator(".message-bubble").getByText(text, { exact: true }),
  ).toBeVisible();
  await expectBroadcastPainted(page, text);
}

// This checks the real WebSocket -> room -> overlay path with two independent
// browsers, including messages delivered when there is no playable media.
test("room broadcasts reach everyone immediately and never follow the media timeline", async ({
  page: host,
  browser,
}) => {
  const errors: string[] = [];
  host.on("pageerror", (error) => errors.push(error.message));
  await host.context().grantPermissions(["clipboard-write"]);
  await host.addInitScript(() =>
    localStorage.setItem("movie-sync:danmaku", "off"),
  );
  await provisionUser(
    host,
    `broadcast-${Date.now()}`,
    "local-broadcast-regression",
    "广播回归",
  );
  await host.locator("input[type=file]").setInputFiles({
    name: "broadcast.webm",
    mimeType: "video/webm",
    buffer: media,
  });
  await expect(host.getByText("上传完成")).toBeVisible({ timeout: 30000 });
  await host.getByLabel("房间标题").fill("实时广播回归");
  await host.getByRole("button", { name: "创建并进入" }).click();
  await host.getByRole("button", { name: "复制邀请链接" }).click();
  const invite = (await host.locator(".invite-url").textContent())!;
  const memberContext = await browser.newContext({ reducedMotion: "reduce" });
  await memberContext.addInitScript(() => {
    localStorage.setItem("movie-sync:danmaku", "off");
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).testSocket = this;
      }
    };
  });
  const member = await memberContext.newPage();
  member.on("pageerror", (error) => errors.push(error.message));
  await member.goto(invite);
  await member.getByLabel("观影昵称").fill("广播成员");
  await member.getByRole("button", { name: "进入放映室" }).click();
  await expect(member.getByText("实时连接", { exact: false })).toBeVisible();
  const send = async (text: string, fromPlayer = false) => {
    const input = host.getByLabel(fromPlayer ? "播放器消息输入" : "聊天消息", {
      exact: true,
    });
    await input.fill(text);
    if (await host.locator("video").count()) {
      await expect(
        host.getByLabel(fromPlayer ? "聊天消息" : "播放器消息输入", {
          exact: true,
        }),
      ).toHaveValue(text);
    }
    await host
      .getByRole("button", {
        name: fromPlayer ? "播放器发送" : "发送消息",
        exact: true,
      })
      .click();
    await expect(input).toHaveValue("");
  };

  await expect(host.locator("video")).toHaveCount(0);
  await expect(member.locator("video")).toHaveCount(0);
  await send("未选择影片也必须收到广播");
  await visibleBroadcast(host, "未选择影片也必须收到广播");
  await visibleBroadcast(member, "未选择影片也必须收到广播");
  const oldCard = await member.locator(".live-broadcast").elementHandle();
  await host.getByLabel("切换影片").selectOption({ label: "broadcast.webm" });
  await expect(member.locator("video")).toHaveCount(1);
  expect(await oldCard!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(member.locator("video")).toHaveJSProperty("paused", true);
  await send("暂停时广播不能等待播放");
  await visibleBroadcast(host, "暂停时广播不能等待播放");
  await visibleBroadcast(member, "暂停时广播不能等待播放");
  await expect(
    host.locator(".apd-toggle,.apd-config,.art-control-room-danmaku"),
  ).toHaveCount(0);

  await host.locator(".art-control-playAndPause").click();
  const continueButton = member.getByRole("button", {
    name: /浏览器阻止了自动播放/,
  });
  if (await continueButton.isVisible()) await continueButton.click();
  // Wait for the asynchronous loading/buffering transition to finish before
  // using a toggle to request pause; a toggle during startup may request play.
  await expect(host.locator("video")).toHaveJSProperty("paused", false);
  await expect(member.locator("video")).toHaveJSProperty("paused", false);
  await expect
    .poll(() =>
      host
        .locator("video")
        .evaluate((v) => (v as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0.5);
  await send("播放中实时广播");
  await visibleBroadcast(member, "播放中实时广播");
  await host.locator(".art-control-playAndPause").click();
  await expect(member.locator("video")).toHaveJSProperty("paused", true);
  // A member can chat from the player even without host playback permission.
  await member.getByRole("tab", { name: /成员/ }).click();
  await member.getByLabel("播放器消息输入").fill("成员从播放器回复");
  await member.getByRole("tab", { name: /聊天/ }).click();
  await expect(member.getByLabel("聊天消息", { exact: true })).toHaveValue(
    "成员从播放器回复",
  );
  await member.getByRole("button", { name: "播放器发送", exact: true }).click();
  await visibleBroadcast(host, "成员从播放器回复");
  await expect(
    host
      .locator(".message-bubble")
      .getByText("成员从播放器回复", { exact: true }),
  ).toHaveCount(1);
  await expect(member.getByLabel("聊天消息", { exact: true })).toHaveValue("");

  // The whole frame enters fullscreen so the composer remains usable; messages
  // still go through the real WebSocket and appear once in both room logs.
  const video = await host.locator("video").elementHandle();
  await host.locator(".art-control-room-fullscreen").click();
  await expect
    .poll(() =>
      host.evaluate(() =>
        document.fullscreenElement?.classList.contains("room-player"),
      ),
    )
    .toBe(true);
  await host.getByLabel("播放器消息输入").fill("全屏发送到聊天室");
  await host.getByLabel("播放器消息输入").press("Enter");
  await expectBroadcastPainted(host, "全屏发送到聊天室");
  await visibleBroadcast(member, "全屏发送到聊天室");
  await host.screenshot({
    path: test.info().outputPath("fullscreen-chat.png"),
    animations: "disabled",
  });
  await host.evaluate(() => document.exitFullscreen());
  expect(await video!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(
    host
      .locator(".message-bubble")
      .getByText("全屏发送到聊天室", { exact: true }),
  ).toHaveCount(1);
  // Receive-time expiry must proceed even while the video remains paused.
  await expect(member.locator(".live-broadcast")).toHaveCount(0, {
    timeout: 10000,
  });
  await host.locator("video").evaluate((video) => {
    (video as HTMLVideoElement).currentTime = 0;
  });
  await expect(member.locator(".live-broadcast")).toHaveCount(0);
  await member.reload();
  await expect(
    member
      .locator(".message-bubble")
      .getByText("播放中实时广播", { exact: true }),
  ).toBeVisible();
  await expect(member.locator(".live-broadcast")).toHaveCount(0);

  // Disconnect deliberately. The snapshot on reconnect restores playback, not
  // a backlog of transient broadcast presentations.
  await member.getByLabel("播放器消息输入").fill("断线保留草稿");
  // Complete the close handshake before cutting networking. Chromium can
  // defer onclose for a graceful close started while already offline.
  await member.evaluate(() => (window as any).testSocket.close());
  await expect(member.getByLabel("播放器消息输入")).toBeDisabled();
  await memberContext.setOffline(true);
  await expect(member.getByLabel("聊天消息", { exact: true })).toBeDisabled();
  await send("断线期间的广播不补播");
  await visibleBroadcast(host, "断线期间的广播不补播");
  await memberContext.setOffline(false);
  await expect(member.getByText("实时连接", { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(member.locator(".live-broadcast")).toHaveCount(0);
  await expect(member.getByLabel("播放器消息输入")).toBeEnabled();
  await expect(member.getByLabel("播放器消息输入")).toHaveValue("断线保留草稿");
  await send("重连之后的新广播");
  await visibleBroadcast(host, "重连之后的新广播");
  await visibleBroadcast(member, "重连之后的新广播");
  expect(errors).toEqual([]);
  await memberContext.close();
});
