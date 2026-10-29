import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ApiConfig } from "../config";

export const ADMIN_FEISHU_FETCH = Symbol("ADMIN_FEISHU_FETCH");
export const FEISHU_AUTHORIZE_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
type FeishuSettings = NonNullable<NonNullable<ApiConfig["admin"]>["feishu"]>;

/** Feishu proves identity; permission remains in this application's whitelist. */
export async function feishuIdentity(
  settings: FeishuSettings,
  code: string,
  redirectUri: string,
  transport: typeof fetch,
): Promise<{ openId: string; tenantKey: string }> {
  try {
    const tokenResponse = await transport(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: settings.appId,
        client_secret: settings.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      if (tokenResponse.status >= 500) throw new ServiceUnavailableException();
      throw new UnauthorizedException();
    }
    const token = (await tokenResponse.json()) as {
      code?: unknown;
      access_token?: unknown;
    };
    if (
      (token.code !== undefined && token.code !== 0) ||
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 8192 ||
      /[\r\n]/.test(token.access_token)
    )
      throw new UnauthorizedException();
    const response = await transport(USER_INFO_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      if (response.status >= 500) throw new ServiceUnavailableException();
      throw new UnauthorizedException();
    }
    const user = (await response.json()) as {
      code?: unknown;
      data?: { open_id?: unknown; tenant_key?: unknown };
    };
    if (
      user.code !== 0 ||
      typeof user.data?.open_id !== "string" ||
      !/^ou_[A-Za-z0-9_-]{1,128}$/.test(user.data.open_id) ||
      typeof user.data.tenant_key !== "string" ||
      !/^[A-Za-z0-9_-]{3,128}$/.test(user.data.tenant_key)
    )
      throw new UnauthorizedException();
    return { openId: user.data.open_id, tenantKey: user.data.tenant_key };
  } catch (error) {
    if (
      error instanceof UnauthorizedException ||
      error instanceof ServiceUnavailableException
    )
      throw error;
    throw new ServiceUnavailableException();
  }
}
