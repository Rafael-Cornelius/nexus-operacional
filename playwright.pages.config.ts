import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PAGES_PREVIEW_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}/nexus-operacional/`;

export default defineConfig({
  testDir: "./tests/e2e-pages",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-pages-artifact",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/serve_pages_preview.mjs",
    url: `${baseURL}login/`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      PAGES_PREVIEW_PORT: String(port),
    },
  },
});
