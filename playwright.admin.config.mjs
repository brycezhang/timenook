import { defineConfig } from "@playwright/test";
// Automatic error snapshots can contain password inputs or MFA enrollment seeds.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "./tests/admin",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "/tmp/timenook-admin-browser-results",
  use: {
    baseURL: "https://localhost:3443/timenook/admin/",
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
