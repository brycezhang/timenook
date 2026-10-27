import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../src/application";
import { ConfigurationError, type ApiConfig } from "../src/config";
import { paymentConfig, paymentFetch } from "./payment-fixture";

const healthOnly: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 3417,
  databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unavailable",
  redisUrl: "redis://127.0.0.1:1",
};

test("identity and health without a privacy source expose no private product routes", async () => {
  const app = await createApplication({
    ...healthOnly,
    wechat: { appId: "synthetic-privacy-gate", secret: "synthetic" },
  });
  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    const id = randomUUID();
    for (const url of [
      "/v1/orders",
      `/v1/orders/${id}`,
      "/v1/participations",
      `/v1/projects/${id}`,
      `/v1/projects/${id}/participation`,
      `/v1/projects/${id}/care-requests`,
      `/v1/projects/${id}/deletion-status`,
      "/v1/admin/care-requests",
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, `${url} must remain unavailable`);
      assert.equal(response.json().error.code, "NOT_FOUND");
    }
  } finally {
    await app.close();
  }
});

test("private product capabilities require an explicit independent source before initialization", async () => {
  for (const enabled of [
    {},
    { participation: { mode: "synthetic-d08" } },
    {
      participation: { mode: "synthetic-d08" },
      recording: { mode: "synthetic-local", storageRoot: "/tmp/timenook-gate-unused" },
    },
  ] satisfies Partial<ApiConfig>[]) {
    await assert.rejects(
      async () => {
        const app = await createApplication(
          {
            ...healthOnly,
            wechat: { appId: paymentConfig.appId, secret: "synthetic" },
            payments: paymentConfig,
            ...enabled,
          },
          { paymentFetch },
        );
        await app.close();
      },
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /independent privacy journal/.test(error.message),
    );
  }
});
