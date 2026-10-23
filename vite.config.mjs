import { defineConfig } from "vite";
import { privateArtifactsDeny } from "./tools/vite-private-artifacts.ts";
export default defineConfig({
  define: {
    __TIMENOOK_PAYMENT_VERIFICATION__: JSON.stringify(
      process.env.TIMENOOK_PAYMENT_VERIFICATION === "local-verification",
    ),
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
          "^/timenook/v1/(recipient-types|packages/current|orders(?:/[a-f0-9-]{36}(?:/(?:payment|close))?)?|participations|invitations/[A-Za-z0-9_-]{43}(?:/requests)?|projects/[a-f0-9-]{36}/(?:participation|binding-requests|care-requests|invitations|consents(?:/revoke)?)|binding-requests/[a-f0-9-]{36}/approve)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              rewrite: (path) => path.replace(/^\/timenook/, ""),
            },
        }
      : undefined,
  },
  publicDir: false,
});
