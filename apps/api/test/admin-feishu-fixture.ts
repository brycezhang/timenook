import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createApplication } from "../src/application";
import type { ApiConfig } from "../src/config";

export const syntheticFeishu = {
  appId: "cli_synthetic_admin",
  appSecret: "synthetic-admin-secret",
  tenantKey: "synthetic-admin-tenant",
};
export const syntheticFeishuFetch: typeof fetch = async (input, init) => {
  if (String(input) === "https://accounts.feishu.cn/oauth/v3/token") {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.client_id, syntheticFeishu.appId);
    assert.ok(body.code_verifier);
    return new Response(JSON.stringify({ code: 0, access_token: body.code }));
  }
  assert.equal(
    String(input),
    "https://open.feishu.cn/open-apis/authen/v1/user_info",
  );
  const token = new Headers(init?.headers).get("authorization")!.slice(7);
  const identity = JSON.parse(Buffer.from(token, "base64url").toString());
  return new Response(
    JSON.stringify({
      code: 0,
      data: { open_id: identity.feishuOpenId, tenant_key: identity.tenantKey },
    }),
  );
};

/** Only external identity requests are substituted; sessions/CLI/DB/Redis remain real. */
export const createAdminApplication: typeof createApplication = (
  config,
  options = {},
) => {
  if (config.admin && !config.admin.feishu)
    config.admin.feishu = { ...syntheticFeishu };
  return createApplication(config, {
    ...(config.environment === "test"
      ? { feishuFetch: syntheticFeishuFetch }
      : {}),
    ...options,
  });
};
export function createFeishuAccount(
  config: ApiConfig,
  permissions = ["ops:read", "audit:read"],
) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-admin-"));
  const account = {
    username: `synthetic-${randomUUID()}`,
    realm: config.environment === "production" ? "production" : "local",
    feishuAppId: config.admin!.feishu!.appId,
    feishuOpenId: `ou_${randomUUID().replaceAll("-", "")}`,
    tenantKey: config.admin!.feishu!.tenantKey,
    permissions,
  };
  try {
    const path = join(dir, "account.json");
    writeFileSync(path, JSON.stringify(account), { mode: 0o600 });
    const cli = spawnSync(
      process.execPath,
      [
        resolve(__dirname, "../src/admin/admin-cli.js"),
        "create",
        "--input-file",
        path,
      ],
      {
        cwd: resolve(__dirname, "../.."),
        env: {
          ...process.env,
          NODE_ENV: config.environment,
          DATABASE_URL: config.databaseUrl,
          ADMIN_ORIGIN: config.admin!.origin,
          ADMIN_SESSION_KEY: config.admin!.sessionKey,
          ADMIN_FEISHU_APP_ID: config.admin!.feishu!.appId,
          ADMIN_FEISHU_APP_SECRET: config.admin!.feishu!.appSecret,
          ADMIN_FEISHU_TENANT_KEY: config.admin!.feishu!.tenantKey,
        },
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 0, `synthetic whitelist CLI: ${cli.stderr}`);
    return { ...account, id: JSON.parse(cli.stdout).id as string };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function adminCookie(
  response: { headers: Record<string, unknown> },
  name = "__Secure-timenook_admin",
) {
  const values = response.headers["set-cookie"];
  const value = (Array.isArray(values) ? values : [String(values)]).find(
    (entry: string) => entry.startsWith(name + "="),
  );
  return value?.split(";")[0] ?? "";
}
let clientSequence = 0;
export async function beginFeishu(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
) {
  const remoteAddress = `198.18.${Math.floor(++clientSequence / 250)}.${(clientSequence % 250) + 1}`;
  const bootstrap = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
    remoteAddress,
  });
  assert.equal(bootstrap.statusCode, 200);
  const cookie = adminCookie(bootstrap),
    csrf = bootstrap.json().data.csrfToken;
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/feishu/login",
    remoteAddress,
    headers: { origin: config.admin!.origin, cookie, "x-csrf-token": csrf },
  });
  assert.equal(response.statusCode, 200, response.body);
  const url = new URL(response.json().data.authorizationUrl);
  return {
    cookie,
    csrf,
    response,
    remoteAddress,
    state: url.searchParams.get("state")!,
    flowCookie: adminCookie(response, "__Secure-timenook_oauth"),
    url,
  };
}
export async function authenticateFeishu(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  account = createFeishuAccount(config),
) {
  const challenge = await beginFeishu(config, app);
  const code = Buffer.from(JSON.stringify(account)).toString("base64url");
  const response = await app.inject({
    method: "GET",
    url: `/v1/admin/feishu/callback?state=${challenge.state}&code=${code}`,
    remoteAddress: challenge.remoteAddress,
    headers: { cookie: challenge.flowCookie, "sec-fetch-site": "cross-site" },
  });
  assert.equal(response.statusCode, 303, response.body);
  assert.equal(response.headers.location, "/admin/");
  const cookie = adminCookie(response);
  const session = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
    headers: { cookie },
  });
  assert.equal(session.json().data.authenticated, true);
  return {
    account,
    cookie,
    csrf: session.json().data.csrfToken as string,
    response,
    challenge,
  };
}
