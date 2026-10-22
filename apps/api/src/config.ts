export interface ApiConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
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
  return {
    environment,
    host: env.API_HOST ?? "127.0.0.1",
    port,
    databaseUrl,
    redisUrl,
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
