import { randomUUID } from "node:crypto";
import { USER_TERMS_VERSION } from "@timenook/contracts";

export const phoneLogin = () => ({
  phoneCode: `synthetic-phone-${randomUUID()}`,
  termsVersion: USER_TERMS_VERSION,
});

const verifiedPhones = new Map<string, string>();
let nextPhone = 10000;
export function verifiedPhone(appId: string, openId: string) {
  const identity = `${appId}:${openId}`;
  if (!verifiedPhones.has(identity))
    verifiedPhones.set(identity, `13${nextPhone++}1234`);
  return verifiedPhones.get(identity)!;
}

// Only WeChat's external token/phone endpoints are substituted; login HTTP,
// account ownership, PostgreSQL transactions and Redis remain real.
export function withWechatProfile(identityFetch: typeof fetch): typeof fetch {
  return async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/cgi-bin/stable_token") {
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          access_token: `synthetic-access:${body.appid}`,
          expires_in: 7200,
        }),
      );
    }
    if (url.pathname === "/wxa/business/getuserphonenumber") {
      const appid = url.searchParams
        .get("access_token")
        ?.slice("synthetic-access:".length);
      const phone = verifiedPhone(
        appid!,
        JSON.parse(String(options?.body)).openid,
      );
      return new Response(
        JSON.stringify({
          errcode: 0,
          phone_info: {
            phoneNumber: phone,
            purePhoneNumber: phone,
            countryCode: "86",
            watermark: { appid },
          },
        }),
      );
    }
    return identityFetch(input, options);
  };
}
