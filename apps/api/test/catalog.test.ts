import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "otplib";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

const origin = "https://localhost:3443";
const key = randomBytes(32).toString("base64");
const privateDir = mkdtempSync(join(tmpdir(), "t08-catalog-"));
const schema = `t08_${randomUUID().replaceAll("-", "")}`;
let config: ApiConfig;
let app: Awaited<ReturnType<typeof createApplication>>;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.REDIS_URL);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  config = {
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL,
    redisKeyPrefix: schema,
    admin: {
      origin,
      encryptionKey: key,
      sessionTtlSeconds: 28800,
      challengeTtlSeconds: 300,
    },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "Isolated migration failed");
  app = await createApplication(config);
});
after(async () => {
  await app?.close();
  rmSync(privateDir, { recursive: true, force: true });
  if (!config) return;
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  try {
    await database.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    );
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await database.$disconnect();
    redis.disconnect();
  }
});

function createAccount(
  permissions = [
    "catalog:read",
    "catalog:write",
    "catalog:freeze",
    "audit:read",
  ],
) {
  const username = `operator-${randomUUID()}`;
  const password = randomBytes(24).toString("base64url");
  const input = join(privateDir, `${randomUUID()}.json`);
  writeFileSync(
    input,
    JSON.stringify({ username, password, permissions, realm: "local" }),
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    ["dist-test/src/admin/admin-cli.js", "create", "--input-file", input],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: config.databaseUrl,
        ADMIN_ORIGIN: origin,
        ADMIN_ENCRYPTION_KEY: key,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
  return { username, password, id: JSON.parse(result.stdout).id };
}
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return String(Array.isArray(value) ? value[0] : value).split(";")[0];
}
async function begin(account: ReturnType<typeof createAccount>, target = app) {
  const bootstrap = await target.inject({
    method: "GET",
    url: "/v1/admin/session",
  });
  assert.equal(bootstrap.statusCode, 200);
  const response = await target.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: {
      origin,
      cookie: cookie(bootstrap),
      "x-csrf-token": bootstrap.json().data.csrfToken,
    },
    payload: account.username
      ? { username: account.username, password: account.password }
      : {},
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: cookie(response),
    csrf: response.json().data.csrfToken,
    response,
  };
}
async function authenticate(account = createAccount(), target = app) {
  const challenge = await begin(account, target);
  const enrollment = await target.inject({
    method: "GET",
    url: "/v1/admin/mfa/enrollment",
    headers: { cookie: challenge.cookie },
  });
  assert.equal(enrollment.statusCode, 200);
  const secret = enrollment.json().data.secret;
  const code = await generate({ secret });
  const response = await target.inject({
    method: "POST",
    url: "/v1/admin/mfa",
    headers: {
      cookie: challenge.cookie,
      origin,
      "x-csrf-token": challenge.csrf,
    },
    payload: { code },
  });
  assert.equal(response.statusCode, 200);
  return {
    account,
    secret,
    code,
    cookie: cookie(response),
    csrf: response.json().data.csrfToken,
    response,
    challenge,
  };
}

const writeHeaders = (auth: Awaited<ReturnType<typeof authenticate>>) => ({
  cookie: auth.cookie,
  origin,
  "x-csrf-token": auth.csrf,
});
test("operators create a dynamic relationship with a stable code; public catalog has no seeded parents", async () => {
  const empty = await app.inject({ method: "GET", url: "/v1/recipient-types" });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().data.types, []);
  const auth = await authenticate();
  const created = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/recipient-types",
    headers: writeHeaders(auth),
    payload: { code: "mentor", label: "恩师", sortOrder: 20, active: true },
  });
  assert.equal(created.statusCode, 201);
  const catalog = await app.inject({
    method: "GET",
    url: "/v1/recipient-types",
  });
  assert.deepEqual(catalog.json().data.types, [
    { code: "mentor", label: "恩师", revision: 1 },
  ]);
  assert.equal(catalog.json().data.customLabelAllowed, true);
});

test("relationship ordering and disabling use revisions; duplicate codes and concurrent stale edits cannot overwrite a winner", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const created = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/recipient-types",
    headers,
    payload: { code: "friend", label: "朋友", sortOrder: 10, active: true },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/admin/catalog/recipient-types",
        headers,
        payload: {
          code: "friend",
          label: "不能覆盖",
          sortOrder: 1,
          active: true,
        },
      })
    ).statusCode,
    409,
  );
  const before = await app.inject({
    method: "GET",
    url: "/v1/recipient-types",
  });
  assert.deepEqual(
    before.json().data.types.map((item: { code: string }) => item.code),
    ["friend", "mentor"],
  );
  const edits = await Promise.all(
    [30, 40].map((sortOrder) =>
      app.inject({
        method: "PUT",
        url: "/v1/admin/catalog/recipient-types/friend",
        headers,
        payload: {
          expectedRevision: 1,
          label: "挚友",
          sortOrder,
          active: false,
        },
      }),
    ),
  );
  assert.deepEqual(edits.map((r) => r.statusCode).sort(), [200, 409]);
  const restarted = await createApplication(config);
  try {
    const list = await restarted.inject({
      method: "GET",
      url: "/v1/admin/catalog/recipient-types",
      headers,
    });
    assert.equal(list.statusCode, 200);
    const friend = list
      .json()
      .data.find((item: { code: string }) => item.code === "friend");
    assert.equal(friend.revision, 2);
    assert.equal(friend.active, false);
    assert.equal(
      (
        await restarted.inject({ method: "GET", url: "/v1/recipient-types" })
      ).json().data.types.length,
      1,
    );
    assert.equal(
      (
        await restarted.inject({
          method: "PUT",
          url: "/v1/admin/catalog/recipient-types/friend",
          headers,
          payload: {
            expectedRevision: 2,
            code: "replacement",
            label: "挚友",
            sortOrder: 10,
            active: true,
          },
        })
      ).statusCode,
      400,
    );
  } finally {
    await restarted.close();
  }
});

test("incomplete package parameters can be saved and resumed as a draft but cannot be frozen or offered to buyers", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const saved = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/package-drafts",
    headers,
    payload: { title: "本地待补草稿", d01: {}, admission: {} },
  });
  assert.equal(saved.statusCode, 201);
  const draft = saved.json().data;
  assert.equal(draft.revision, 1);
  assert.equal(draft.validation.completeness, "incomplete");
  assert.equal(draft.validation.salesAuthorized, false);
  assert.equal(draft.validation.approval, "not_verified");
  const frozen = await app.inject({
    method: "POST",
    url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
    headers,
    payload: { expectedRevision: 1 },
  });
  assert.equal(frozen.statusCode, 422);
  const restored = await app.inject({
    method: "GET",
    url: "/v1/admin/catalog/package-drafts",
    headers,
  });
  assert.equal(
    restored.json().data.find((item: { id: string }) => item.id === draft.id)
      .title,
    "本地待补草稿",
  );
  const current = await app.inject({
    method: "GET",
    url: "/v1/packages/current",
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().data.purchasable, false);
  assert.equal(current.json().data.version, null);
  assert.equal(current.json().data.reason, "PACKAGE_PREPARING");
});

import { readFileSync } from "node:fs";
const synthetic = () =>
  JSON.parse(
    readFileSync(
      join(__dirname, "../../test/fixtures/catalog-synthetic.json"),
      "utf8",
    ),
  );
test("complete synthetic parameters freeze exactly one immutable preview under concurrent replay and remain unavailable for purchase", async (t) => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const saved = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/package-drafts",
    headers,
    payload: synthetic(),
  });
  const draft = saved.json().data;
  assert.equal(draft.validation.completeness, "complete");
  assert.equal(draft.validation.approval, "not_verified");
  const responses = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
        headers,
        payload: { expectedRevision: 1 },
      }),
    ),
  );
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [201, 201],
  );
  const version = responses[0].json().data;
  assert.equal(responses[1].json().data.id, version.id);
  assert.equal(version.purpose, "local_preview");
  const requestId = "d08a0000-0000-4000-8000-000000000001";
  const current = await (async () => {
    const uuid = t.mock.method(crypto, "randomUUID", () => requestId);
    try {
      return await app.inject({ method: "GET", url: "/v1/packages/current" });
    } finally {
      uuid.mock.restore();
    }
  })();
  assert.equal(current.json().meta.requestId, requestId);
  assert.equal(current.json().data.purchasable, false);
  assert.equal(current.json().data.reason, "PREVIEW_ONLY");
  assert.equal(current.json().data.version.id, version.id);
  assert.deepEqual(current.json().data.version.price, {
    value: 99900,
    unit: "fen",
    currency: "CNY",
  });
  assert.deepEqual(current.json().data.version.scope, {
    projects: 1,
    adultSubjects: 1,
    initiators: 1,
    firstCopies: 1,
    agreedShippingIncluded: true,
    completeExportIncluded: true,
  });
  for (const secret of [
    "record:",
    "ownerRef",
    "providerBudget",
    "wx0123456789abcdef",
    "1900000109",
    "supplier",
    "admission",
  ])
    assert.ok(!current.body.includes(secret), secret);
  // Hex UUID values can legitimately contain d08; the internal policy field
  // must be absent throughout the public data object, including nested keys.
  assert.ok(
    !JSON.stringify(current.json().data).includes('"d08":'),
    "d08 field",
  );
  assert.ok(
    current
      .json()
      .data.version.terms.some(
        (term: { label: string; text: string }) =>
          term.label === "制作期限" && term.text.includes("180"),
      ),
  );
  const versions = await app.inject({
    method: "GET",
    url: "/v1/admin/catalog/package-versions",
    headers,
  });
  assert.equal(
    versions
      .json()
      .data.filter((item: { id: string }) => item.id === version.id).length,
    1,
  );
});

test("editing a draft creates a new preview without altering a frozen version; stale edits lose and history survives restart", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const input = synthetic();
  const draft = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers,
      payload: input,
    })
  ).json().data;
  const path = `/v1/admin/catalog/package-drafts/${draft.id}`;
  const first = (
    await app.inject({
      method: "POST",
      url: `${path}/preview-versions`,
      headers,
      payload: { expectedRevision: 1 },
    })
  ).json().data;
  const changes = await Promise.all(
    ["版本二", "并发版本"].map((title) =>
      app.inject({
        method: "PUT",
        url: path,
        headers,
        payload: { ...input, title, expectedRevision: 1 },
      }),
    ),
  );
  assert.deepEqual(changes.map((r) => r.statusCode).sort(), [200, 409]);
  const second = await app.inject({
    method: "POST",
    url: `${path}/preview-versions`,
    headers,
    payload: { expectedRevision: 2 },
  });
  assert.equal(second.statusCode, 201);
  assert.notEqual(second.json().data.id, first.id);
  const replay = await app.inject({
    method: "POST",
    url: `${path}/preview-versions`,
    headers,
    payload: { expectedRevision: 1 },
  });
  assert.deepEqual(replay.json().data, first);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/v1/admin/catalog/package-versions/${first.id}`,
        headers,
        payload: { title: "覆盖" },
      })
    ).statusCode,
    404,
  );
  const restarted = await createApplication(config);
  try {
    const history = (
      await restarted.inject({
        method: "GET",
        url: "/v1/admin/catalog/package-versions",
        headers,
      })
    ).json().data;
    assert.deepEqual(
      history.find((item: { id: string }) => item.id === first.id),
      first,
    );
    assert.equal(
      (
        await restarted.inject({ method: "GET", url: "/v1/packages/current" })
      ).json().data.version.id,
      second.json().data.id,
    );
  } finally {
    await restarted.close();
  }
});

test("invalid catalog inputs are bounded, reject blank labels and malformed IDs, and audit only the fixed action", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  for (const [method, url, payload, action] of [
    [
      "POST",
      "/v1/admin/catalog/recipient-types",
      { code: "blank", label: "   ", sortOrder: 1, active: true },
      "catalog.recipient.create",
    ],
    [
      "PUT",
      "/v1/admin/catalog/package-drafts/not-a-uuid",
      { ...synthetic(), expectedRevision: 1 },
      "catalog.draft.update",
    ],
    [
      "POST",
      "/v1/admin/catalog/package-drafts",
      {
        title: "SAFE_TITLE",
        admission: {},
        d01: {},
        secret: "NEVER_AUDIT_BODY",
      },
      "catalog.draft.create",
    ],
  ] as const) {
    const result = await app.inject({ method, url, headers, payload });
    assert.equal(result.statusCode, 400);
    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers,
    });
    const records = audit
      .json()
      .data.filter(
        (entry: { requestId: string }) =>
          entry.requestId === result.headers["x-request-id"],
      );
    assert.equal(records.length, 1);
    assert.equal(records[0].action, action);
    assert.equal(records[0].operatorId, auth.account.id);
    assert.ok(!audit.body.includes("NEVER_AUDIT_BODY"));
    assert.ok(!audit.body.includes("SAFE_TITLE"));
  }
});

test("catalog read, write and preview permissions stay separate and every write requires full session, Origin and session CSRF", async () => {
  const full = await authenticate();
  const readonly = await authenticate(createAccount(["catalog:read"]));
  const ops = await authenticate(createAccount(["ops:read"]));
  const writer = await authenticate(createAccount(["catalog:write"]));
  const pending = await begin(createAccount());
  const draft = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers: writeHeaders(full),
      payload: synthetic(),
    })
  ).json().data;
  const commands = [
    {
      method: "POST" as const,
      url: "/v1/admin/catalog/recipient-types",
      payload: {
        code: `role-${randomUUID()}`.slice(0, 35),
        label: "朋友",
        sortOrder: 1,
        active: true,
      },
    },
    {
      method: "PUT" as const,
      url: "/v1/admin/catalog/recipient-types/mentor",
      payload: {
        expectedRevision: 1,
        label: "老师",
        sortOrder: 1,
        active: true,
      },
    },
    {
      method: "POST" as const,
      url: "/v1/admin/catalog/package-drafts",
      payload: synthetic(),
    },
    {
      method: "PUT" as const,
      url: `/v1/admin/catalog/package-drafts/${draft.id}`,
      payload: { ...synthetic(), expectedRevision: 1 },
    },
    {
      method: "POST" as const,
      url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
      payload: { expectedRevision: 1 },
    },
  ];
  for (const command of commands) {
    for (const headers of [
      {},
      { cookie: pending.cookie, origin, "x-csrf-token": pending.csrf },
    ])
      assert.equal((await app.inject({ ...command, headers })).statusCode, 401);
    for (const headers of [
      writeHeaders(readonly),
      writeHeaders(ops),
      { cookie: full.cookie, origin },
      { cookie: full.cookie, origin, "x-csrf-token": "wrong" },
      { cookie: full.cookie, "x-csrf-token": full.csrf },
      { ...writeHeaders(full), origin: "https://foreign.example" },
      { ...writeHeaders(full), "sec-fetch-site": "cross-site" },
      { ...writeHeaders(full), "x-csrf-token": readonly.csrf },
    ])
      assert.equal((await app.inject({ ...command, headers })).statusCode, 403);
  }
  assert.equal(
    (await app.inject({ ...commands[4], headers: writeHeaders(writer) }))
      .statusCode,
    403,
  );
  for (const path of [
    "recipient-types",
    "package-drafts",
    "package-versions",
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/catalog/${path}`,
          headers: writeHeaders(ops),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/catalog/${path}`,
          headers: writeHeaders(readonly),
        })
      ).statusCode,
      200,
    );
  }
});

test("a catalog audit failure rolls the write back; retry succeeds once and audit contains no commercial body", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const input = {
    code: "audit-check",
    label: "私密合成称呼",
    sortOrder: 1,
    active: true,
  };
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/admin/catalog/recipient-types",
          headers,
          payload: input,
        })
      ).statusCode,
      500,
    );
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
    await database.$disconnect();
  }
  assert.ok(
    !(await app.inject({ method: "GET", url: "/v1/recipient-types" }))
      .json()
      .data.types.some((item: { code: string }) => item.code === input.code),
  );
  const retry = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/recipient-types",
    headers,
    payload: input,
  });
  assert.equal(retry.statusCode, 201);
  const audits = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers,
  });
  assert.equal(
    audits
      .json()
      .data.filter(
        (record: { requestId: string }) =>
          record.requestId === retry.headers["x-request-id"],
      ).length,
    1,
  );
  assert.ok(!audits.body.includes(input.label));
});

test("complete-looking commercial files still require a frozen complete D01 and all D02–D08 decisions", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  for (const change of [
    (value: ReturnType<typeof synthetic>) => {
      value.d01.review.state = "candidate";
    },
    (value: ReturnType<typeof synthetic>) => {
      value.d01.fontLicenseRef = null;
    },
    (value: ReturnType<typeof synthetic>) => {
      value.admission.d04.userQuotas.photos.value = null;
    },
    (value: ReturnType<typeof synthetic>) => {
      value.admission.d08.platform.iosPayment.outcome = "pending";
    },
  ]) {
    const input = synthetic();
    change(input);
    const saved = (
      await app.inject({
        method: "POST",
        url: "/v1/admin/catalog/package-drafts",
        headers,
        payload: input,
      })
    ).json().data;
    assert.equal(saved.validation.completeness, "incomplete");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/catalog/package-drafts/${saved.id}/preview-versions`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      422,
    );
  }
});

test("D01 review metadata rejects placeholder references and noncanonical UTC times through draft and freeze HTTP", async () => {
  const headers = writeHeaders(await authenticate());
  const cases = [
    { field: "fontLicenseRef", value: "record:pending" },
    { field: "review.ownerRef", value: "record:operations/tbd" },
    { field: "review.decisionRef", value: "record:decision.approved" },
    { field: "review.decidedAt", value: "2026-02-30T08:00:00Z" },
    { field: "review.decidedAt", value: "2026-10-22T08:00:00+00:00" },
  ];
  for (const { field, value } of cases) {
    const input = synthetic();
    if (field === "fontLicenseRef") input.d01.fontLicenseRef = value;
    else input.d01.review[field.slice("review.".length)] = value;
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers,
      payload: input,
    });
    assert.equal(response.statusCode, 201);
    const saved = response.json().data;
    assert.equal(saved.validation.completeness, "incomplete");
    assert.deepEqual(saved.validation.issues, [
      {
        path: `d01.${field}`,
        code: "PRINT_SPEC_REQUIRED",
        message: "须填写冻结的完整印刷规格及审核引用；候选打样参数不能替代。",
      },
    ]);
    const frozen = await app.inject({
      method: "POST",
      url: `/v1/admin/catalog/package-drafts/${saved.id}/preview-versions`,
      headers,
      payload: { expectedRevision: 1 },
    });
    assert.equal(frozen.statusCode, 422);
    assert.equal(frozen.json().error.code, "INVALID_PACKAGE");
  }
});

test("production cannot read local catalog or preview versions and even its authenticated operator cannot freeze previews", async () => {
  const account = createAccount();
  // Fixture provisioning only: give the synthetic operator a production realm.
  // Every authority and catalog outcome below is observed through HTTP.
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  await database.adminAccount.update({
    where: { id: account.id },
    data: { realm: "production" },
  });
  await database.$disconnect();
  const production = await createApplication({
    ...config,
    environment: "production",
  });
  try {
    const auth = await authenticate(account, production);
    const headers = writeHeaders(auth);
    assert.deepEqual(
      (
        await production.inject({ method: "GET", url: "/v1/recipient-types" })
      ).json().data.types,
      [],
    );
    assert.deepEqual(
      (
        await production.inject({ method: "GET", url: "/v1/packages/current" })
      ).json().data,
      { purchasable: false, reason: "PACKAGE_PREPARING", version: null },
    );
    assert.deepEqual(
      (
        await production.inject({
          method: "GET",
          url: "/v1/admin/catalog/package-versions",
          headers,
        })
      ).json().data,
      [],
    );
    const draft = (
      await production.inject({
        method: "POST",
        url: "/v1/admin/catalog/package-drafts",
        headers,
        payload: synthetic(),
      })
    ).json().data;
    assert.equal(
      (
        await production.inject({
          method: "POST",
          url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await production.inject({ method: "GET", url: "/v1/packages/current" })
      ).json().data.version,
      null,
    );
  } finally {
    await production.close();
  }
});

test("separate operators racing to freeze a revision receive the same durable version", async () => {
  const one = await authenticate();
  const two = await authenticate();
  const draft = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers: writeHeaders(one),
      payload: synthetic(),
    })
  ).json().data;
  const replies = await Promise.all(
    [one, two].map((auth) =>
      app.inject({
        method: "POST",
        url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
        headers: writeHeaders(auth),
        payload: { expectedRevision: 1 },
      }),
    ),
  );
  assert.deepEqual(
    replies.map((reply) => reply.statusCode),
    [201, 201],
  );
  assert.equal(replies[0].json().data.id, replies[1].json().data.id);
});

test("public delivery terms use explicit human-readable region names and photo quotas use sheets; incomplete labels cannot freeze", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const input = {
    ...synthetic(),
    shippingRegionLabels: {
      "CN-110000": "北京地区（合成）",
      "CN-310000": "上海地区（合成）",
      "CN-810000": "香港地区（合成）",
    },
  };
  const saved = await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/package-drafts",
    headers,
    payload: input,
  });
  assert.equal(saved.statusCode, 201);
  const draft = saved.json().data;
  const frozen = await app.inject({
    method: "POST",
    url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
    headers,
    payload: { expectedRevision: 1 },
  });
  assert.equal(frozen.statusCode, 201);
  const terms = frozen.json().data.terms;
  const shipping = terms.find(
    (term: { label: string }) => term.label === "配送范围",
  ).text;
  assert.ok(shipping.includes("北京地区（合成）"));
  assert.ok(!shipping.includes("CN-"));
  assert.ok(
    terms
      .find((term: { label: string }) => term.label === "照片额度")
      .text.includes("80 张"),
  );
  const incomplete = {
    ...input,
    shippingRegionLabels: { "CN-110000": "北京地区（合成）" },
  };
  const invalid = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers,
      payload: incomplete,
    })
  ).json().data;
  assert.equal(invalid.validation.completeness, "incomplete");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/admin/catalog/package-drafts/${invalid.id}/preview-versions`,
        headers,
        payload: { expectedRevision: 1 },
      })
    ).statusCode,
    422,
  );
});

test("frozen preview exposes a stable content hash and documented consumer DTOs without internal review fields", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const version = (
    await app.inject({ method: "GET", url: "/v1/packages/current" })
  ).json().data.version;
  assert.match(version.contentHash, /^[a-f0-9]{64}$/);
  const restarted = await createApplication(config);
  try {
    assert.equal(
      (
        await restarted.inject({ method: "GET", url: "/v1/packages/current" })
      ).json().data.version.contentHash,
      version.contentHash,
    );
  } finally {
    await restarted.close();
  }
  const doc = (
    await app.inject({ method: "GET", url: "/openapi.json" })
  ).json();
  assert.equal(
    doc.paths["/v1/packages/current"].get.responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/CurrentPackageResponseDto",
  );
  assert.equal(
    doc.paths["/v1/recipient-types"].get.responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/RecipientCatalogResponseDto",
  );
  assert.ok(
    doc.paths[
      "/v1/admin/catalog/package-drafts/{id}/preview-versions"
    ].post.security.some(
      (entry: Record<string, unknown>) => "timenook-admin" in entry,
    ),
  );
  const incomplete = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers,
      payload: { title: "缺参", d01: {}, admission: {} },
    })
  ).json().data;
  const rejected = await app.inject({
    method: "POST",
    url: `/v1/admin/catalog/package-drafts/${incomplete.id}/preview-versions`,
    headers,
    payload: { expectedRevision: 1 },
  });
  assert.equal(rejected.json().error.code, "INVALID_PACKAGE");
});

test("freeze audit failure rolls back its version and a fresh retry recovers without duplicates", async () => {
  const auth = await authenticate();
  const headers = writeHeaders(auth);
  const draft = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers,
      payload: synthetic(),
    })
  ).json().data;
  const old = (
    await app.inject({ method: "GET", url: "/v1/packages/current" })
  ).json().data.version.id;
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const command = {
    method: "POST" as const,
    url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
    headers,
    payload: { expectedRevision: 1 },
  };
  try {
    await database.$executeRawUnsafe(
      "ALTER TABLE admin_audit RENAME TO unavailable_audit",
    );
    assert.equal((await app.inject(command)).statusCode, 500);
  } finally {
    await database.$executeRawUnsafe(
      "ALTER TABLE unavailable_audit RENAME TO admin_audit",
    );
    await database.$disconnect();
  }
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/packages/current" })).json()
      .data.version.id,
    old,
  );
  const recovered = await app.inject(command);
  assert.equal(recovered.statusCode, 201);
  const replay = await app.inject(command);
  assert.equal(replay.json().data.id, recovered.json().data.id);
});

test("expired catalog writer sessions cannot edit or freeze even if their CSRF is still well formed", async () => {
  const short = await createApplication({
    ...config,
    admin: { ...config.admin!, sessionTtlSeconds: 1 },
  });
  try {
    const auth = await authenticate(createAccount(), short);
    const headers = writeHeaders(auth);
    const draft = (
      await short.inject({
        method: "POST",
        url: "/v1/admin/catalog/package-drafts",
        headers,
        payload: synthetic(),
      })
    ).json().data;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/admin/catalog/package-drafts/${draft.id}`,
          headers,
          payload: { ...synthetic(), expectedRevision: 1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/catalog/package-drafts/${draft.id}/preview-versions`,
          headers,
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      401,
    );
  } finally {
    await short.close();
  }
});

test("independent operators cannot overwrite a relationship or draft from the same stale revision", async () => {
  const one = await authenticate();
  const two = await authenticate();
  await app.inject({
    method: "POST",
    url: "/v1/admin/catalog/recipient-types",
    headers: writeHeaders(one),
    payload: {
      code: "concurrent",
      label: "合成关系",
      sortOrder: 0,
      active: true,
    },
  });
  const edits = await Promise.all(
    [one, two].map((auth, index) =>
      app.inject({
        method: "PUT",
        url: "/v1/admin/catalog/recipient-types/concurrent",
        headers: writeHeaders(auth),
        payload: {
          expectedRevision: 1,
          label: `合成称呼${index}`,
          sortOrder: index,
          active: true,
        },
      }),
    ),
  );
  assert.deepEqual(
    edits.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const draft = (
    await app.inject({
      method: "POST",
      url: "/v1/admin/catalog/package-drafts",
      headers: writeHeaders(one),
      payload: synthetic(),
    })
  ).json().data;
  const changes = await Promise.all(
    [one, two].map((auth, index) =>
      app.inject({
        method: "PUT",
        url: `/v1/admin/catalog/package-drafts/${draft.id}`,
        headers: writeHeaders(auth),
        payload: {
          ...synthetic(),
          title: `合成修订${index}`,
          expectedRevision: 1,
        },
      }),
    ),
  );
  assert.deepEqual(
    changes.map((response) => response.statusCode).sort(),
    [200, 409],
  );
});
