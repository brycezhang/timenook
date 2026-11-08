import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";
import { createInternalProject } from "../src/projects/internal-project";
import { USER_TERMS_VERSION } from "@timenook/contracts";
import { bootPrivacyFixture, closePrivacyFixture } from "./privacy-fixture";

const schema = `phone_${randomUUID().replaceAll("-", "")}`;
const origin = "https://localhost:4330";
const headers = { origin, "x-timenook-web": "1" };
const delivered = new Map<
  string,
  { phone: string; code: string; outId: string }
>();
let app: Awaited<ReturnType<typeof createApplication>>;
let config: ApiConfig;
let rejectSms = false;
const options = {
  wechatFetch: async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.pathname === "/cgi-bin/stable_token")
      return Response.json({
        access_token: "synthetic-access",
        expires_in: 7200,
      });
    if (url.pathname === "/wxa/business/getuserphonenumber") {
      const { code } = JSON.parse(String(init?.body));
      return Response.json({
        phone_info: {
          phoneNumber: code,
          purePhoneNumber: code,
          countryCode: "86",
          watermark: { appid: "synthetic-phone-app" },
        },
      });
    }
    return Response.json({
      openid: url.searchParams.get("js_code")!.split(":")[0],
      session_key: "synthetic-key",
    });
  },
  smsSender: {
    async sendOtp(input: { phone: string; code: string; outId: string }) {
      if (rejectSms) throw new Error("supplier rejected with private details");
      delivered.set(input.outId, input);
    },
  },
};
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  url.searchParams.set("schema", schema);
  config = {
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
    environment: "test",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl: url.toString(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: schema,
    web: {
      origin,
      sessionKey: randomBytes(32).toString("base64"),
      loginTtlSeconds: 300,
      sessionTtlSeconds: 43200,
    },
    wechat: { appId: "synthetic-phone-app", secret: "synthetic-secret" },
  };
  const migrated = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      encoding: "utf8",
    },
  );
  assert.equal(migrated.status, 0, "isolated PostgreSQL migrations");
  await bootPrivacyFixture(config);
  app = await createApplication(config, options);
});
after(async () => {
  await app?.close();
  if (!config) return;
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const keys = await redis.keys(`${schema}:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    await db.$disconnect();
    redis.disconnect();
    await closePrivacyFixture(config);
  }
});
async function challenge(phone: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/web/sms-codes",
    headers,
    payload: { phone, termsVersion: USER_TERMS_VERSION },
  });
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  const sms = delivered.get(data.challengeId)!;
  assert.ok(sms, "only the external SMS boundary captures the code");
  assert.doesNotMatch(response.body, new RegExp(sms.code));
  assert.equal(response.headers["cache-control"], "no-store");
  return { ...data, code: sms.code };
}
async function login(phone: string) {
  const proof = await challenge(phone);
  return app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: {
      challengeId: proof.challengeId,
      code: proof.code,
      termsVersion: USER_TERMS_VERSION,
    },
  });
}
function cookieOf(response: { headers: Record<string, unknown> }) {
  return String(response.headers["set-cookie"]).split(";")[0];
}
test("SMS login issues a secure Cookie session, restores the account and consumes its proof once", async () => {
  const proof = await challenge("13800000001");
  const payload = {
    challengeId: proof.challengeId,
    code: proof.code,
    termsVersion: USER_TERMS_VERSION,
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.user.nickname, "用户0001");
  assert.equal(response.json().data.session.token, undefined);
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(response.headers["set-cookie"]), /Secure/);
  const restored = await app.inject({
    method: "GET",
    url: "/v1/web/session",
    headers: { cookie: cookieOf(response) },
  });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(restored.json().data.user, response.json().data.user);
  const replay = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload,
  });
  assert.equal(replay.statusCode, 401);
});

function wechat(phone: string, identity = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/sessions/wechat",
    payload: {
      code: `${identity}:${randomUUID()}`,
      phoneCode: phone,
      termsVersion: USER_TERMS_VERSION,
    },
  });
}
test("web-first and mini-program-first proofs resolve the same account and keep an edited nickname", async () => {
  const web = await login("13800000002");
  assert.equal(web.statusCode, 201, web.body);
  const native = await wechat("13800000002");
  assert.equal(native.statusCode, 201, native.body);
  assert.equal(web.json().data.user.id, native.json().data.user.id);
  const otherNative = await wechat("13800000003");
  assert.equal(otherNative.statusCode, 201);
  await app.inject({
    method: "POST",
    url: "/v1/users/me/profile",
    headers: {
      authorization: `Bearer ${otherNative.json().data.session.token}`,
    },
    payload: { nickname: "家人的故事" },
  });
  const otherWeb = await login("+8613800000003");
  assert.equal(otherWeb.statusCode, 201, otherWeb.body);
  assert.equal(otherWeb.json().data.user.id, otherNative.json().data.user.id);
  assert.equal(otherWeb.json().data.user.nickname, "家人的故事");
});
test("concurrent first web and WeChat login converge on one account", async () => {
  const proof = await challenge("13800000004");
  const [web, native] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/v1/web/session",
      headers,
      payload: {
        challengeId: proof.challengeId,
        code: proof.code,
        termsVersion: USER_TERMS_VERSION,
      },
    }),
    wechat("13800000004"),
  ]);
  assert.equal(web.statusCode, 201, web.body);
  assert.equal(native.statusCode, 201, native.body);
  assert.equal(web.json().data.user.id, native.json().data.user.id);
});
test("invalid codes cannot authenticate; five errors invalidate the challenge", async () => {
  const proof = await challenge("13800000005");
  for (let i = 0; i < 5; i++) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/web/session",
      headers,
      payload: {
        challengeId: proof.challengeId,
        code: proof.code === "000000" ? "111111" : "000000",
        termsVersion: USER_TERMS_VERSION,
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["set-cookie"], undefined);
  }
  const consumed = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: {
      challengeId: proof.challengeId,
      code: proof.code,
      termsVersion: USER_TERMS_VERSION,
    },
  });
  assert.equal(consumed.statusCode, 401);
});
test("login requires current terms and the same origin; legacy demo endpoints are absent", async () => {
  for (const attempted of [
    {},
    { ...headers, origin: "https://foreign.invalid" },
  ]) {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/web/sms-codes",
      headers: attempted,
      payload: { phone: "13800000006", termsVersion: USER_TERMS_VERSION },
    });
    assert.equal(denied.statusCode, 403);
  }
  const noTerms = await app.inject({
    method: "POST",
    url: "/v1/web/sms-codes",
    headers,
    payload: { phone: "13800000006" },
  });
  assert.equal(noTerms.statusCode, 400);
  for (const path of [
    "/v1/web/mock-session",
    "/v1/web/mock-purchases",
    "/v1/web/wechat-link",
    "/v1/wechat-links/claim",
  ]) {
    const result = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: {},
    });
    assert.equal(result.statusCode, 404);
  }
  const legacy = await app.inject({
    method: "POST",
    url: "/v1/web/session",
    headers,
    payload: { ticket: "A".repeat(43) },
  });
  assert.equal(legacy.statusCode, 400);
});
test("resend is limited across phone representations and provider failures never sign in", async () => {
  await challenge("13800000007");
  const resent = await app.inject({
    method: "POST",
    url: "/v1/web/sms-codes",
    headers,
    payload: { phone: "+8613800000007", termsVersion: USER_TERMS_VERSION },
  });
  assert.equal(resent.statusCode, 429);
  rejectSms = true;
  try {
    const failed = await app.inject({
      method: "POST",
      url: "/v1/web/sms-codes",
      headers,
      payload: { phone: "13800000008", termsVersion: USER_TERMS_VERSION },
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.headers["set-cookie"], undefined);
    assert.doesNotMatch(failed.body, /supplier|private|13800000008/);
  } finally {
    rejectSms = false;
  }
});
test("logout requires CSRF, revokes only the web session and hides private project lists", async () => {
  const web = await login("13800000009");
  const native = await wechat("13800000009");
  const cookie = cookieOf(web);
  const before = await app.inject({
    method: "GET",
    url: "/v1/participations",
    headers: { cookie },
  });
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(before.json().data, { projects: [] });
  const denied = await app.inject({
    method: "DELETE",
    url: "/v1/web/session",
    headers: { ...headers, cookie },
  });
  assert.equal(denied.statusCode, 403);
  const loggedOut = await app.inject({
    method: "DELETE",
    url: "/v1/web/session",
    headers: { ...headers, cookie, "x-csrf-token": web.json().data.csrfToken },
  });
  assert.equal(loggedOut.statusCode, 204);
  const hidden = await app.inject({
    method: "GET",
    url: "/v1/participations",
    headers: { cookie },
  });
  assert.equal(hidden.statusCode, 401);
  const nativeRemains = await app.inject({
    method: "GET",
    url: "/v1/users/me",
    headers: { authorization: `Bearer ${native.json().data.session.token}` },
  });
  assert.equal(nativeRemains.statusCode, 200);
});
test("a WeChat identity cannot silently change its phone account", async () => {
  const identity = randomUUID();
  const first = await wechat("13800000010", identity);
  assert.equal(first.statusCode, 201);
  const changed = await wechat("13800000011", identity);
  assert.equal(changed.statusCode, 409);
  const current = await app.inject({
    method: "GET",
    url: "/v1/users/me",
    headers: { authorization: `Bearer ${first.json().data.session.token}` },
  });
  assert.equal(current.json().data.id, first.json().data.user.id);
});

test("web and mini-program expose the same purchased and invited projects, with no foreign projects", async () => {
  const native = await wechat("13800000012");
  const other = await wechat("13800000013");
  const mine = await createInternalProject(config, {
    provisionKey: `owned-${randomUUID()}`,
    initiatorUserId: native.json().data.user.id,
    bookTitle: "同号账号的书",
  });
  const invited = await createInternalProject(config, {
    provisionKey: `invited-${randomUUID()}`,
    initiatorUserId: other.json().data.user.id,
    bookTitle: "家人邀请的书",
  });
  const invitation = await app.inject({
    method: "POST",
    url: `/v1/projects/${invited.projectId}/invitations`,
    headers: { authorization: `Bearer ${other.json().data.session.token}` },
  });
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await app.inject({
    method: "POST",
    url: `/v1/invitations/${invitation.json().data.token}/accept`,
    headers: { authorization: `Bearer ${native.json().data.session.token}` },
    payload: { termsVersion: USER_TERMS_VERSION },
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  const web = await login("13800000012");
  const [webList, miniList, foreign] = await Promise.all([
    app.inject({
      method: "GET",
      url: "/v1/participations",
      headers: { cookie: cookieOf(web) },
    }),
    app.inject({
      method: "GET",
      url: "/v1/participations",
      headers: { authorization: `Bearer ${native.json().data.session.token}` },
    }),
    app.inject({
      method: "GET",
      url: "/v1/participations",
      headers: { authorization: `Bearer ${other.json().data.session.token}` },
    }),
  ]);
  assert.equal(webList.statusCode, 200, webList.body);
  assert.deepEqual(webList.json().data, miniList.json().data);
  assert.deepEqual(
    webList
      .json()
      .data.projects.map((p: { projectId: string }) => p.projectId)
      .sort(),
    [mine.projectId, invited.projectId].sort(),
  );
  assert.equal(
    foreign
      .json()
      .data.projects.some(
        (p: { projectId: string }) => p.projectId === mine.projectId,
      ),
    false,
  );
});
