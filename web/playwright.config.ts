import { defineConfig, devices } from "@playwright/test";

const testBaseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  `http://127.0.0.1:${process.env.E2E_PORT ?? "18081"}`;
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? "e2e-admin";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password";
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: testBaseURL,
    actionTimeout: 15000,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: "go run ../cmd/watchtogether serve",
        url: `${testBaseURL}/readyz`,
        reuseExistingServer: false,
        env: {
          APP_ENV: "development",
          APP_BASE_URL: testBaseURL,
          HTTP_LISTEN_ADDR: new URL(testBaseURL).host,
          DATABASE_PATH: "../data/e2e.db",
          ALLOWED_ORIGINS: testBaseURL,
          ADMIN_USERNAME: adminUsername,
          ADMIN_PASSWORD: adminPassword,
          S3_ENDPOINT: "http://127.0.0.1:9000",
          S3_REGION: "us-east-1",
          S3_BUCKET: "watchtogether",
          S3_ACCESS_KEY_ID: "minioadmin",
          S3_SECRET_ACCESS_KEY: "minioadmin",
          S3_PATH_STYLE: "true",
        },
      },
});
