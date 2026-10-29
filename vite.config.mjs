import { lamejsLicense } from "./tools/lamejs-license.ts";
import { defineConfig } from "vite";
import { privateArtifactsDeny } from "./tools/vite-private-artifacts.ts";
export default defineConfig({
  plugins: [lamejsLicense()],
  worker: { format: "es" },
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
          "^/api/v1/orders/[a-f0-9-]{36}/quality-care(?:/[a-f0-9-]{36}/(?:access|refund))?$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/projects/[a-f0-9-]{36}/exports(?:/[a-f0-9-]{36}/(?:download|receipt))?$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/orders/[a-f0-9-]{36}/refunds$": {
            target: process.env.TIMENOOK_PREVIEW_API_TARGET,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ""),
          },
          "^/api/v1/projects/[a-f0-9-]{36}/(?:fulfillment(?:/grants)?|withdrawal-status|deletion-status)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/projects/[a-f0-9-]{36}/first-copy(?:/(?:address|confirmations|submit|expiry-review))?$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/book-audio/[A-Za-z0-9_-]{22}(?:/clips/[a-f0-9-]{36}/content\\?epoch=[0-9]+)?$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/projects/[a-f0-9-]{36}/book(?:/(?:cover|directory|versions(?:/[a-f0-9-]{36}(?:/(?:pdf|retry))?)?))?$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/(?:health/(?:live|ready)|v1/(?:probes/(?:audio|ai)(?:/.*)?|sessions(?:/wechat|/[a-f0-9-]{36})|users/me))$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/projects/[a-f0-9-]{36}/(?:overview|metadata|stories/[a-f0-9-]{36}/(?:revisions|decisions|care-access))$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/(recipient-types|packages/current|orders(?:/[a-f0-9-]{36}(?:/(?:payment|close))?)?|participations|invitations/[A-Za-z0-9_-]{43}(?:/requests)?|projects/[a-f0-9-]{36}/(?:stories(?:/(?:context|organize|[a-f0-9-]{36}))?|participation|binding-requests|care-requests|assisted-sessions|tasks(?:/status|/[a-f0-9-]{36}(?:/retry)?)?|plan(?:/preferences)?|interviews(?:/context|/[a-f0-9-]{36}(?:/(?:resume|recording-start|collection-check|actual-question|follow-up(?:/(?:status|finish))?)|/clips(?:/[a-f0-9-]{36}(?:/(?:upload|seal|status|release|content))?)?)?)?|invitations|consents(?:/revoke)?)|binding-requests/[a-f0-9-]{36}/approve|recordings/objects)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          "^/api/v1/(?:photos/objects|projects/[a-f0-9-]{36}/interviews/[a-f0-9-]{36}/photos(?:/(?:context|materials(?:/[a-f0-9-]{36})?)|/[a-f0-9-]{36}/(?:upload|seal|status|release|crop|content/(?:original|preview|thumbnail|print)|assets/[a-f0-9-]{36}/content))?)$":
            {
              target: process.env.TIMENOOK_PREVIEW_API_TARGET,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
        }
      : undefined,
  },
  publicDir: false,
});
