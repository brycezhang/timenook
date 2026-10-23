import type { WechatPayConfig } from "./payments/wechat-pay";
import type { AiProbeConfig } from "./probe/ai-probe";
import type { ProbeOssConfig } from "./probe/oss-objects";

export interface ApiConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  wechat?: { appId: string; secret: string };
  payments?: WechatPayConfig;
  // No production D08 approval exists. This mode only exercises isolated tests.
  participation?: { mode: "synthetic-d08" };
  recording?: {
    mode: "synthetic-local";
    storageRoot: string;
    oss?: ProbeOssConfig;
  };
  sessionTtlSeconds?: number;
  redisKeyPrefix?: string;
  loginLimitPerMinute?: number;
  aiProbe?: AiProbeConfig;
  audioProbe?: {
    storageRoot: string;
    sessionTtlSeconds?: number;
    uploadTtlSeconds?: number;
    oss?: ProbeOssConfig;
  };
  admin?: {
    origin: string;
    encryptionKey: string;
    sessionTtlSeconds: number;
    challengeTtlSeconds: number;
  };
}

export const API_CONFIG = Symbol("API_CONFIG");

export class ConfigurationError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const environment = env.NODE_ENV ?? "development";
  if (
    environment !== "development" &&
    environment !== "test" &&
    environment !== "production"
  ) {
    throw new ConfigurationError(
      "NODE_ENV must be development, test or production",
    );
  }
  if (environment === "production" && env.AUDIO_PROBE_ENABLED)
    throw new ConfigurationError(
      "Audio probe cannot be configured in production",
    );
  const databaseUrl = connectionUrl(env, "DATABASE_URL", [
    "postgres:",
    "postgresql:",
  ]);
  const redisUrl = connectionUrl(env, "REDIS_URL", ["redis:", "rediss:"]);
  const port = Number(env.API_PORT ?? "3417");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(
      "API_PORT must be an integer between 1 and 65535",
    );
  }
  if (
    environment === "production" &&
    new URL(databaseUrl).password === "local-development-only"
  ) {
    throw new ConfigurationError(
      "Production requires independent database credentials",
    );
  }
  const appId = env.TIMENOOK_WECHAT_APP_ID?.trim();
  const secret = env.TIMENOOK_WECHAT_APP_SECRET?.trim();
  if (!!appId !== !!secret)
    throw new ConfigurationError("Configure both TimeNook WeChat credentials");
  if (environment === "production" && (!appId || !secret)) {
    throw new ConfigurationError(
      "Production requires TimeNook WeChat credentials",
    );
  }
  if (appId && secret && /\s|YOUR_|PLACEHOLDER|<|>/i.test(appId + secret)) {
    throw new ConfigurationError(
      "TimeNook WeChat credentials must not contain placeholders or whitespace",
    );
  }
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? "604800");
  if (
    !Number.isInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 1 ||
    sessionTtlSeconds > 2592000
  ) {
    throw new ConfigurationError(
      "SESSION_TTL_SECONDS must be an integer between 1 and 2592000",
    );
  }
  let admin: ApiConfig["admin"];
  if (env.ADMIN_ORIGIN || env.ADMIN_ENCRYPTION_KEY) {
    let origin: URL;
    try {
      origin = new URL(env.ADMIN_ORIGIN ?? "");
    } catch {
      throw new ConfigurationError("ADMIN_ORIGIN must be an HTTPS origin");
    }
    if (
      origin.protocol !== "https:" ||
      origin.origin !== env.ADMIN_ORIGIN ||
      origin.username ||
      origin.password
    )
      throw new ConfigurationError(
        "ADMIN_ORIGIN must be an HTTPS origin without path",
      );
    const key = env.ADMIN_ENCRYPTION_KEY ?? "";
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
      Buffer.from(key, "base64").length !== 32
    )
      throw new ConfigurationError(
        "ADMIN_ENCRYPTION_KEY must be a 32-byte base64 key",
      );
    const challengeTtlSeconds = Number(
      env.ADMIN_CHALLENGE_TTL_SECONDS ?? "300",
    );
    const adminTtlSeconds = Number(env.ADMIN_SESSION_TTL_SECONDS ?? "28800");
    if (
      !Number.isInteger(challengeTtlSeconds) ||
      challengeTtlSeconds < 1 ||
      challengeTtlSeconds > 300 ||
      !Number.isInteger(adminTtlSeconds) ||
      adminTtlSeconds < 1 ||
      adminTtlSeconds > 28800
    )
      throw new ConfigurationError(
        "Admin challenge/session lifetimes must be within 1..300 / 1..28800 seconds",
      );
    admin = {
      origin: origin.origin,
      encryptionKey: key,
      sessionTtlSeconds: adminTtlSeconds,
      challengeTtlSeconds,
    };
  }
  if (environment === "production" && !admin)
    throw new ConfigurationError(
      "Production requires independent admin origin and encryption key",
    );
  let audioProbe: ApiConfig["audioProbe"];
  if (
    env.AUDIO_PROBE_ENABLED === "local-simulator" ||
    env.AUDIO_PROBE_ENABLED === "oss"
  ) {
    const storageRoot = env.AUDIO_PROBE_STORAGE_ROOT;
    if (!storageRoot?.startsWith("/"))
      throw new ConfigurationError(
        "Audio probe requires an absolute private storage root",
      );
    const ttl = Number(env.AUDIO_PROBE_SESSION_TTL ?? "3600");
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600)
      throw new ConfigurationError("Probe session TTL must be within 1..3600");
    audioProbe = { storageRoot, sessionTtlSeconds: ttl };
    if (env.AUDIO_PROBE_ENABLED === "oss") {
      const fields = [
        "BUCKET",
        "REGION",
        "ACCESS_KEY_ID",
        "ACCESS_KEY_SECRET",
        "SECURITY_TOKEN",
        "EXPIRES_AT",
      ] as const;
      for (const field of fields)
        if (!env[`TIMENOOK_PROBE_OSS_${field}`]?.trim())
          throw new ConfigurationError(
            "TimeNook probe requires complete independent OSS STS configuration",
          );
      const oss: ProbeOssConfig = {
        bucket: env.TIMENOOK_PROBE_OSS_BUCKET!,
        region: env.TIMENOOK_PROBE_OSS_REGION!,
        accessKeyId: env.TIMENOOK_PROBE_OSS_ACCESS_KEY_ID!,
        accessKeySecret: env.TIMENOOK_PROBE_OSS_ACCESS_KEY_SECRET!,
        securityToken: env.TIMENOOK_PROBE_OSS_SECURITY_TOKEN!,
        expiresAt: env.TIMENOOK_PROBE_OSS_EXPIRES_AT!,
      };
      if (
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(oss.bucket) ||
        !/^[a-z]{2}-[a-z0-9-]+$/.test(oss.region) ||
        !Number.isFinite(Date.parse(oss.expiresAt)) ||
        Date.parse(oss.expiresAt) <= Date.now() + 10000
      )
        throw new ConfigurationError(
          "Probe OSS bucket/region or STS expiration is invalid",
        );
      audioProbe.oss = oss;
    }
  } else if (env.AUDIO_PROBE_ENABLED)
    throw new ConfigurationError("Unsupported audio probe adapter");
  let aiProbe: AiProbeConfig | undefined;
  if (env.AI_PROBE_ENABLED) {
    if (
      env.AI_PROBE_ENABLED !== "candidate" ||
      environment === "production" ||
      !audioProbe
    )
      throw new ConfigurationError(
        "AI probe requires explicit candidate mode and a non-production audio probe",
      );
    aiProbe = {
      configVersion: env.TIMENOOK_PROBE_AI_CONFIG_VERSION ?? "",
      doubao: {
        apiKey: env.TIMENOOK_PROBE_DOUBAO_API_KEY ?? "",
        resourceId: env.TIMENOOK_PROBE_DOUBAO_RESOURCE_ID ?? "",
        fetchWindowSeconds: Number(
          env.TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS,
        ),
      },
      deepseek: {
        apiKey: env.TIMENOOK_PROBE_DEEPSEEK_API_KEY ?? "",
        model: env.TIMENOOK_PROBE_DEEPSEEK_MODEL ?? "",
        maxTokens: Number(env.TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS),
      },
    };
    validateAiProbeConfig(aiProbe);
  }
  return {
    aiProbe,
    audioProbe,
    admin,
    environment,
    host: env.API_HOST ?? "127.0.0.1",
    port,
    databaseUrl,
    redisUrl,
    wechat: appId && secret ? { appId, secret } : undefined,
    sessionTtlSeconds,
    redisKeyPrefix: env.REDIS_KEY_PREFIX ?? "timenook",
  };
}

function connectionUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  protocols: string[],
): string {
  const value = env[key];
  if (!value?.trim()) throw new ConfigurationError(`${key} is required`);
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new ConfigurationError(`${key} must be a valid connection URL`);
  }
  return value;
}

export function validateAiProbeConfig(config: AiProbeConfig) {
  if (
    !/^[A-Za-z0-9._-]{1,80}$/.test(config.configVersion) ||
    !["volc.bigasr.auc", "volc.seedasr.auc"].includes(
      config.doubao.resourceId,
    ) ||
    !Number.isInteger(config.doubao.fetchWindowSeconds) ||
    config.doubao.fetchWindowSeconds < 1 ||
    config.doubao.fetchWindowSeconds > 43190 ||
    !/^[A-Za-z0-9._:-]{1,120}$/.test(config.deepseek.model) ||
    !Number.isInteger(config.deepseek.maxTokens) ||
    config.deepseek.maxTokens < 1 ||
    config.deepseek.maxTokens > 32768 ||
    [config.doubao.apiKey, config.deepseek.apiKey].some(
      (key) => !key || /\s|YOUR_|PLACEHOLDER|<|>/i.test(key),
    )
  )
    throw new ConfigurationError(
      "Explicit complete AI probe candidate configuration is required",
    );
}
