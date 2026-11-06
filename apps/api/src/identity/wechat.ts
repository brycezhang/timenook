import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

async function wechatPost(url: string, body: object, request: typeof fetch) {
  let response: Response;
  try {
    response = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new ServiceUnavailableException();
  }
  if (!response.ok) throw new BadGatewayException();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BadGatewayException();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new BadGatewayException();
  const result = payload as Record<string, unknown>;
  if (result.errcode !== undefined && result.errcode !== 0) {
    if (result.errcode === 40029 || result.errcode === 40163)
      throw new UnauthorizedException();
    if (result.errcode === 48001) throw new ForbiddenException();
    if (result.errcode === -1) throw new ServiceUnavailableException();
    throw new BadGatewayException();
  }
  return result;
}

export async function wechatAccessToken(
  credentials: { appId: string; secret: string },
  request: typeof fetch,
) {
  const result = await wechatPost(
    "https://api.weixin.qq.com/cgi-bin/stable_token",
    {
      grant_type: "client_credential",
      appid: credentials.appId,
      secret: credentials.secret,
    },
    request,
  );
  if (
    typeof result.access_token !== "string" ||
    !/^\S{1,8192}$/.test(result.access_token) ||
    typeof result.expires_in !== "number" ||
    result.expires_in <= 0
  )
    throw new BadGatewayException();
  return {
    token: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000 - 60_000,
  };
}

export async function exchangePhoneCode(
  token: string,
  code: string,
  openId: string,
  appId: string,
  request: typeof fetch,
): Promise<string> {
  const result = await wechatPost(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,
    { code, openid: openId },
    request,
  );
  const info = result.phone_info as Record<string, unknown> | undefined;
  const watermark = info?.watermark as Record<string, unknown> | undefined;
  if (
    typeof info?.phoneNumber !== "string" ||
    !/^\+?[0-9]{5,32}$/.test(info.phoneNumber) ||
    watermark?.appid !== appId
  )
    throw new BadGatewayException();
  return info.phoneNumber;
}

// The only replaceable boundary is the external network request. There is no
// environment switch that can synthesize a WeChat identity in a running server.
export async function exchangeCode(
  credentials: { appId: string; secret: string },
  code: string,
  request: typeof fetch,
): Promise<string> {
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.search = new URLSearchParams({
    appid: credentials.appId,
    secret: credentials.secret,
    js_code: code,
    grant_type: "authorization_code",
  }).toString();
  let response: Response;
  try {
    response = await request(url, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    // Fetch errors can contain the full URL (including credentials/code).
    throw new ServiceUnavailableException();
  }
  if (!response.ok) throw new BadGatewayException();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BadGatewayException();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new BadGatewayException();
  const result = payload as Record<string, unknown>;
  if (result.errcode !== undefined && result.errcode !== 0) {
    if (result.errcode === 40029 || result.errcode === 40163)
      throw new UnauthorizedException();
    if (result.errcode === 40226) throw new ForbiddenException();
    if (result.errcode === -1) throw new ServiceUnavailableException();
    if (result.errcode === 45011) throw new HttpException("Rate limited", 429);
    throw new BadGatewayException();
  }
  if (
    typeof result.openid !== "string" ||
    !/^\S{1,128}$/.test(result.openid) ||
    typeof result.session_key !== "string" ||
    !/^\S{1,512}$/.test(result.session_key)
  )
    throw new BadGatewayException();
  // Neither session_key nor optional unionid is needed for the product session.
  return result.openid;
}
