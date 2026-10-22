import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("production refuses to start without database configuration", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  const result = spawnSync(
    process.execPath,
    [resolve(__dirname, "../src/main.js")],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

for (const scenario of [
  {
    name: "missing Redis URL",
    overrides: { REDIS_URL: "" },
    message: /REDIS_URL is required/,
  },
  {
    name: "malformed connection URL",
    overrides: { DATABASE_URL: "invalid-private-value" },
    message: /DATABASE_URL must be a valid connection URL/,
  },
  {
    name: "invalid port",
    overrides: { API_PORT: "70000" },
    message: /API_PORT must be an integer/,
  },
  {
    name: "production example credentials",
    overrides: {
      NODE_ENV: "production",
      DATABASE_URL:
        "postgresql://timenook:local-development-only@localhost/timenook",
    },
    message: /Production requires independent database credentials/,
  },
  {
    name: "production missing WeChat identity",
    overrides: {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
      TIMENOOK_WECHAT_APP_ID: "",
      TIMENOOK_WECHAT_APP_SECRET: "",
    },
    message: /Production requires TimeNook WeChat credentials/,
  },
  {
    name: "partial WeChat identity configuration",
    overrides: {
      TIMENOOK_WECHAT_APP_ID: "synthetic",
      TIMENOOK_WECHAT_APP_SECRET: "",
    },
    message: /Configure both TimeNook WeChat credentials/,
  },
  {
    name: "invalid session lifetime",
    overrides: { SESSION_TTL_SECONDS: "0" },
    message: /SESSION_TTL_SECONDS must be/,
  },
]) {
  test(`startup rejects ${scenario.name}`, () => {
    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, "../src/main.js")],
      {
        env: { ...process.env, NODE_ENV: "development", ...scenario.overrides },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.message);
    assert.doesNotMatch(
      result.stderr,
      /invalid-private-value|local-development-only/,
    );
  });
}
