import { defineConfig, devices } from "@playwright/test";

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: externalBaseURL ?? "http://127.0.0.1:18080",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: "go run ../cmd/watchtogether serve",
        url: "http://127.0.0.1:18080/readyz",
        reuseExistingServer: false,
        env: {
          APP_ENV: "development",
          APP_BASE_URL: "http://127.0.0.1:18080",
          HTTP_LISTEN_ADDR: "127.0.0.1:18080",
          DATABASE_PATH: "../data/e2e.db",
          ALLOWED_ORIGINS: "http://127.0.0.1:18080",
          S3_ENDPOINT: "http://127.0.0.1:9000",
          S3_REGION: "us-east-1",
          S3_BUCKET: "watchtogether",
          S3_ACCESS_KEY_ID: "minioadmin",
          S3_SECRET_ACCESS_KEY: "minioadmin",
          S3_PATH_STYLE: "true",
        },
      },
});
