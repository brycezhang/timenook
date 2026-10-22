import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

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
