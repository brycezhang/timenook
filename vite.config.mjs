import { defineConfig } from "vite";
import { privateArtifactsDeny } from "./tools/vite-private-artifacts.ts";
export default defineConfig({
  server: { port: 5173, strictPort: true, fs: { deny: privateArtifactsDeny } },
  publicDir: false,
});
