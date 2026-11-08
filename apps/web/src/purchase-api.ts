import { auth } from "./session";
import { webApi, WebApiError } from "./api";
export interface PurchaseOrder {
  id: string;
  bookTitle: string;
  subjectName: string | null;
  state: "pending" | "paid" | "closed";
  amount: number;
  listAmount: number;
  channel: "alipay_page" | "alipay_wap";
  paymentStatus?: "pending" | "paid" | "closed" | "unknown";
  project: { id: string; entitlement: { state: string } } | null;
}
export interface PaymentForm {
  actionUrl: string;
  fields: Array<{ name: string; value: string }>;
}
export interface PreparedAlipay {
  status: string;
  form: PaymentForm | null;
}
export const isWechatBrowser = () =>
  /MicroMessenger/i.test(navigator.userAgent);
export const alipayChannel = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    ? ("alipay_wap" as const)
    : ("alipay_page" as const);
async function request<T>(
  path: string,
  data?: unknown,
  key?: string,
): Promise<T> {
  const owner = auth.account.value;
  if (!owner) throw new WebApiError(401);
  const current = await webApi.restore();
  if (
    auth.account.value?.session.id !== owner.session.id ||
    current.session.id !== owner.session.id
  )
    throw new WebApiError(401);
  const response = await fetch(`/api/v1/web/orders${path}`, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "X-Timenook-Web": "1",
      ...(data === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": owner.csrfToken,
            "Idempotency-Key": key ?? crypto.randomUUID(),
          }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (auth.account.value?.session.id !== owner.session.id)
    throw new DOMException("Account changed", "AbortError");
  if (!response.ok)
    throw new WebApiError(
      response.status,
      response.status === 400
        ? "请检查购买信息。"
        : response.status === 404
          ? "订单不存在或不属于当前账号。"
          : "暂时无法确认订单，请稍后重试。",
    );
  const body = await response.json();
  if (!body || !("data" in body) || body.error) throw new WebApiError(0);
  return body.data as T;
}
export const purchaseApi = {
  catalog: () =>
    request<{
      purchasable: boolean;
      version: { id: string; title: string } | null;
    }>("/catalog"),
  list: () => request<{ orders: PurchaseOrder[] }>(""),
  create: (
    input: {
      packageVersionId: string;
      recipient: { relationshipLabel: string };
      subjectName?: string;
      bookTitle: string;
      channel: "alipay_page" | "alipay_wap";
    },
    key: string,
  ) => request<PurchaseOrder>("", input, key),
  get: (id: string) => request<PurchaseOrder>(`/${encodeURIComponent(id)}`),
  prepare: (id: string) =>
    request<PreparedAlipay>(`/${encodeURIComponent(id)}/payment`, {}),
  close: (id: string) =>
    request<PurchaseOrder>(`/${encodeURIComponent(id)}/close`, {}),
};
export function submitAlipay(form: PaymentForm) {
  const url = new URL(form.actionUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["alipay.com", "alipay.cn", "alipaydev.com"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error("支付宝付款地址无效，请重新查询订单。");
  const element = document.createElement("form");
  element.method = "post";
  element.action = url.toString();
  for (const field of form.fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = field.name;
    input.value = field.value;
    element.append(input);
  }
  document.body.append(element);
  HTMLFormElement.prototype.submit.call(element);
}
