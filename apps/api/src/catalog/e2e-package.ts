import type { Prisma } from "@prisma/client";
import type { PackageTerm } from "@timenook/contracts";
import {
  internalSnapshot,
  INTERNAL_PROFILE_VERSION,
  INTERNAL_NOTICE,
} from "../projects/internal-profile";
export const E2E_NOTICE_VERSION = "paid-e2e-participation-v1";
export const E2E_NOTICE =
  "受控真实支付验收：本项目标价999元，本次实际支付0.01元。本人确认后按所选用途保存讲述和照片、AI整理及向本项目发起人共享；可分别拒绝或撤回。故事和书稿须本人确认。制作、回听与下载长期有效；实体书规格和商业售后尚待确定，本次不安排实物生产。";
export const E2E_SHIPPING_REGIONS = [
  { code: "CN-110000", label: "北京市（验收地址选择，不承诺实物配送）" },
];
export const E2E_PUBLIC_TERMS: PackageTerm[] = [
  { label: "套餐内容", text: "故事记录与整理，含首本纸质书一本。" },
  { label: "长期服务", text: "制作、原声回听、下载和必要资料长期有效。" },
  {
    label: "记录额度",
    text: "单段120秒、总录音1200秒、照片10张、追问10次、故事整理10次、主动重新整理3次。",
  },
];
/** Current acceptance policy, explicitly separate from commercial D01/D07 approval. */
export function e2eSnapshot(): Prisma.JsonObject {
  const current = internalSnapshot(INTERNAL_PROFILE_VERSION);
  const admission = current.admission as Prisma.JsonObject;
  const refund = {
    refundAmount: { value: 1, unit: "fen" },
    requestWindow: {
      startsAt: "payment_verified",
      duration: { value: 365, unit: "calendar_days" },
    },
    processing: {
      startsAt: "verified_refund_request",
      within: { value: 7, unit: "calendar_days" },
    },
    remedy: "refund",
    entitlementEffect: { creation: "terminate", firstCopy: "cancel" },
    productionAction: "none",
    policyRef: "e2e:fixed-one-fen-refund-v1",
    ownerRef: "e2e:authorized-acceptance",
  };
  return {
    ...current,
    scope: "paid-e2e",
    profileVersion: "paid-e2e-v1",
    bookTitle: "岁月成书",
    physicalProduction: false,
    d01: { status: "acceptance-candidate", commercialApproval: false },
    shippingRegionLabels: Object.fromEntries(
      E2E_SHIPPING_REGIONS.map(({ code, label }) => [code, label]),
    ),
    admission: {
      ...admission,
      scope: "paid-e2e",
      d05: {
        includedRegionCodes: E2E_SHIPPING_REGIONS.map((r) => r.code),
        excludedRegionCodes: [],
      },
      d07: {
        review: { state: "frozen", scope: "paid-e2e" },
        refundDeletesData: false,
        notParticipated: refund,
        usedNotProduced: {
          ...refund,
          requestWindow: {
            ...refund.requestWindow,
            startsAt: "service_first_used",
          },
        },
      },
      d08: {
        scope: "paid-e2e",
        noticeVersion: E2E_NOTICE_VERSION,
        notice: E2E_NOTICE,
        commercialApproval: false,
      },
    },
  };
}
export function participationNotice(
  snapshot: Prisma.JsonObject,
  internal: boolean,
) {
  if (snapshot.scope === "paid-e2e")
    return {
      noticeVersion: E2E_NOTICE_VERSION,
      evidencePrefix: "internal:",
      noticeText: E2E_NOTICE,
      policyStatus: "paid-e2e" as const,
    };
  return {
    noticeVersion: internal ? "internal-participation-v1" : "synthetic-d08-v1",
    evidencePrefix: internal ? "internal:" : "synthetic:",
    noticeText: internal ? INTERNAL_NOTICE : undefined,
    policyStatus: internal
      ? ("internal-acceptance" as const)
      : ("synthetic-only" as const),
  };
}
