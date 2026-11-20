import type { Prisma } from "@prisma/client";
import type { PackageTerm } from "@timenook/contracts";
import {
  ACCEPTANCE_INPUT_QUOTAS,
  ACCEPTANCE_PROVIDER_BUDGET,
  internalSnapshot,
  INTERNAL_PROFILE_VERSION,
} from "../projects/internal-profile";
import { InvalidPackageException } from "./errors";

export const MANUAL_SALE_PROFILE_VERSION = "manual-sale-v1.2";
const TITLE = "岁月成书";

// Provincial IDs from the government GB/T 2260 table. Operations checks the
// street address, including islands that require special transport.
const includedRegions = {
  "CN-110000": "北京市",
  "CN-120000": "天津市",
  "CN-130000": "河北省",
  "CN-140000": "山西省",
  "CN-150000": "内蒙古自治区",
  "CN-210000": "辽宁省",
  "CN-220000": "吉林省",
  "CN-230000": "黑龙江省",
  "CN-310000": "上海市",
  "CN-320000": "江苏省",
  "CN-330000": "浙江省",
  "CN-340000": "安徽省",
  "CN-350000": "福建省",
  "CN-360000": "江西省",
  "CN-370000": "山东省",
  "CN-410000": "河南省",
  "CN-420000": "湖北省",
  "CN-430000": "湖南省",
  "CN-440000": "广东省",
  "CN-450000": "广西壮族自治区",
  "CN-460000": "海南省",
  "CN-500000": "重庆市",
  "CN-510000": "四川省",
  "CN-520000": "贵州省",
  "CN-530000": "云南省",
  "CN-610000": "陕西省",
  "CN-620000": "甘肃省",
  "CN-630000": "青海省",
  "CN-640000": "宁夏回族自治区",
};
const excludedRegions = {
  "CN-540000": "西藏自治区",
  "CN-650000": "新疆维吾尔自治区",
  "CN-710000": "台湾",
  "CN-810000": "香港特别行政区",
  "CN-820000": "澳门特别行政区",
};

export const MANUAL_SALE_TERMS: PackageTerm[] = [
  {
    label: "套餐内容",
    text: "一次付费包含一位成年讲述者的一个人生项目、一本定制实体书、PDF 书稿及完整资料导出。可为自己购买，也可送给他人。",
  },
  {
    key: "creation_service",
    label: "长期服务",
    text: "制作、原声回听、下载及必要资料保留长期有效，无自动续费。",
  },
  {
    label: "记录额度",
    text: "每个项目单段录音最长 10 分钟，累计 6 小时，含 40 张照片、30 次首次整理、30 次主动重整及 90 次追问。系统重试不重复扣减额度。",
  },
  {
    key: "print_specification",
    label: "实体书规格",
    text: "A5（148 × 210 毫米）平装胶订。250 克铜版纸彩色封面、覆哑膜，80 克胶版纸黑白内页。内页 48–160 页，封面另计。",
  },
  {
    key: "shipping",
    label: "配送范围",
    text: "含中国大陆支持地址的一次普通快递。新疆、西藏、港澳台、海外及须特殊运输的海岛地址暂不配送。书稿定稿后由运营核验配送地址。",
  },
  {
    key: "service.production",
    label: "印刷与发货",
    text: "核对 PDF 书稿并定稿后，请在「我的 → 使用条款」点「联系微信客服」。由客服核验书稿交接和收货地址，运营人工安排印刷及发货，并提供物流信息。",
  },
  {
    label: "退款与质量售后",
    text: "实际投产前可申请全额退款。投产后如需取消，客服会核实能否停止、列明已发生且不可避免的合理费用，并协商退回余款。定制书的质量问题仍可申请补寄、重印或退款。",
  },
  {
    label: "联系微信客服",
    text: "在「我的 → 使用条款」内可联系微信客服，办理退款、质量售后、资料导出、更正或删除。退款按原订单处理，退款不会自动删除资料。",
  },
];

function jsonObject(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidPackageException();
  return value;
}

export function manualSalePackage(draft: {
  title: string;
  d01: Prisma.JsonValue;
  admission: Prisma.JsonValue;
  shippingRegionLabels: Prisma.JsonValue;
}) {
  const d01 = jsonObject(draft.d01);
  const admission = jsonObject(draft.admission);
  const quotas = jsonObject(jsonObject(admission.d04).userQuotas);
  const proposedShipping = jsonObject(admission.d05);
  const d03 = jsonObject(admission.d03);
  const retention = jsonObject(d03.retention);
  // Reuse the existing lifetime policy's supported data categories, without
  // copying any internal acceptance or supplier approval into this order.
  const currentPolicy = jsonObject(
    internalSnapshot(INTERNAL_PROFILE_VERSION).admission,
  );
  const lifetimeCategories = Object.keys(
    jsonObject(jsonObject(currentPolicy.d03).retention),
  );
  if (
    draft.title !== TITLE ||
    d01.widthMm !== 148 ||
    d01.heightMm !== 210 ||
    d01.minPages !== 48 ||
    d01.maxPages !== 160 ||
    jsonObject(admission.d02).service !== "lifetime" ||
    jsonObject(d03.onlinePlayback).service !== "lifetime" ||
    jsonObject(d03.exportRequests).service !== "lifetime" ||
    lifetimeCategories.some(
      (kind) => jsonObject(retention[kind]).service !== "lifetime",
    ) ||
    proposedShipping.shippingFeeIncluded !== true ||
    Object.entries(ACCEPTANCE_INPUT_QUOTAS).some(([kind, current]) => {
      const proposed = jsonObject(quotas[kind]);
      return proposed.value !== current.value || proposed.unit !== current.unit;
    })
  ) {
    throw new InvalidPackageException();
  }

  const shippingRegions = Object.entries(includedRegions).map(
    ([code, label]) => ({ code, label }),
  );
  const snapshot: Prisma.JsonObject = {
    title: TITLE,
    scope: "manual-sale",
    profileVersion: MANUAL_SALE_PROFILE_VERSION,
    d01: {
      widthMm: 148,
      heightMm: 210,
      paper: "封面250克铜版纸覆哑膜；内页80克胶版纸",
      binding: "平装胶订",
      color: "封面彩色、内页黑白",
      minPages: 48,
      maxPages: 160,
    },
    shippingRegionLabels: { ...includedRegions, ...excludedRegions },
    admission: {
      d02: admission.d02!,
      d03,
      d04: {
        review: { state: "frozen", scope: MANUAL_SALE_PROFILE_VERSION },
        userQuotas: quotas,
        providerBudget: ACCEPTANCE_PROVIDER_BUDGET,
        systemRetriesChargeUserQuota: false,
      },
      d05: {
        includedRegionCodes: Object.keys(includedRegions),
        excludedRegionCodes: Object.keys(excludedRegions),
        shippingFeeIncluded: true,
        addressVerification: "manual_before_print",
      },
      d06: jsonObject(admission.d06),
      d07: jsonObject(admission.d07),
    },
  };
  return { title: TITLE, snapshot, terms: MANUAL_SALE_TERMS, shippingRegions };
}
