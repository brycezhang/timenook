import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generate } from "otplib";
import type { ApiConfig } from "../src/config";
import type { createApplication } from "../src/application";
export async function paymentAdmin(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  permissions = ["service-terms:write", "audit:read"],
) {
  const dir = mkdtempSync(join(tmpdir(), "t10-admin-"));
  const account = {
    username: "synthetic-" + randomUUID(),
    password: randomBytes(24).toString("base64url"),
    realm: "local",
    permissions,
  };
  try {
    const path = join(dir, "account.json");
    writeFileSync(path, JSON.stringify(account), { mode: 0o600 });
    const cli = spawnSync(
      process.execPath,
      ["dist-test/src/admin/admin-cli.js", "create", "--input-file", path],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: config.databaseUrl,
          ADMIN_ORIGIN: config.admin!.origin,
          ADMIN_ENCRYPTION_KEY: config.admin!.encryptionKey,
        },
        encoding: "utf8",
      },
    );
    assert.equal(cli.status, 0, "synthetic admin CLI");
    const cookie = (r: { headers: Record<string, unknown> }) =>
      String(r.headers["set-cookie"]).split(";")[0];
    const bootstrap = await app.inject({
      method: "GET",
      url: "/v1/admin/session",
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/login",
      headers: {
        origin: config.admin!.origin,
        cookie: cookie(bootstrap),
        "x-csrf-token": bootstrap.json().data.csrfToken,
      },
      payload: { username: account.username, password: account.password },
    });
    assert.equal(login.statusCode, 200);
    const enrollment = await app.inject({
      method: "GET",
      url: "/v1/admin/mfa/enrollment",
      headers: { cookie: cookie(login) },
    });
    const mfa = await app.inject({
      method: "POST",
      url: "/v1/admin/mfa",
      headers: {
        origin: config.admin!.origin,
        cookie: cookie(login),
        "x-csrf-token": login.json().data.csrfToken,
      },
      payload: {
        code: await generate({ secret: enrollment.json().data.secret }),
      },
    });
    assert.equal(mfa.statusCode, 200);
    return {
      cookie: cookie(mfa),
      origin: config.admin!.origin,
      "x-csrf-token": mfa.json().data.csrfToken,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
