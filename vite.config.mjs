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
          "^/timenook/v1/(recipient-types|packages/current|orders(?:/[a-f0-9-]{36}(?:/(?:payment|close))?)?|participations|invitations/[A-Za-z0-9_-]{43}(?:/requests)?|projects/[a-f0-9-]{36}/(?:stories(?:/(?:context|organize|[a-f0-9-]{36}))?|participation|binding-requests|care-requests|assisted-sessions|tasks(?:/status|/[a-f0-9-]{36}(?:/retry)?)?|plan(?:/preferences)?|interviews(?:/context|/[a-f0-9-]{36}(?:/(?:resume|recording-start)|/clips(?:/[a-f0-9-]{36}(?:/(?:upload|seal|status|release|content))?)?)?)?|invitations|consents(?:/revoke)?)|binding-requests/[a-f0-9-]{36}/approve|recordings/objects)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              rewrite: (path) => path.replace(/^\/timenook/, ""),
            },
          "^/timenook/v1/(?:photos/objects|projects/[a-f0-9-]{36}/interviews/[a-f0-9-]{36}/photos(?:/(?:context|materials(?:/[a-f0-9-]{36})?)|/[a-f0-9-]{36}/(?:upload|seal|status|release|crop|content/(?:original|preview|thumbnail|print)|assets/[a-f0-9-]{36}/content))?)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              rewrite: (path) => path.replace(/^\/timenook/, ""),
            },
        }
      : undefined,
  },
  publicDir: false,
});
