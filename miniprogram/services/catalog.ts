import type {
  CurrentPackage,
  RecipientCatalog,
} from "../../packages/contracts/src";
import { API_BASE_URL } from "../config";
import { dataMode } from "./mode";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function directory(value: unknown): value is RecipientCatalog {
  return (
    record(value) &&
    value.customLabelAllowed === true &&
    value.scope === "one_adult_subject_one_initiator" &&
    Array.isArray(value.types) &&
    value.types.every(
      (item) =>
        record(item) &&
        typeof item.code === "string" &&
        /^[a-z][a-z0-9_-]{1,39}$/.test(item.code) &&
        typeof item.label === "string" &&
        !!item.label.trim() &&
        item.label.length <= 40 &&
        Number.isSafeInteger(item.revision) &&
        Number(item.revision) > 0,
    )
  );
}
function current(value: unknown): value is CurrentPackage {
  if (!record(value) || value.purchasable !== false) return false;
  if (value.version === null) return value.reason === "PACKAGE_PREPARING";
  const version = value.version;
  return (
    value.reason === "PREVIEW_ONLY" &&
    record(version) &&
    typeof version.id === "string" &&
    version.purpose === "local_preview" &&
    typeof version.title === "string" &&
    record(version.price) &&
    version.price.value === 99900 &&
    version.price.unit === "fen" &&
    version.price.currency === "CNY" &&
    record(version.scope) &&
    version.scope.projects === 1 &&
    version.scope.adultSubjects === 1 &&
    version.scope.initiators === 1 &&
    version.scope.firstCopies === 1 &&
    version.scope.agreedShippingIncluded === true &&
    version.scope.completeExportIncluded === true &&
    Array.isArray(version.terms) &&
    version.terms.every(
      (term) =>
        record(term) &&
        typeof term.label === "string" &&
        typeof term.text === "string",
    )
  );
}
async function request<T>(
  path: string,
  valid: (value: unknown) => value is T,
): Promise<T> {
  if (dataMode() !== "live" || !API_BASE_URL)
    throw new Error("套餐服务暂不可用，请稍后重试");
  return new Promise((resolve, reject) =>
    wx.request({
      url: `${API_BASE_URL}${path}`,
      method: "GET",
      timeout: 10000,
      success(response) {
        const body: unknown = response.data;
        if (response.statusCode === 200 && record(body) && valid(body.data))
          resolve(body.data);
        else reject(new Error("套餐加载失败，请稍后重试"));
      },
      fail() {
        reject(new Error("套餐加载失败，请检查网络后重试"));
      },
    }),
  );
}
export async function readCatalog() {
  const [recipients, offer] = await Promise.all([
    request("/recipient-types", directory),
    request("/packages/current", current),
  ]);
  return { recipients, offer };
}
