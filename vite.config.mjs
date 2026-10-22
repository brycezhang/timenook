import { defineConfig } from "vite";
import { privateArtifactsDeny } from "./tools/vite-private-artifacts.ts";
export default defineConfig({
  define: {
    __TIMENOOK_API_BASE_URL__: JSON.stringify(
      process.env.TIMENOOK_API_BASE_URL ?? "",
    ),
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { deny: privateArtifactsDeny },
    proxy: process.env.TIMENOOK_PREVIEW_API_TARGET
      ? {
          "^/timenook/v1/(recipient-types|packages/current)$": {
            target: process.env.TIMENOOK_PREVIEW_API_TARGET,
            rewrite: (path) => path.replace(/^\/timenook/, ""),
          },
        }
      : undefined,
  },
  publicDir: false,
});
