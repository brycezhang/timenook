import type {
  CurrentPackage,
  RecipientCatalog,
} from "../../packages/contracts/src";
import { API_BASE_URL } from "../config";
import { sessionClient } from "./session";
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
  if (!record(value) || typeof value.purchasable !== "boolean") return false;
  if (value.version === null)
    return !value.purchasable && value.reason === "PACKAGE_PREPARING";
  if (!["PREVIEW_ONLY", "E2E_ONLY", "AVAILABLE"].includes(String(value.reason)))
    return false;
  if (value.purchasable) {
    const checkout = value.checkout;
    if (
      !record(checkout) ||
      checkout.listAmount !== 99900 ||
      checkout.currency !== "CNY" ||
      typeof checkout.isE2e !== "boolean" ||
      checkout.amount !== (checkout.isE2e ? 1 : 99900)
    )
      return false;
    if (
      !record(value.version) ||
      value.version.purpose !== (checkout.isE2e ? "e2e" : "production")
    )
      return false;
  } else if (value.checkout != null) return false;
  const version = value.version;
  return (
    record(version) &&
    typeof version.id === "string" &&
    ["local_preview", "production", "e2e"].includes(String(version.purpose)) &&
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
    (version.purpose === "local_preview" ||
      (Array.isArray(version.shippingRegions) &&
        version.shippingRegions.every(
          (region) =>
            record(region) &&
            typeof region.code === "string" &&
            typeof region.label === "string",
        ))) &&
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
  const value = await (
    sessionClient.context()
      ? sessionClient.request<unknown>(path)
      : sessionClient.publicRequest<unknown>(path)
  ).catch(() => {
    throw new Error("套餐加载失败，请稍后重试");
  });
  if (!valid(value)) throw new Error("套餐加载失败，请稍后重试");
  return value;
}
export async function readCatalog() {
  const [recipients, offer] = await Promise.all([
    request("/recipient-types", directory),
    request("/packages/current", current),
  ]);
  return { recipients, offer };
}
export function readCurrentPackage() {
  return request("/packages/current", current);
}
