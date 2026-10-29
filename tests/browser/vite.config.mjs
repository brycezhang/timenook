import { defineConfig } from "vite";
import { resolve } from "node:path";
import config from "../../vite.config.mjs";
export default defineConfig({
  ...config,
  base: "/app/",
  build: {
    emptyOutDir: true,
    rollupOptions: { input: resolve("tests/browser/recorder.html") },
  },
});
