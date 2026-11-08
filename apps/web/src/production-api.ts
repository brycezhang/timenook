import type {
  FirstCopyAddress,
  FirstCopyBinding,
  FirstCopyContext,
  FulfillmentView,
} from "../../../packages/contracts/src";
import { request, WebApiError } from "./api";
import { auth } from "./session";
const base = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const productionApi = {
  read: (id: string) =>
    auth.protect(async (owner, signal) => {
      const [firstCopy, fulfillment] = await Promise.all([
        request<FirstCopyContext>(`${base(id)}/first-copy`, { signal }),
        request<FulfillmentView>(`${base(id)}/fulfillment`, { signal }),
      ]);
      return { firstCopy, fulfillment };
    }),
  saveAddress: (
    id: string,
    expectedVersion: number,
    address: FirstCopyAddress,
    key: string,
  ) =>
    auth.protect((owner, signal) =>
      request<FirstCopyContext>(`${base(id)}/first-copy/address`, {
        method: "POST",
        data: { expectedVersion, ...address },
        csrf: owner.csrfToken,
        signal,
        idempotencyKey: key,
      }),
    ),
  submit: (id: string, binding: FirstCopyBinding, key: string) =>
    auth.protect((owner, signal) =>
      request<FirstCopyContext>(`${base(id)}/first-copy/submit`, {
        method: "POST",
        data: binding,
        csrf: owner.csrfToken,
        signal,
        idempotencyKey: key,
      }),
    ),
};
export function productionError(error: unknown) {
  if (error instanceof WebApiError) {
    if (error.status === 409)
      return "书稿、收货地址或制作状态已更新，请读取最新状态后继续。";
    if (error.status === 403)
      return "暂时无法操作制作，请确认项目成员资格和当前权益。";
    if (error.status === 404) return "项目或书稿已不可用，请返回项目重新查看。";
    if ([400, 422].includes(error.status))
      return "请检查收件人、手机号、配送地区和详细地址，或读取最新制作状态。";
  }
  return "暂时无法读取制作状态，请重试。";
}
