import { PrivacyRights } from "./care/privacy-rights";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { API_CONFIG, ApiConfig } from "./config";

@Injectable()
export class Infrastructure implements OnModuleDestroy {
  private readonly database: PrismaClient;
  private readonly redis: Redis;
  private connection?: Promise<void>;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly rights: PrivacyRights,
  ) {
    this.database = new PrismaClient({ datasourceUrl: config.databaseUrl });
    this.redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null,
    });
    // Failures are reported by the readiness response; never log connection URLs.
    this.redis.on("error", () => {});
  }

  async ready(): Promise<boolean> {
    const results = await Promise.allSettled([
      this.rights.enabled
        ? this.rights.assertHealthy().then(() => true)
        : Promise.resolve(true),
      this.database.serviceSchema
        .findUnique({ where: { id: 1 } })
        .then((schema) => schema?.revision === 1),
      this.redisReady(),
    ]);
    return results.every(
      (result) => result.status === "fulfilled" && result.value,
    );
  }

  private async redisReady(): Promise<boolean> {
    if (this.redis.status !== "ready") {
      this.connection ??= this.redis.connect().finally(() => {
        this.connection = undefined;
      });
      await this.connection;
    }
    return (await this.redis.ping()) === "PONG";
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    await this.database.$disconnect();
  }
}
