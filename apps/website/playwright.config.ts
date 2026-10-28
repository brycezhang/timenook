import { defineConfig, devices } from "@playwright/test";

// Readiness probes must reach our loopback server even on a proxied workstation.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"]
  .filter(Boolean)
  .join(",");

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  outputDir: "/tmp/timenook-website-browser-results",
  use: {
    baseURL: "http://127.0.0.1:4320",
    trace: "off",
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "off",
  },
  projects: [
    {
      name: "compact-mobile",
      use: { viewport: { width: 320, height: 760 }, isMobile: true },
    },
    { name: "desktop", use: { viewport: { width: 1440, height: 960 } } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://127.0.0.1:4320",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
