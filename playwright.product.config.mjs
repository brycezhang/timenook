import { defineConfig } from "@playwright/test";
import adminConfig from "./playwright.admin.config.mjs";

// Historical product web/preview acceptance stays available for manual work.
// These suites still use retired product flows and are not part of CI.
export default defineConfig({
  ...adminConfig,
  testDir: "./tests/admin",
  testIgnore: "**/console/**",
  outputDir: "/tmp/timenook-product-browser-results",
});
