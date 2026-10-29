import { randomUUID } from "node:crypto";

export const syntheticFeishu = {
  appId: "cli_synthetic_admin_browser",
  appSecret: "synthetic-browser-secret",
  tenantKey: "synthetic-admin-browser-tenant",
};
export const syntheticFeishuEnv = {
  ADMIN_FEISHU_APP_ID: syntheticFeishu.appId,
  ADMIN_FEISHU_APP_SECRET: syntheticFeishu.appSecret,
  ADMIN_FEISHU_TENANT_KEY: syntheticFeishu.tenantKey,
};
export function feishuIdentity(openId = `ou_${randomUUID()}`) {
  return {
    feishuAppId: syntheticFeishu.appId,
    feishuOpenId: openId,
    tenantKey: syntheticFeishu.tenantKey,
  };
}

/** External Feishu transport only. Production application code has no fixture mode. */
export async function syntheticFeishuFetch(input, init) {
  const url = String(input);
  if (url === "https://accounts.feishu.cn/oauth/v3/token") {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      code: 0,
      access_token: body.code,
      token_type: "Bearer",
      expires_in: 7200,
    });
  }
  if (url === "https://open.feishu.cn/open-apis/authen/v1/user_info") {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    let identity;
    try {
      identity = JSON.parse(
        Buffer.from(authorization.slice(7), "base64url").toString("utf8"),
      );
    } catch {
      return Response.json(
        { code: 999, msg: "synthetic invalid user" },
        { status: 401 },
      );
    }
    return Response.json({
      code: 0,
      data: {
        open_id: identity.feishuOpenId,
        tenant_key: identity.tenantKey,
        name: "合成运营人员",
      },
    });
  }
  throw new Error("Unexpected Feishu fixture network request");
}

/** Exercise the real browser redirect and callback, substituting Feishu's page only. */
export async function installFeishuAuthorization(page, identity, options = {}) {
  const pattern = "https://accounts.feishu.cn/open-apis/authen/v1/authorize?**";
  const handler = async (route) => {
    const authorization = new URL(route.request().url());
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    if (options.cancel) callback.searchParams.set("error", "access_denied");
    else
      callback.searchParams.set(
        "code",
        Buffer.from(JSON.stringify(identity)).toString("base64url"),
      );
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="zh-CN"><head><title>合成飞书授权</title></head><body><h1>飞书授权（合成测试）</h1><a href="${callback.toString().replaceAll("&", "&amp;")}">${options.cancel ? "取消并返回" : "授权并返回"}</a></body></html>`,
    });
  };
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}
export async function feishuLogin(page, identity) {
  const remove = await installFeishuAuthorization(page, identity);
  try {
    await page.getByRole("button", { name: "飞书登录", exact: true }).click();
    await page.waitForURL((url) => url.origin === "https://accounts.feishu.cn");
    await page.getByRole("link", { name: "授权并返回", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/admin/");
    // Keep interception active until the returned app mounts. Removing the final
    // route during module imports can leave Chromium's requests paused.
    await page.locator("#app .auth-panel, #app .app-header").first().waitFor({
      state: "visible",
      timeout: 5000,
    });
  } finally {
    await remove();
  }
}
