import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.PLAYWRIGHT_OPERATIONAL_WEB_PORT ?? "3100");
const apiPort = Number(process.env.PLAYWRIGHT_OPERATIONAL_API_PORT ?? "3333");
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests/e2e-operational",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [{ name: "chromium-operational", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev --workspace=@nexus/api",
      url: `${apiURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        NODE_ENV: "test",
        WEB_ORIGIN: baseURL
      }
    },
    {
      command: `npm run dev --workspace=@nexus/web -- --port ${webPort}`,
      url: `${baseURL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_DEMO_MODE: "false",
        API_INTERNAL_URL: apiURL
      }
    }
  ]
});
