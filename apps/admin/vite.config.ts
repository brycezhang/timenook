import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ command }) => {
  if (
    command === "serve" &&
    (!process.env.ADMIN_TLS_CERT || !process.env.ADMIN_TLS_KEY)
  ) {
    throw new Error(
      "Admin development requires ADMIN_TLS_CERT and ADMIN_TLS_KEY for HTTPS Secure cookies",
    );
  }
  return {
    base: "/timenook/admin/",
    plugins: [vue(), tailwindcss()],
    server: {
      host: "localhost",
      port: 3443,
      strictPort: true,
      https:
        command === "serve" &&
        process.env.ADMIN_TLS_CERT &&
        process.env.ADMIN_TLS_KEY
          ? {
              cert: readFileSync(process.env.ADMIN_TLS_CERT),
              key: readFileSync(process.env.ADMIN_TLS_KEY),
            }
          : undefined,
      proxy: {
        "/timenook/v1": {
          target: process.env.ADMIN_API_TARGET ?? "http://127.0.0.1:3417",
          rewrite: (path) => path.replace(/^\/timenook/, ""),
        },
      },
    },
  };
});
