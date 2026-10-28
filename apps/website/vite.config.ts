import { defineConfig } from "vite";
import { privateArtifactsDeny } from "../../tools/vite-private-artifacts";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4320,
    strictPort: true,
    fs: { deny: privateArtifactsDeny },
  },
  preview: { host: "127.0.0.1", port: 4320, strictPort: true },
});
