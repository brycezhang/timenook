import { defineConfig } from "@playwright/test";
// Automatic snapshots and traces can capture transient OAuth codes or cookies.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  // CI covers the standalone management console. Product browser acceptance is paused.
  testDir: "./tests/admin/console",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "/tmp/timenook-admin-browser-results",
  use: {
    baseURL: "https://localhost:3443/admin/",
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
