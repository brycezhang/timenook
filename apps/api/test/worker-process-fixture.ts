import { Queue } from "bullmq";
import Redis from "ioredis";
// Test-only process host. Only external object source and supplier transport vary;
// the production launcher, PostgreSQL owner, Redis queue, lease and fence are real.
import { LocalProbeObjects } from "../src/probe/local-objects";
import { launchProductionWorker } from "../src/tasks/worker";
import { paymentFetch } from "./payment-fixture";
import type { ApiConfig } from "../src/config";
let publisher: Queue | undefined, publisherConnection: Redis | undefined;
let runtime: Awaited<ReturnType<typeof launchProductionWorker>> | undefined;
const replies = new Map<
  number,
  (value: { code: string; text?: string }) => void
>();
let sequence = 0;
process.on("message", async (message: any) => {
  if (message.kind === "response") {
    replies.get(message.sequence)?.(message);
    replies.delete(message.sequence);
    return;
  }
  if (message.kind === "close") {
    await runtime?.close();
    await publisher?.close();
    publisherConnection?.disconnect();
    process.disconnect();
    return;
  }
  if (message.kind !== "start" && message.kind !== "publish") return;
  try {
    const config: ApiConfig = message.config;
    if (
      config.environment !== "test" ||
      config.transcription?.mode !== "synthetic-local"
    )
      throw new Error();
    if (message.kind === "publish") {
      publisherConnection = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 0,
      });
      publisherConnection.on("error", () => {});
      publisher = new Queue("tasks", {
        connection: publisherConnection,
        prefix: `${config.redisKeyPrefix}:production`,
      });
      await publisher.waitUntilReady();
      await publisher.add(
        "wake",
        { taskId: message.taskId },
        { jobId: message.taskId, removeOnComplete: true, removeOnFail: true },
      );
      process.send!({ kind: "published", id: message.taskId });
      return;
    }
    class Objects extends LocalProbeObjects {
      async asrSource(key: string) {
        return {
          url: `https://synthetic.oss-cn-shanghai.aliyuncs.com/${key}?private=synthetic`,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          credentialsExpireAt: new Date(Date.now() + 180000).toISOString(),
        };
      }
    }
    const aiFetch: typeof fetch = async (input, init) => {
      const action = String(input).endsWith("/submit") ? "submit" : "query",
        id = new Headers(init?.headers).get("X-Api-Request-Id")!;
      const body = JSON.parse(String(init?.body));
      const seq = ++sequence;
      const response = new Promise<{ code: string; text?: string }>((resolve) =>
        replies.set(seq, resolve),
      );
      process.send!({
        kind: "provider",
        sequence: seq,
        action,
        id,
        sourceKey: body.audio?.url ? new URL(body.audio.url).pathname : null,
      });
      const reply = await response;
      return new Response(
        action === "submit"
          ? "{}"
          : JSON.stringify({
              task_id: id,
              result: { text: reply.text ?? "独立 Worker 恢复的原始转录。" },
            }),
        { headers: { "X-Api-Status-Code": reply.code } },
      );
    };
    runtime = await launchProductionWorker(config, {
      paymentFetch,
      aiFetch,
      recordingObjects: new Objects(config.recording!.storageRoot),
    });
    runtime.worker.on("completed", (job) =>
      process.send!({ kind: "completed", id: job.id }),
    );
    process.send!({ kind: "ready" });
  } catch {
    process.send!({ kind: "failed" });
    process.exitCode = 1;
    process.disconnect();
  }
});
