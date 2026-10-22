export interface ApiConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  wechat?: { appId: string; secret: string };
  sessionTtlSeconds?: number;
  redisKeyPrefix?: string;
  loginLimitPerMinute?: number;
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
  return {
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
