import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { privateArtifactsDeny } from "../../tools/vite-private-artifacts";
import { lamejsLicense } from "../../tools/lamejs-license";

const tls =
  process.env.TIMENOOK_WEB_TLS_CERT && process.env.TIMENOOK_WEB_TLS_KEY
    ? {
        cert: readFileSync(process.env.TIMENOOK_WEB_TLS_CERT),
        key: readFileSync(process.env.TIMENOOK_WEB_TLS_KEY),
      }
    : undefined;
const proxy = process.env.TIMENOOK_WEB_API_TARGET
  ? {
      "^/api/": {
        target: process.env.TIMENOOK_WEB_API_TARGET,
        rewrite: (path: string) => path.replace(/^\/api\//, "/"),
      },
    }
  : undefined;

export default defineConfig({
  plugins: [vue(), lamejsLicense()],
  worker: { format: "es" },
  base: "/app/",
  server: {
    host: "127.0.0.1",
    port: 4330,
    strictPort: true,
    https: tls,
    proxy,
    fs: { deny: privateArtifactsDeny },
  },
  preview: {
    host: "127.0.0.1",
    port: 4330,
    strictPort: true,
    https: tls,
    proxy,
  },
});
