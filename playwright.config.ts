import { defineConfig, devices } from "@playwright/test";

// E2E memakai server asli (API + PWA hasil build) dengan MongoDB in-memory, LLM mock, dan data sintetis.
const PORT = 8790;
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.results",
  use: { baseURL: `http://localhost:${PORT}`, screenshot: "off", trace: "off" },
  webServer: {
    command: "npm -w server run dev:memdb",
    url: `http://localhost:${PORT}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), ALLOWED_ORIGINS: `http://localhost:${PORT}`, RATE_LIMIT_SCALE: "1000", ADMIN_EMAILS: "admin@contoh.com" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, permissions: ["microphone"], launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } } },
    { name: "mobile", use: { ...devices["Pixel 7"], permissions: ["microphone"], launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } } },
  ],
});
