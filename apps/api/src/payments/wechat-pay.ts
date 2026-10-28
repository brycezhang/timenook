import {
  createPrivateKey,
  createPublicKey,
  createDecipheriv,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
export interface WechatPayConfig {
  mode: "local-verification" | "ordinary-merchant";
  appId: string;
  merchantId: string;
  merchantSerial: string;
  merchantPrivateKey: string;
  platformKeyId: string;
  platformPublicKey: string;
  apiV3Key: string;
  notifyUrl: string;
}
export class PaymentProtocolError extends Error {
  constructor() {
    super("Payment provider result could not be verified");
  }
}
export class WechatPay {
  constructor(
    private readonly config: WechatPayConfig,
    private readonly transport: typeof fetch,
  ) {}
  private signature(message: string) {
    return sign(
      "RSA-SHA256",
      Buffer.from(message),
      this.config.merchantPrivateKey,
    ).toString("base64");
  }
  verify(raw: string, headers: Headers) {
    const timestamp = headers.get("Wechatpay-Timestamp") ?? "";
    const nonce = headers.get("Wechatpay-Nonce") ?? "";
    const signature = headers.get("Wechatpay-Signature") ?? "";
    if (
      headers.get("Wechatpay-Serial") !== this.config.platformKeyId ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !nonce ||
      nonce.length > 128 ||
      !signature ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),
        this.config.platformPublicKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new PaymentProtocolError();
  }
  private async request(method: string, path: string, payload?: unknown) {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = this.signature(
      `${method}\n${path}\n${timestamp}\n${nonce}\n${raw}\n`,
    );
    const response = await this.transport(
      "https://api.mch.weixin.qq.com" + path,
      {
        method,
        body: raw || undefined,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "Wechatpay-Serial": this.config.platformKeyId,
          authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.merchantSerial}",signature="${signature}"`,
        },
      },
    );
    // Bounded raw response body; verification always precedes JSON parsing.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new PaymentProtocolError();
        }
        chunks.push(value);
      }
    const body = Buffer.concat(chunks).toString("utf8");
    this.verify(body, response.headers);
    let data: Record<string, unknown>;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      throw new PaymentProtocolError();
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new PaymentProtocolError();
    if (!response.ok) {
      if (
        response.status === 404 &&
        (data.code === "ORDER_NOT_EXIST" ||
          (path.startsWith("/v3/refund/domestic/refunds/") &&
            data.code === "RESOURCE_NOT_EXISTS"))
      )
        return null;
      throw new PaymentProtocolError();
    }
    return data;
  }
  async prepare(order: {
    outTradeNo: string;
    openId: string;
    amount: number;
    currency: string;
  }) {
    const result = await this.request("POST", "/v3/pay/transactions/jsapi", {
      appid: this.config.appId,
      mchid: this.config.merchantId,
      description: "岁月成书 · 一个项目及首本实体书",
      out_trade_no: order.outTradeNo,
      notify_url: this.config.notifyUrl,
      amount: { total: order.amount, currency: order.currency },
      payer: { openid: order.openId },
    });
    if (
      typeof result?.prepay_id !== "string" ||
      !/^[-A-Za-z0-9_]{1,100}$/.test(result.prepay_id)
    )
      throw new PaymentProtocolError();
    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = randomBytes(16).toString("hex");
    const packageValue = `prepay_id=${result.prepay_id}`;
    return {
      timeStamp,
      nonceStr,
      package: packageValue,
      signType: "RSA" as const,
      paySign: this.signature(
        `${this.config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`,
      ),
    };
  }
  query(outTradeNo: string) {
    return this.request(
      "GET",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.config.merchantId)}`,
    );
  }
  async close(outTradeNo: string) {
    await this.request(
      "POST",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
      { mchid: this.config.merchantId },
    );
  }
  refund(
    order: { outTradeNo: string; amount: number; currency: string },
    refund: { outRefundNo: string; amount: number },
  ) {
    return this.request("POST", "/v3/refund/domestic/refunds", {
      out_trade_no: order.outTradeNo,
      out_refund_no: refund.outRefundNo,
      reason: "岁月成书售后退款",
      notify_url: new URL("refunds", this.config.notifyUrl).toString(),
      amount: {
        total: order.amount,
        refund: refund.amount,
        currency: order.currency,
      },
    });
  }
  queryRefund(outRefundNo: string) {
    return this.request(
      "GET",
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
    );
  }
  decrypt(raw: string, headers: Headers) {
    return this.decryptNotification(raw, headers, "transaction", [
      "TRANSACTION.SUCCESS",
    ]);
  }
  decryptRefund(raw: string, headers: Headers) {
    return this.decryptNotification(raw, headers, "refund", [
      "REFUND.SUCCESS",
      "REFUND.ABNORMAL",
      "REFUND.CLOSED",
    ]);
  }
  private decryptNotification(
    raw: string,
    headers: Headers,
    originalType: string,
    eventTypes: string[],
  ) {
    this.verify(raw, headers);
    try {
      const notification = JSON.parse(raw);
      const resource = notification.resource;
      if (
        typeof notification.id !== "string" ||
        !notification.id ||
        notification.id.length > 128 ||
        !eventTypes.includes(notification.event_type) ||
        notification.resource_type !== "encrypt-resource" ||
        resource?.algorithm !== "AEAD_AES_256_GCM" ||
        resource.original_type !== originalType ||
        typeof resource.nonce !== "string" ||
        typeof resource.ciphertext !== "string" ||
        (resource.associated_data !== undefined &&
          typeof resource.associated_data !== "string")
      )
        throw new Error();
      const encrypted = Buffer.from(resource.ciphertext, "base64");
      if (encrypted.length < 17) throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(this.config.apiV3Key),
        resource.nonce,
      );
      decipher.setAAD(Buffer.from(resource.associated_data ?? ""));
      decipher.setAuthTag(encrypted.subarray(-16));
      const data = JSON.parse(
        Buffer.concat([
          decipher.update(encrypted.subarray(0, -16)),
          decipher.final(),
        ]).toString("utf8"),
      );
      return {
        eventId: notification.id as string,
        eventType: notification.event_type as string,
        transaction: data as Record<string, unknown>,
      };
    } catch {
      throw new PaymentProtocolError();
    }
  }
}

export function validateWechatPayConfig(config: WechatPayConfig) {
  const url = new URL(config.notifyUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/v1/webhooks/wechat-pay/payments" ||
    Buffer.byteLength(config.apiV3Key) !== 32 ||
    [
      config.appId,
      config.merchantId,
      config.merchantSerial,
      config.platformKeyId,
    ].some((value) => !/^[-A-Za-z0-9_]{1,100}$/.test(value))
  )
    throw new PaymentProtocolError();
  for (const key of [
    createPrivateKey(config.merchantPrivateKey),
    createPublicKey(config.platformPublicKey),
  ])
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new PaymentProtocolError();
  if (
    config.mode === "ordinary-merchant" &&
    (!/^wx[0-9a-f]{16}$/.test(config.appId) ||
      !/^\d{6,32}$/.test(config.merchantId) ||
      !/^[0-9A-F]{1,64}$/.test(config.merchantSerial) ||
      !/^(?:PUB_KEY_ID_\d{1,80}|[0-9A-F]{1,64})$/.test(config.platformKeyId) ||
      /synthetic|placeholder|your_|<|>/i.test(config.apiV3Key) ||
      /\s/.test(config.apiV3Key))
  )
    throw new PaymentProtocolError();
}

/** Real merchant material is read once at startup, never from client input. */
export function readOrdinaryMerchantConfig(
  env: NodeJS.ProcessEnv,
  identity: { appId: string; secret: string } | undefined,
  environment: string,
): WechatPayConfig | undefined {
  if (
    !Object.keys(env).some(
      (key) => key.startsWith("TIMENOOK_WECHAT_PAY_") && env[key]?.trim(),
    )
  )
    return;
  const field = (name: string) => env[`TIMENOOK_WECHAT_PAY_${name}`] ?? "";
  if (
    field("MODE") !== "ordinary-merchant" ||
    environment === "test" ||
    !identity ||
    /synthetic|placeholder|your_/i.test(identity.secret)
  )
    throw new PaymentProtocolError();
  const material = (name: string) => {
    const path = field(name);
    if (!isAbsolute(path)) throw new PaymentProtocolError();
    const file = statSync(path);
    if (!file.isFile() || file.size > 65536 || file.mode & 0o022)
      throw new PaymentProtocolError();
    return readFileSync(path, "utf8");
  };
  const merchantPrivateKey = material("MERCHANT_PRIVATE_KEY_PATH");
  const certificate = new X509Certificate(material("MERCHANT_CERT_PATH"));
  if (
    !certificate.checkPrivateKey(createPrivateKey(merchantPrivateKey)) ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  )
    throw new PaymentProtocolError();
  const platformPublicKey = material("PLATFORM_PUBLIC_KEY_PATH");
  const platformKeyId = field("PLATFORM_KEY_ID");
  if (!platformKeyId.startsWith("PUB_KEY_ID_")) {
    const platform = new X509Certificate(platformPublicKey);
    if (
      platform.serialNumber !== platformKeyId ||
      Date.parse(platform.validFrom) > Date.now() ||
      Date.parse(platform.validTo) <= Date.now()
    )
      throw new PaymentProtocolError();
  }
  const config: WechatPayConfig = {
    mode: "ordinary-merchant",
    appId: identity.appId,
    merchantId: field("MERCHANT_ID"),
    merchantSerial: certificate.serialNumber,
    merchantPrivateKey,
    platformKeyId,
    platformPublicKey,
    apiV3Key: field("API_V3_KEY"),
    notifyUrl: field("NOTIFY_URL"),
  };
  validateWechatPayConfig(config);
  return config;
}
