import { readFile } from "node:fs/promises";
import { createApplication } from "../src/application";
import { launchProductionWorker } from "../src/tasks/worker";
import { LocalProbeObjects } from "../src/probe/local-objects";
import { paymentFetch } from "./payment-fixture";
import type { ApiConfig } from "../src/config";
async function main() {
  const config: ApiConfig = JSON.parse(await readFile(process.argv[2], "utf8"));
  class Objects extends LocalProbeObjects {
    async asrSource(key: string) {
      return {
        url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?signature=private`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
      };
    }
  }
  const options = {
    paymentFetch,
    wechatFetch: async () => new Response("{}"),
    recordingObjects: new Objects(config.recording!.storageRoot),
    aiFetch: async (input: string | URL | Request, init?: RequestInit) =>
      new Response(
        String(input).endsWith("/submit")
          ? "{}"
          : JSON.stringify({
              task_id: new Headers(init?.headers).get("X-Api-Request-Id"),
              result: { text: "恢复控制项目的独立讲述" },
            }),
        { headers: { "X-Api-Status-Code": "20000000" } },
      ),
  };
  const mode = process.argv[3];
  if (mode === "worker") {
    const worker = await launchProductionWorker(config, options);
    await worker.recoverDue();
    process.send?.({ ready: true });
    process.on("message", (m) => {
      if (m === "close") void worker.close().then(() => process.exit(0));
    });
  } else {
    const app = await createApplication(config, options);
    await app.listen({ port: 0, host: "127.0.0.1" });
    process.send?.({ ready: true, url: await app.getUrl() });
    process.on("message", (m) => {
      if (m === "close") void app.close().then(() => process.exit(0));
    });
  }
}
void main().catch(() => {
  process.send?.({ ready: false });
  process.exitCode = 1;
});
