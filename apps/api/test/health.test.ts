import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "../src/application";

test("malformed URLs use the standard error without echoing query data", async () => {
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unavailable",
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    for (const path of ["/%FF", "/%ZZ"]) {
      const response = await app.inject({
        method: "GET",
        url: `${path}?secret=private-probe`,
        headers: { "x-request-id": "client-supplied-id" },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json().error, {
        code: "INVALID_REQUEST",
        message: "Invalid request",
        retryable: false,
      });
      assert.match(response.json().meta.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(response.headers["x-request-id"], response.json().meta.requestId);
      assert.doesNotMatch(response.body, /private-probe|client-supplied-id|%FF|%ZZ/);
    }
  } finally {
    await app.close();
  }
});

test("oversized JSON is reported as a client payload error", async () => {
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unavailable",
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/health/live",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x".repeat(1024 * 1024) }),
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json().error, {
      code: "PAYLOAD_TOO_LARGE",
      message: "Request payload is too large",
      retryable: false,
    });
    assert.equal(response.headers["x-request-id"], response.json().meta.requestId);
  } finally {
    await app.close();
  }
});

test("liveness responds with a request ID without requiring database or Redis", async () => {
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl:
      "postgresql://unused:unused@127.0.0.1:1/unavailable?connect_timeout=1",
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "client-supplied-id" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, {
      status: "ok",
      service: "timenook-api",
      version: "0.1.0",
    });
    assert.match(response.json().meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(
      response.headers["x-request-id"],
      response.json().meta.requestId,
    );
  } finally {
    await app.close();
  }
});

test("readiness succeeds against migrated PostgreSQL and Redis", async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "Set DATABASE_URL for the local integration database",
  );
  assert.ok(
    process.env.REDIS_URL,
    "Set REDIS_URL for the local integration Redis",
  );
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.status, "ready");
  } finally {
    await app.close();
  }
});

test("Redis failure returns a retryable 503 without leaking connection details", async () => {
  assert.ok(process.env.DATABASE_URL);
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: "redis://private-user:private-password@127.0.0.1:1",
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json().error, {
      code: "SERVICE_UNAVAILABLE",
      message: "Service is not ready",
      retryable: true,
    });
    assert.equal(
      response.json().meta.requestId,
      response.headers["x-request-id"],
    );
    assert.doesNotMatch(
      response.body,
      /private-user|private-password|127\.0\.0\.1/,
    );
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("readiness rejects an unavailable database while Redis remains reachable", async () => {
  assert.ok(process.env.REDIS_URL);
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl:
      "postgresql://unused:private-password@127.0.0.1:1/unavailable?connect_timeout=1",
    redisUrl: process.env.REDIS_URL,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "SERVICE_UNAVAILABLE");
    assert.doesNotMatch(
      response.body,
      /private-password|postgresql|127\.0\.0\.1/,
    );
  } finally {
    await app.close();
  }
});

test("OpenAPI documents readiness success and the standard failure envelope", async () => {
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unavailable",
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.ok(spec.paths["/health/live"].get.responses["200"]);
    assert.ok(spec.paths["/health/ready"].get.responses["503"]);
    assert.ok(spec.components.schemas.ErrorResponseDto.properties.error);
  } finally {
    await app.close();
  }
});

test("a reachable database without application migrations is not ready", async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  const database = new URL(process.env.DATABASE_URL);
  database.searchParams.set("schema", "timenook_missing_schema");
  const app = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: database.toString(),
    redisUrl: process.env.REDIS_URL,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(response.statusCode, 503);
  } finally {
    await app.close();
  }
});

test("production hides API docs and uses a non-leaking error envelope", async () => {
  const app = await createApplication({
    environment: "production",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unavailable",
    redisUrl: "redis://127.0.0.1:1",
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/openapi.json?secret=private-value",
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "NOT_FOUND");
    assert.equal(
      response.json().meta.requestId,
      response.headers["x-request-id"],
    );
    assert.doesNotMatch(response.body, /private-value/);
  } finally {
    await app.close();
  }
});
