import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";

async function syntheticVideo(page: import("@playwright/test").Page) {
  const dataURL = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const draw = canvas.getContext("2d")!;
    const stream = canvas.captureStream(15);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise<string>((resolve, reject) => {
      recorder.onerror = () => reject(new Error("MediaRecorder failed"));
      recorder.onstop = () => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob(chunks, { type: mime }));
      };
    });
    recorder.start();
    let frame = 0;
    const timer = setInterval(() => {
      draw.fillStyle = `hsl(${frame++ * 12} 65% 30%)`;
      draw.fillRect(0, 0, 320, 180);
      draw.fillStyle = "white";
      draw.font = "28px sans-serif";
      draw.fillText("Remote Screening Room", 76, 100);
    }, 60);
    await new Promise((r) => setTimeout(r, 4000));
    clearInterval(timer);
    recorder.stop();
    return stopped;
  });
  return Buffer.from(dataURL.split(",")[1], "base64");
}

test("two browsers upload, join, synchronize, chat and recover state", async ({
  browser,
}) => {
  const hostContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const host = await hostContext.newPage();
  const suffix = Date.now().toString(36);
  await host.goto("/register");
  await host.getByLabel("昵称").fill("Alice");
  await host.getByLabel("用户名").fill(`alice-${suffix}`);
  await host.getByLabel("密码").fill("correct-horse-battery-staple");
  await host.getByRole("button", { name: "注册并登录" }).click();
  await expect(host.getByText("今晚，看点什么？")).toBeVisible();
  const video = await syntheticVideo(host);
  await host.locator("input[type=file]").setInputFiles({
    name: "sync-test.webm",
    mimeType: "video/webm",
    buffer: video,
  });
  await expect(host.getByText("上传完成")).toBeVisible({ timeout: 30000 });
  await expect(host.getByText("sync-test.webm").last()).toBeVisible();
  await host.getByLabel("房间标题").fill("E2E 放映室");
  await host.getByRole("button", { name: "创建并进入" }).click();
  await expect(host.getByText("实时连接")).toBeVisible();
  await host.getByLabel("切换影片").selectOption({ label: "sync-test.webm" });
  await expect(host.locator("video")).toBeVisible();
  await host.getByRole("button", { name: "复制邀请链接" }).click();
  const inviteText = host.locator(".notice span");
  await expect(inviteText).toBeVisible();
  const invitation = (await inviteText.textContent())!;
  expect(invitation).toContain("/join/");
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await member.goto(invitation);
  await member.getByLabel("观影昵称").fill("Bob");
  await member.getByRole("button", { name: "进入放映室" }).click();
  await expect(member.getByText("实时连接")).toBeVisible();
  await member.getByRole("tab", { name: /成员/ }).click();
  await expect(member.locator(".member").getByText("Alice")).toBeVisible();
  await member.getByRole("tab", { name: /聊天/ }).click();
  await host.getByRole("button", { name: "播放" }).click();
  const continueButton = member.getByRole("button", {
    name: /浏览器阻止了自动播放/,
  });
  if (await continueButton.isVisible().catch(() => false))
    await continueButton.click();
  await member.waitForTimeout(800);
  const [hostTime, memberTime] = await Promise.all([
    host.locator("video").evaluate((v) => (v as HTMLVideoElement).currentTime),
    member
      .locator("video")
      .evaluate((v) => (v as HTMLVideoElement).currentTime),
  ]);
  expect(Math.abs(hostTime - memberTime)).toBeLessThan(0.9);
  await host.getByRole("button", { name: "暂停" }).click();
  await expect
    .poll(() =>
      member.locator("video").evaluate((v) => (v as HTMLVideoElement).paused),
    )
    .toBe(true);
  const timeline = host.getByLabel("播放进度");
  await timeline.fill("2000");
  await timeline.dispatchEvent("pointerup");
  await expect
    .poll(() =>
      member
        .locator("video")
        .evaluate((v) => (v as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(1.5);
  await host.getByPlaceholder("发送消息…").fill("同步收到这条消息");
  await host.getByRole("button", { name: "发送消息" }).click();
  await expect(
    member.locator(".message-bubble").getByText("同步收到这条消息"),
  ).toBeVisible();
  await expect(
    member.locator(".danmaku-content").getByText("同步收到这条消息"),
  ).toBeAttached();
  await member.reload();
  await expect(member.getByText("实时连接")).toBeVisible();
  await expect(
    member.locator(".message-bubble").getByText("同步收到这条消息"),
  ).toBeVisible();
  const xss = '<img src=x onerror="globalThis.pwned=true">';
  await host.getByPlaceholder("发送消息…").fill(xss);
  await host.getByRole("button", { name: "发送消息" }).click();
  await expect(member.locator(".message-bubble").getByText(xss)).toBeVisible();
  await expect(member.locator('.message img[src="x"]')).toHaveCount(0);
  expect(
    await member.evaluate(
      () => (globalThis as typeof globalThis & { pwned?: boolean }).pwned,
    ),
  ).toBeUndefined();
  member.once("dialog", (dialog) => dialog.accept());
  await member.getByRole("button", { name: "离开房间" }).click();
  await expect(member).toHaveURL(/\/login$/);
  await memberContext.close();
  await hostContext.close();
});
