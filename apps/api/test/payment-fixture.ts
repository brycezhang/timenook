import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  createCipheriv,
} from "node:crypto";
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const paymentConfig = {
  mode: "local-verification" as const,
  appId: "synthetic-timenook",
  merchantId: "synthetic-merchant",
  merchantSerial: "synthetic-serial",
  merchantPrivateKey: merchant.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  platformKeyId: "PUB_KEY_ID_SYNTHETIC",
  platformPublicKey: platform.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  apiV3Key: randomBytes(32).toString("hex").slice(0, 32),
  notifyUrl:
    "https://synthetic.invalid/timenook/v1/webhooks/wechat-pay/payments",
};
export const supplierOrders = new Map<string, Record<string, unknown>>();
export const supplierRefunds = new Map<string, Record<string, unknown>>();
export let nextRefundFault: "" | "timeout" | "signature" = "";
export function refundFault(value: typeof nextRefundFault) {
  nextRefundFault = value;
}
export const paymentRequests: {
  method: string;
  path: string;
  body: Record<string, unknown>;
}[] = [];
export let nextFault: "" | "timeout" | "signature" | "close-race" = "";
export function fault(value: typeof nextFault) {
  nextFault = value;
}
export function signed(body: string, status = 200) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "synthetic-response-nonce";
  return new Response(status === 204 ? null : body, {
    status,
    headers: {
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": paymentConfig.platformKeyId,
      "Wechatpay-Signature": sign(
        "RSA-SHA256",
        Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
        platform.privateKey,
      ).toString("base64"),
    },
  });
}
export const paymentFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.mch.weixin.qq.com");
  const method = init?.method ?? "GET";
  const body = String(init?.body ?? "");
  const auth = Object.fromEntries(
    [
      ...String(new Headers(init?.headers).get("authorization")).matchAll(
        /(\w+)="([^"]+)"/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  assert.equal(auth.mchid, paymentConfig.merchantId);
  assert.equal(auth.serial_no, paymentConfig.merchantSerial);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(
        `${method}\n${url.pathname + url.search}\n${auth.timestamp}\n${auth.nonce_str}\n${body}\n`,
      ),
      merchant.publicKey,
      Buffer.from(auth.signature, "base64"),
    ),
    true,
    "official request signature canonical bytes",
  );
  const payload = body ? JSON.parse(body) : {};
  paymentRequests.push({
    method,
    path: url.pathname + url.search,
    body: payload,
  });
  if (url.pathname.startsWith("/v3/refund/domestic/refunds")) {
    if (method === "POST") {
      const order = supplierOrders.get(payload.out_trade_no);
      assert.ok(order, "original synthetic payment exists");
      const row = {
        out_trade_no: payload.out_trade_no,
        out_refund_no: payload.out_refund_no,
        transaction_id: order.transaction_id,
        refund_id: `synthetic-refund-${payload.out_refund_no}`,
        status: "PROCESSING",
        amount: payload.amount,
      };
      supplierRefunds.set(payload.out_refund_no, row);
      if (nextRefundFault === "timeout") {
        nextRefundFault = "";
        throw new Error("synthetic refund result unknown");
      }
      const result = signed(JSON.stringify(row));
      if (nextRefundFault === "signature") {
        nextRefundFault = "";
        result.headers.set("Wechatpay-Signature", "invalid");
      }
      return result;
    }
    const no = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const row = supplierRefunds.get(no);
    return row
      ? signed(JSON.stringify(row))
      : signed(JSON.stringify({ code: "RESOURCE_NOT_EXISTS" }), 404);
  }
  const no = decodeURIComponent(url.pathname.split("/")[5] ?? "");
  if (method === "POST" && url.pathname === "/v3/pay/transactions/jsapi") {
    supplierOrders.set(payload.out_trade_no, {
      ...payload,
      trade_state: "NOTPAY",
    });
    if (nextFault === "timeout") {
      nextFault = "";
      throw new Error("synthetic network result unknown");
    }
    const result = signed(
      JSON.stringify({ prepay_id: "synthetic-prepay-" + payload.out_trade_no }),
    );
    if (nextFault === "signature") {
      nextFault = "";
      result.headers.set("Wechatpay-Signature", "invalid");
    }
    return result;
  }
  if (method === "GET") {
    const row = supplierOrders.get(no);
    return row
      ? signed(JSON.stringify(row))
      : signed(JSON.stringify({ code: "ORDER_NOT_EXIST" }), 404);
  }
  if (url.pathname.endsWith("/close")) {
    const row = supplierOrders.get(no);
    if (row) {
      if (nextFault === "close-race") {
        nextFault = "";
        Object.assign(row, {
          trade_state: "SUCCESS",
          transaction_id: "synthetic-paid-" + no,
          success_time: new Date().toISOString(),
        });
      } else row.trade_state = "CLOSED";
    }
    return signed("", 204);
  }
  throw new Error("Unexpected synthetic payment endpoint");
};
export function verifyMini(params: {
  timeStamp: string;
  nonceStr: string;
  package: string;
  paySign: string;
}) {
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(
        `${paymentConfig.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`,
      ),
      merchant.publicKey,
      Buffer.from(params.paySign, "base64"),
    ),
    true,
    "official mini-program signature bytes",
  );
}
export function paid(
  outTradeNo: string,
  overrides: Record<string, unknown> = {},
) {
  const prior = supplierOrders.get(outTradeNo);
  assert.ok(prior);
  const result = {
    ...prior,
    trade_state: "SUCCESS",
    transaction_id: "synthetic-paid-" + outTradeNo,
    success_time: new Date().toISOString(),
    ...overrides,
  };
  supplierOrders.set(outTradeNo, result);
  return result;
}
export async function callback(
  transaction: Record<string, unknown>,
  id = "synthetic-event-" + String(transaction.out_trade_no),
  originalType = "transaction",
  eventType = "TRANSACTION.SUCCESS",
) {
  const nonce = "abcdefghijkl";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(paymentConfig.apiV3Key),
    nonce,
  );
  cipher.setAAD(Buffer.from(originalType));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = JSON.stringify({
    id,
    event_type: eventType,
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      original_type: originalType,
      nonce,
      associated_data: originalType,
      ciphertext,
    },
  });
  return { body, headers: Object.fromEntries(signed(body).headers) };
}
