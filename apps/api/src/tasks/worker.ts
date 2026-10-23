import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { API_CONFIG, ApiConfig } from "../config";
import { ProductionTasks } from "./tasks";

/** Redis only wakes the durable use case; every delivery can safely repeat. */
export async function startProductionWorker(app: NestFastifyApplication) {
  const config = app.get<ApiConfig>(API_CONFIG),
    tasks = app.get(ProductionTasks);
  const prefix = `${config.redisKeyPrefix ?? "timenook"}:production`;
  const producer = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    commandTimeout: 1000,
  });
  const consumer = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  producer.on("error", () => {});
  consumer.on("error", () => {});
  const queue = new Queue("tasks", { connection: producer, prefix });
  const worker = new Worker(
    "tasks",
    async (job) => {
      await tasks.run(String(job.data.taskId));
    },
    { connection: consumer, prefix, concurrency: 2 },
  );
  worker.on("error", () => {});
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  return {
    worker,
    async recoverDue() {
      const ids = await tasks.due();
      for (const id of ids) {
        await queue.add(
          "wake",
          { taskId: id },
          { jobId: id, removeOnComplete: true, removeOnFail: true },
        );
        await tasks.delivered(id);
      }
      return ids.length;
    },
    async close() {
      await worker.close();
      await queue.close();
      producer.disconnect();
      consumer.disconnect();
    },
  };
}

/** Separate process composition; HTTP listening is deliberately absent. */
export async function launchProductionWorker(
  config: ApiConfig,
  options: Parameters<
    typeof import("../application").createApplication
  >[1] = {},
) {
  if (!config.transcription)
    throw new Error("Transcription admission is pending");
  const { createApplication } = await import("../application.js");
  const app = await createApplication(config, options);
  let runtime: Awaited<ReturnType<typeof startProductionWorker>>;
  try {
    runtime = await startProductionWorker(app);
  } catch (error) {
    await app.close();
    throw error;
  }
  let closed = false,
    running = false;
  const recover = async () => {
    if (closed || running) return;
    running = true;
    try {
      await runtime.recoverDue();
    } catch {
      /* PostgreSQL retains every delivery intent. */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void recover(), 1000);
  void recover();
  return {
    ...runtime,
    async close() {
      closed = true;
      clearInterval(timer);
      await runtime.close();
      await app.close();
    },
  };
}
