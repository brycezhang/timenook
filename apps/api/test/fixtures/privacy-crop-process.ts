import files from "node:fs/promises";
import { dirname, basename } from "node:path";
import { createApplication } from "../../src/application";
import { LocalProbeObjects } from "../../src/probe/local-objects";
import { paymentFetch } from "../payment-fixture";
import type { ApiConfig } from "../../src/config";
async function main() {
  const config: ApiConfig = JSON.parse(
    await files.readFile(process.argv[2], "utf8"),
  );
  const originalRead = files.readFile.bind(files);
  Object.defineProperty(files, "readFile", {
    value: async (...args: unknown[]) => {
      const result = await Reflect.apply(originalRead, files, args);
      if (
        typeof args[0] === "string" &&
        args[0].includes(".privacy-runs") &&
        basename(args[0]) === "photo.json"
      ) {
        process.send?.({
          stage: "outputs-written",
          root: dirname(dirname(args[0])),
        });
        await new Promise(() => {
          setInterval(() => {}, 1000);
        });
      }
      return result;
    },
  });
  const app = await createApplication(config, {
    recordingObjects: new LocalProbeObjects(config.recording!.storageRoot),
    paymentFetch,
    wechatFetch: async () => new Response("{}"),
    aiFetch: async () => new Response("{}"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  process.send?.({ stage: "ready", url: await app.getUrl() });
}
void main().catch(() => {
  process.send?.({ stage: "failed" });
  process.exitCode = 1;
});
