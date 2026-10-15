import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { adminPassword, adminUsername, login } from "./accounts";

test("managed accounts, admin resources, live revocation and guest invites", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/register");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "创建账户" })).toHaveCount(0);
  await login(page, adminUsername, adminPassword);
  await page.getByRole("link", { name: "管理后台" }).click();
  await expect(page.getByRole("heading", { name: "系统概览" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-overview.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "管理导航" })
    .getByRole("button", { name: "用户管理" })
    .click();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  const username = `managed-${Date.now()}`;
  const password = "managed-initial-password";
  const form = page.getByRole("dialog");
  await form.getByLabel("用户名").fill(username);
  await form.getByLabel("昵称").fill("周末观影者");
  await form.getByLabel("初始密码").fill(password);
  await form.getByRole("button", { name: "确认创建" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索管理资源" }).fill(username);
  const row = page.getByRole("row").filter({ hasText: username });
  await expect(row).toContainText("普通用户");
  await expect(page.getByText("共 1 条记录", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-users.png"),
    fullPage: true,
  });

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  user.on("pageerror", (e) => errors.push(e.message));
  await login(user, username, password);
  await expect(user.getByRole("link", { name: "管理后台" })).toHaveCount(0);
  await user.goto("/admin");
  await expect(
    user.getByRole("heading", { name: "需要管理员权限" }),
  ).toBeVisible();
  const response = await user.request.get("/api/v1/admin/users");
  expect(response.status()).toBe(403);
  await user.goto("/");
  const roomTitle = `账户体系回归-${Date.now()}`;
  await user.getByLabel("房间标题").fill(roomTitle);
  await user.getByRole("button", { name: "创建并进入" }).click();
  await expect(user.getByText("实时连接")).toBeVisible();
  await user.getByRole("button", { name: "复制邀请链接" }).click();
  const invitation = await user.locator(".invite-url").getAttribute("href");
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(invitation!);
  await guest.getByLabel("观影昵称").fill("无需账户的朋友");
  await guest.getByRole("button", { name: "进入放映室" }).click();
  await expect(guest.getByText("实时连接")).toBeVisible();
  await guest.getByLabel("聊天消息", { exact: true }).fill("游客邀请仍然可用");
  await guest.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    user
      .locator(".message-bubble")
      .getByText("游客邀请仍然可用", { exact: true }),
  ).toBeVisible();

  await row.getByRole("button", { name: `编辑 ${username}` }).click();
  await form.getByRole("switch", { name: "禁用账户", exact: true }).check();
  await form.getByRole("button", { name: "保存修改" }).click();
  await expect(form).toHaveCount(0);
  await expect(row).toContainText("已禁用");
  await expect(user).toHaveURL(/\/login$/);
  await user.getByLabel("用户名").fill(username);
  await user.getByLabel(/^密码/).fill(password);
  await user.getByRole("button", { name: "登录", exact: true }).click();
  await expect(user.getByRole("alert")).toContainText("Invalid credentials");
  await row.getByRole("button", { name: `编辑 ${username}` }).click();
  await form.getByRole("switch", { name: "禁用账户", exact: true }).uncheck();
  await form.getByLabel("重置密码").fill("managed-replacement-password");
  await form.getByRole("button", { name: "保存修改" }).click();
  await expect(form).toHaveCount(0);
  await login(user, username, "managed-replacement-password");
  await user.goto(invitation!);
  await user.getByRole("button", { name: "以 周末观影者 身份加入" }).click();
  await expect(user.getByText("实时连接")).toBeVisible();

  await page
    .getByRole("navigation", { name: "管理导航" })
    .getByRole("button", { name: "房间管理" })
    .click();
  await page.getByRole("textbox", { name: "搜索管理资源" }).fill(roomTitle);
  const roomRow = page.getByRole("row").filter({ hasText: roomTitle });
  await expect(roomRow).toContainText("周末观影者");
  await roomRow.getByRole("button", { name: `编辑 ${roomTitle}` }).click();
  const newTitle = `${roomTitle}-已整理`;
  await form.getByLabel("房间标题").fill(newTitle);
  await form.getByRole("button", { name: "保存修改" }).click();
  await expect(form).toHaveCount(0);
  await expect(user.getByRole("heading", { name: newTitle })).toBeVisible();
  await roomRow.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认操作" })
    .click();
  await expect(roomRow).toContainText("已关闭");
  await expect(
    user.getByRole("button", { name: "重新开放房间" }),
  ).toBeVisible();
  await roomRow.getByRole("button", { name: "删除 " + newTitle }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认操作" })
    .click();
  await expect(roomRow).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("admin-rooms.png"),
    fullPage: true,
  });

  await page
    .getByRole("navigation", { name: "管理导航" })
    .getByRole("button", { name: "影片管理" })
    .click();
  await expect(page.getByRole("button", { name: "上传影片" })).toBeVisible();
  const filmName = `admin-film-${Date.now()}.webm`;
  const film = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=navy:s=320x180:r=10",
    "-t",
    "1",
    "-c:v",
    "libvpx",
    "-f",
    "webm",
    "pipe:1",
  ]);
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: filmName, mimeType: "video/webm", buffer: film });
  await expect(page.getByText("影片上传完成", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索管理资源" }).fill(filmName);
  const filmRow = page.getByRole("row").filter({ hasText: filmName });
  await expect(filmRow).toContainText("可播放");
  await filmRow.getByRole("button", { name: `编辑 ${filmName}` }).click();
  const renamedFilm = `精选-${filmName}`;
  await form.getByLabel("影片名称").fill(renamedFilm);
  await form.getByRole("button", { name: "保存修改" }).click();
  await expect(form).toHaveCount(0);
  await expect(filmRow).toContainText(renamedFilm);

  await page.screenshot({
    path: testInfo.outputPath("admin-media.png"),
    fullPage: true,
  });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("navigation", { name: "管理导航" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("admin-mobile.png"),
    fullPage: true,
  });
  await filmRow.getByRole("button", { name: `删除 ${renamedFilm}` }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认操作" })
    .click();
  await expect(filmRow).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "管理导航" })
    .getByRole("button", { name: "用户管理" })
    .click();
  await page.getByRole("textbox", { name: "搜索管理资源" }).fill(username);
  await row.getByRole("button", { name: `删除 ${username}` }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认操作" })
    .click();
  await expect(row).toHaveCount(0);
  await userContext.close();
  await guestContext.close();
  expect(errors).toEqual([]);
});
