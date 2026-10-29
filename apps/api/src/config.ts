import { readInternalMediaConfig } from "./media/product-runtime";
import {
  readOrdinaryMerchantConfig,
  type WechatPayConfig,
} from "./payments/wechat-pay";
import type { AiProbeConfig } from "./probe/ai-probe";
import {
  effectiveDeepSeekBaseUrl,
  type DeepSeekConfig,
} from "./probe/ai-providers";
import { validOssKeyPrefix, type ProbeOssConfig } from "./probe/oss-objects";

export interface ApiConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  wechat?: { appId: string; secret: string };
  web?: {
    origin: string;
    sessionKey: string;
    loginTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  acceptance?: {
    mode: "internal-acceptance";
    profileVersion: "internal-acceptance-v1";
  };
  payments?: WechatPayConfig;
  // No production D08 approval exists. This mode only exercises isolated tests.
  participation?: { mode: "synthetic-d08" };
  privacyJournal?: { root: string; key: string };
  books?: {
    mode: "synthetic-local";
    storageRoot: string;
    entryBaseUrl: string;
    specificationVersion: string;
    provenanceVersion: string;
    /** May only lower the local 32 MiB preparation ceiling. */
    maxPhotoBytes?: number;
  };
  photos?: {
    mode: "synthetic-local" | "internal-acceptance";
    placement: { widthMm: number; heightMm: number };
  };
  recording?: {
    mode: "synthetic-local" | "internal-acceptance";
    storageRoot: string;
    oss?: ProbeOssConfig;
  };
  transcription?: {
    mode: "synthetic-local" | "internal-acceptance";
    configVersion: string;
    doubao: import("./probe/ai-providers").DoubaoConfig;
    pollIntervalMs: number;
    submissionReservationFen: number;
    deadlineMs: number;
  };
  generation?: {
    mode: "synthetic-local" | "internal-acceptance";
    configVersion: string;
    deepseek: DeepSeekConfig;
    submissionReservationFen: number;
    maxSubmissions: number;
    deadlineMs: number;
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
    sessionKey: string;
    sessionTtlSeconds: number;
    challengeTtlSeconds: number;
    feishu?: { appId: string; appSecret: string; tenantKey: string };
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
  let payments: WechatPayConfig | undefined;
  try {
    payments = readOrdinaryMerchantConfig(
      env,
      appId && secret ? { appId, secret } : undefined,
      environment,
    );
  } catch {
    throw new ConfigurationError(
      "Complete valid ordinary merchant payment configuration and matching server key files are required",
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
  if (
    env.ADMIN_ORIGIN ||
    env.ADMIN_SESSION_KEY ||
    env.ADMIN_FEISHU_APP_ID ||
    env.ADMIN_FEISHU_APP_SECRET ||
    env.ADMIN_FEISHU_TENANT_KEY
  ) {
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
    const key = env.ADMIN_SESSION_KEY ?? "";
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
      Buffer.from(key, "base64").length !== 32
    )
      throw new ConfigurationError(
        "ADMIN_SESSION_KEY must be a 32-byte base64 key",
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
      sessionKey: key,
      sessionTtlSeconds: adminTtlSeconds,
      challengeTtlSeconds,
    };
  }
  if (environment === "production" && !admin)
    throw new ConfigurationError(
      "Production requires independent admin origin and session key",
    );
  const feishuValues = [
    env.ADMIN_FEISHU_APP_ID,
    env.ADMIN_FEISHU_APP_SECRET,
    env.ADMIN_FEISHU_TENANT_KEY,
  ];
  if (feishuValues.some(Boolean)) {
    if (
      !admin ||
      feishuValues.some(
        (value) => !value || value.trim() !== value || value.length > 512,
      ) ||
      !/^cli_[A-Za-z0-9_]+$/.test(env.ADMIN_FEISHU_APP_ID!) ||
      !/^[A-Za-z0-9_-]{3,128}$/.test(env.ADMIN_FEISHU_TENANT_KEY!)
    )
      throw new ConfigurationError(
        "Configure valid admin Feishu app ID, secret and tenant key together",
      );
    admin.feishu = {
      appId: env.ADMIN_FEISHU_APP_ID!,
      appSecret: env.ADMIN_FEISHU_APP_SECRET!,
      tenantKey: env.ADMIN_FEISHU_TENANT_KEY!,
    };
  }
  if (environment === "production" && !admin?.feishu)
    throw new ConfigurationError(
      "Production requires admin Feishu credentials and tenant key",
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
      const credentialMode = env.TIMENOOK_PROBE_OSS_CREDENTIAL_MODE || "sts";
      const keyPrefix = env.TIMENOOK_PROBE_OSS_KEY_PREFIX || undefined;
      if (
        !["sts", "static"].includes(credentialMode) ||
        !validOssKeyPrefix(keyPrefix) ||
        (credentialMode === "static" &&
          (!keyPrefix?.match(/^timenook(?:\/|$)/) ||
            env.TIMENOOK_PROBE_OSS_SECURITY_TOKEN?.trim() ||
            env.TIMENOOK_PROBE_OSS_EXPIRES_AT?.trim()))
      )
        throw new ConfigurationError(
          "Invalid OSS credential mode or project key prefix",
        );
      for (const field of [
        "BUCKET",
        "REGION",
        "ACCESS_KEY_ID",
        "ACCESS_KEY_SECRET",
      ])
        if (!env[`TIMENOOK_PROBE_OSS_${field}`]?.trim())
          throw new ConfigurationError(
            "TimeNook probe requires complete OSS credentials",
          );
      const common = {
        bucket: env.TIMENOOK_PROBE_OSS_BUCKET!,
        region: env.TIMENOOK_PROBE_OSS_REGION!,
        accessKeyId: env.TIMENOOK_PROBE_OSS_ACCESS_KEY_ID!,
        accessKeySecret: env.TIMENOOK_PROBE_OSS_ACCESS_KEY_SECRET!,
        ...(keyPrefix ? { keyPrefix } : {}),
      };
      let oss: ProbeOssConfig;
      if (credentialMode === "static") {
        oss = { ...common, credentialMode: "static" };
      } else {
        if (
          !env.TIMENOOK_PROBE_OSS_SECURITY_TOKEN?.trim() ||
          !env.TIMENOOK_PROBE_OSS_EXPIRES_AT?.trim()
        )
          throw new ConfigurationError(
            "TimeNook probe requires complete OSS STS configuration",
          );
        oss = {
          ...common,
          securityToken: env.TIMENOOK_PROBE_OSS_SECURITY_TOKEN,
          expiresAt: env.TIMENOOK_PROBE_OSS_EXPIRES_AT,
        };
        if (
          !Number.isFinite(Date.parse(oss.expiresAt)) ||
          Date.parse(oss.expiresAt) <= Date.now() + 10000
        )
          throw new ConfigurationError("Probe OSS STS expiration is invalid");
      }
      if (
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(oss.bucket) ||
        !/^[a-z]{2}-[a-z0-9-]+$/.test(oss.region)
      )
        throw new ConfigurationError("Probe OSS bucket/region is invalid");
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
        ...(env.TIMENOOK_PROBE_DEEPSEEK_BASE_URL !== undefined
          ? { baseUrl: env.TIMENOOK_PROBE_DEEPSEEK_BASE_URL }
          : {}),
        apiKey: env.TIMENOOK_PROBE_DEEPSEEK_API_KEY ?? "",
        model: env.TIMENOOK_PROBE_DEEPSEEK_MODEL ?? "",
        maxTokens: Number(env.TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS),
      },
    };
    validateAiProbeConfig(aiProbe);
    aiProbe.deepseek.baseUrl = effectiveDeepSeekBaseUrl(
      aiProbe.deepseek.baseUrl,
    );
  }
  let privacyJournal: ApiConfig["privacyJournal"];
  if (env.PRIVACY_JOURNAL_ROOT || env.PRIVACY_JOURNAL_KEY) {
    if (
      !env.PRIVACY_JOURNAL_ROOT?.startsWith("/") ||
      !env.PRIVACY_JOURNAL_KEY?.match(/^[A-Za-z0-9+/]{43}=$/) ||
      Buffer.from(env.PRIVACY_JOURNAL_KEY, "base64").length !== 32
    )
      throw new ConfigurationError(
        "Independent privacy journal requires an absolute root and 32-byte key",
      );
    privacyJournal = {
      root: env.PRIVACY_JOURNAL_ROOT,
      key: env.PRIVACY_JOURNAL_KEY,
    };
  }
  const internalMedia = readInternalMediaConfig(env);
  return {
    ...internalMedia,
    acceptance:
      env.INTERNAL_ACCEPTANCE_ENABLED === "1"
        ? {
            mode: "internal-acceptance",
            profileVersion: "internal-acceptance-v1",
          }
        : undefined,
    web: readWebConfig(env),
    payments,
    privacyJournal,
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

export function validateWebConfig(web: NonNullable<ApiConfig["web"]>) {
  let origin: URL;
  try {
    origin = new URL(web.origin);
  } catch {
    throw new ConfigurationError("Web login requires an HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== web.origin ||
    origin.username ||
    origin.password ||
    !/^[A-Za-z0-9+/]{43}=$/.test(web.sessionKey) ||
    Buffer.from(web.sessionKey, "base64").length !== 32 ||
    !Number.isInteger(web.loginTtlSeconds) ||
    web.loginTtlSeconds < 1 ||
    web.loginTtlSeconds > 900 ||
    !Number.isInteger(web.sessionTtlSeconds) ||
    web.sessionTtlSeconds < 1 ||
    web.sessionTtlSeconds > 43200
  )
    throw new ConfigurationError(
      "Web login requires a 32-byte key and bounded secure session configuration",
    );
}

function readWebConfig(env: NodeJS.ProcessEnv): ApiConfig["web"] {
  if (
    !env.WEB_ORIGIN &&
    !env.WEB_SESSION_KEY &&
    !env.WEB_LOGIN_TTL_SECONDS &&
    !env.WEB_SESSION_TTL_SECONDS
  )
    return undefined;
  const web = {
    origin: env.WEB_ORIGIN ?? "",
    sessionKey: env.WEB_SESSION_KEY ?? "",
    loginTtlSeconds: Number(env.WEB_LOGIN_TTL_SECONDS ?? "900"),
    sessionTtlSeconds: Number(env.WEB_SESSION_TTL_SECONDS ?? "43200"),
  };
  validateWebConfig(web);
  return web;
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
  try {
    effectiveDeepSeekBaseUrl(config.deepseek.baseUrl);
  } catch {
    throw new ConfigurationError("Invalid DeepSeek candidate base URL");
  }
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
