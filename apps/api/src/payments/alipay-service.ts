import { parseAlipayRedirectHtml } from "./alipay-redirect";
import type { ApiConfig } from "../config";
export type AlipayChannel = "alipay_page" | "alipay_wap";
export interface AlipayOrder {
  orderNo: string;
  status: string;
  amountFen: number;
  currency: string;
  bizType: string;
  bizRefId: string;
  channel: string;
  packageVersionId: string;
  localOrderId: string;
  settledAt: string | null;
}
/** The shared service owns provider signatures, callbacks and reconciliation. */
export class AlipayService {
  constructor(
    private readonly config: NonNullable<ApiConfig["alipay"]>,
    private readonly transport: typeof fetch,
  ) {}
  async create(input: {
    id: string;
    packageVersionId: string;
    channel: string | null;
    amount: number;
    bookTitle: string | null;
  }) {
    return this.parse(
      await this.request("/v1/payments/orders", "POST", {
        biz_type: "timenook_book",
        biz_ref_id: input.id,
        amount: (input.amount / 100).toFixed(2),
        currency: "CNY",
        preferred_channel: input.channel,
        expired_at: new Date(Date.now() + 30 * 60000).toISOString(),
        metadata: {
          scene: "timenook_book_purchase",
          product_code: input.packageVersionId,
          product_name: "岁月成书",
          local_order_id: input.id,
        },
      }),
    );
  }
  async get(orderNo: string) {
    return this.parse(
      await this.request(
        `/v1/payments/internal/0/orders/${encodeURIComponent(orderNo)}`,
        "GET",
      ),
    );
  }
  async close(orderNo: string) {
    await this.request(
      `/v1/payments/orders/${encodeURIComponent(orderNo)}/close`,
      "POST",
    );
  }
  async prepare(
    orderNo: string,
    channel: string | null,
    returnUrl: string,
    clientIp: string,
  ) {
    const data = record(
      await this.request(
        `/v1/payments/orders/${encodeURIComponent(orderNo)}/prepare`,
        "POST",
        {
          channel,
          client_type: channel === "alipay_page" ? "page" : "h5",
          client_ip: clientIp,
          extra: {
            subject: "时光故事书",
            return_url: returnUrl,
            quit_url: returnUrl,
          },
        },
      ),
    );
    const payload = record(data.channel_payload);
    if (
      payload.method !==
        (channel === "alipay_page" ? "page_redirect" : "wap_redirect") ||
      typeof payload.order_string !== "string" ||
      !Number.isInteger(data.expires_in) ||
      Number(data.expires_in) <= 0 ||
      Number(data.expires_in) > 3600
    )
      throw new Error("Invalid payment-service preparation");
    return parseAlipayRedirectHtml(payload.order_string);
  }
  private parse(value: unknown): AlipayOrder {
    const data = record(value),
      metadata = record(data.metadata);
    const amount =
      typeof data.amount === "string" &&
      /^(0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(data.amount)
        ? Math.round(Number(data.amount) * 100)
        : NaN;
    if (
      typeof data.order_no !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(data.order_no) ||
      ![
        "pending",
        "processing",
        "paid",
        "closed",
        "partially_refunded",
        "refunded",
      ].includes(String(data.status)) ||
      !Number.isSafeInteger(amount)
    )
      throw new Error("Invalid payment-service order");
    return {
      orderNo: data.order_no,
      status: String(data.status),
      amountFen: amount,
      currency: String(data.currency),
      bizType: String(data.biz_type),
      bizRefId: String(data.biz_ref_id),
      channel: String(data.channel_preferred),
      packageVersionId: String(metadata.product_code),
      localOrderId: String(metadata.local_order_id),
      settledAt: typeof data.settled_at === "string" ? data.settled_at : null,
    };
  }
  private async request(path: string, method: string, body?: unknown) {
    const response = await this.transport(
      `${this.config.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": this.config.internalToken,
          "X-Internal-Service": "timenook",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) throw new Error("Payment-service unavailable");
    const envelope = record(await response.json());
    if (!("data" in envelope))
      throw new Error("Invalid payment-service envelope");
    return envelope.data;
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid payment-service response");
  return value as Record<string, unknown>;
}
