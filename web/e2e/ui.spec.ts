import { provisionUser } from "./accounts";
import { expect, test } from "@playwright/test";

// Exercise library integration with real CSP/API/WebSocket behavior, including
// keyboard focus and narrow layouts that CSS-only assertions cannot validate.
test("modern UI works on desktop and mobile with accessible tabs and dialogs", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await provisionUser(
    page,
    `ui-${Date.now().toString(36)}`,
    "correct-horse-battery-staple",
    "UI 观影者",
  );
  await expect(
    page.getByRole("heading", { name: "今晚，看点什么？" }),
  ).toBeVisible();
  await expect(page.getByText("第一场放映，从这里开始")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("dashboard-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("房间标题").fill("周五夜场 · 和朋友一起看");
  await page.getByRole("button", { name: "创建并进入" }).click();
  await expect(page.getByText("实时连接")).toBeVisible();
  const chat = page.getByRole("tab", { name: /聊天/ });
  const members = page.getByRole("tab", { name: /成员/ });
  await chat.focus();
  await page.keyboard.press("ArrowRight");
  await expect(members).toBeFocused();
  await expect(members).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("UI 观影者");
  await expect(page.getByRole("log")).toHaveCount(0);
  await chat.click();
  await page.getByLabel("聊天消息").fill("电影开始前，先说声晚上好。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".live-broadcast")).toContainText("先说声晚上好");
  await page.screenshot({
    path: testInfo.outputPath("room-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "复制邀请链接" }).click();
  const invite = await page.locator(".invite-url").getAttribute("href");
  const guest = await browser.newContext();
  const landing = await guest.newPage();
  await landing.goto(invite!);
  await expect(
    landing.getByRole("heading", { name: "周五夜场 · 和朋友一起看" }),
  ).toBeVisible();
  await landing.screenshot({
    path: testInfo.outputPath("invite-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await landing.setViewportSize({ width: 390, height: 844 });
  await expect(landing.getByLabel("观影昵称")).toBeVisible();
  await landing.screenshot({
    path: testInfo.outputPath("invite-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await landing.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await guest.close();
  await page.getByRole("button", { name: "关闭房间", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "关闭房间", exact: true }),
  ).toBeFocused();
  await expect(page.getByText("实时连接")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("room-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("聊天消息")).toBeVisible();
  await page.getByRole("button", { name: "关闭房间", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认操作" })
    .click();
  await expect(
    page.getByRole("button", { name: "重新开放房间" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新开放房间" }).click();
  await expect(page.getByText("实时连接")).toBeVisible();
  await page.getByRole("button", { name: /返回首页/ }).click();
  await expect(
    page.getByRole("heading", { name: "今晚，看点什么？" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("dashboard-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("login-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
