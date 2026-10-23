import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the standalone console against the real rover hub and
// GPS unit APIs with simulated hardware (tests/e2e/devices.mjs). The devices
// are shared state, so tests run one at a time. Uses the installed Chrome.
const origin = "http://127.0.0.1:5180";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.spec.mjs",
  globalSetup: "./tests/e2e/global-setup.mjs",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: { baseURL: origin, channel: "chrome", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: /mobile\.spec/, use: { baseURL: origin, channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", testMatch: /mobile\.spec/, use: { ...devices["Pixel 7"], baseURL: origin, channel: "chrome" } },
  ],
  webServer: {
    command: "corepack pnpm --filter fsk-coursekeeper-console exec vite --host 127.0.0.1 --port 5180 --strictPort",
    url: origin,
    reuseExistingServer: !process.env.CI,
  },
});
