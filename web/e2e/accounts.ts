import { expect, request, type Page } from "@playwright/test";

export const testBaseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  `http://127.0.0.1:${process.env.E2E_PORT ?? "18081"}`;
export const adminUsername = process.env.E2E_ADMIN_USERNAME ?? "e2e-admin";
export const adminPassword =
  process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password";

export async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel(/^密码/).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今晚，看点什么？" }),
  ).toBeVisible();
}

// Accounts are provisioned through the same protected API the admin UI uses.
// An isolated request context keeps the administrator's session out of the user browser.
export async function provisionUser(
  page: Page,
  username: string,
  password: string,
  nickname: string,
) {
  const context = await request.newContext({ baseURL: testBaseURL });
  try {
    const csrf = await context.get("/api/v1/auth/csrf");
    const token = (await csrf.json()).data.csrfToken;
    const signed = await context.post("/api/v1/auth/login", {
      headers: { Origin: testBaseURL, "X-CSRF-Token": token },
      data: { username: adminUsername, password: adminPassword },
    });
    expect(signed.status(), await signed.text()).toBe(200);
    const cookie = (await context.storageState()).cookies.find(
      (v) => v.name === "wt_csrf",
    )!.value;
    const created = await context.post("/api/v1/admin/users", {
      headers: { Origin: testBaseURL, "X-CSRF-Token": cookie },
      data: { username, password, nickname },
    });
    expect(created.status(), await created.text()).toBe(201);
  } finally {
    await context.dispose();
  }
  await login(page, username, password);
}
