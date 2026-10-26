import type { CatalogValidation, PackageTerm } from "@timenook/contracts";
import { validateSalesAdmission } from "../commerce/admission";
import { isRecordReference, isUtcReviewTime } from "../commerce/review-values";
const at = (input: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined,
      input,
    );
/** D01 is independent of T05: candidate print-probe settings are not approved specifications. */
export function validatePackage(
  d01: unknown,
  admission: unknown,
  shippingRegionLabels: unknown,
): CatalogValidation {
  const report = validateSalesAdmission(admission);
  const issues = [...report.issues];
  const fail = (path: string) =>
    issues.push({
      path: `d01.${path}`,
      code: "PRINT_SPEC_REQUIRED",
      message: "须填写冻结的完整印刷规格及审核引用；候选打样参数不能替代。",
    });
  const keys = [
    "review",
    "widthMm",
    "heightMm",
    "paper",
    "binding",
    "color",
    "minPages",
    "maxPages",
    "bleedMm",
    "pdfFormat",
    "embeddedFonts",
    "fontLicenseRef",
    "photoMinDpi",
  ];
  if (
    !d01 ||
    typeof d01 !== "object" ||
    Array.isArray(d01) ||
    Object.keys(d01).some((k) => !keys.includes(k))
  )
    fail("specification");
  for (const name of [
    "widthMm",
    "heightMm",
    "minPages",
    "maxPages",
    "bleedMm",
    "photoMinDpi",
  ]) {
    const value = at(d01, name);
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (name === "bleedMm" ? 0 : 1)
    )
      fail(name);
  }
  if (Number(at(d01, "minPages")) > Number(at(d01, "maxPages")))
    fail("maxPages");
  for (const name of ["paper", "binding", "color", "pdfFormat"]) {
    const value = at(d01, name);
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 100 ||
      /[\u0000-\u001f<>]/.test(value)
    )
      fail(name);
  }
  if (at(d01, "embeddedFonts") !== true) fail("embeddedFonts");
  if (at(d01, "review.state") !== "frozen") fail("review.state");
  const review = at(d01, "review");
  if (
    !review ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    Object.keys(review).some(
      (k) => !["state", "ownerRef", "decisionRef", "decidedAt"].includes(k),
    )
  )
    fail("review");
  for (const name of [
    "fontLicenseRef",
    "review.ownerRef",
    "review.decisionRef",
  ]) {
    if (!isRecordReference(at(d01, name))) fail(name);
  }
  if (!isUtcReviewTime(at(d01, "review.decidedAt"))) fail("review.decidedAt");
  const regions = [
    ...(Array.isArray(at(admission, "d05.includedRegionCodes"))
      ? (at(admission, "d05.includedRegionCodes") as string[])
      : []),
    ...(Array.isArray(at(admission, "d05.excludedRegionCodes"))
      ? (at(admission, "d05.excludedRegionCodes") as string[])
      : []),
  ];
  if (
    !shippingRegionLabels ||
    typeof shippingRegionLabels !== "object" ||
    Array.isArray(shippingRegionLabels) ||
    Object.keys(shippingRegionLabels).length !== regions.length ||
    regions.some((code) => {
      const label = at(shippingRegionLabels, code);
      return (
        typeof label !== "string" ||
        !label.trim() ||
        label.length > 60 ||
        /[\u0000-\u001f<>]/.test(label)
      );
    })
  )
    issues.push({
      path: "shippingRegionLabels",
      code: "REGION_LABELS_REQUIRED",
      message: "须逐项提供配送清单中所有地区的公开名称，不增加未列地区。",
    });
  return {
    ...report,
    completeness: issues.length ? "incomplete" : "complete",
    issues,
    approval: "not_verified",
    previewOnly: true,
  };
}
const starts: Record<string, string> = {
  payment_verified: "付款核验成功",
  subject_participation: "讲述者开始参与",
  creation_expired: "制作权益到期",
  delivery_completed: "实体书交付完成",
  asset_created: "素材创建",
  export_ready: "导出包就绪",
  processing_completed: "处理完成",
  delivered: "签收",
  service_first_used: "首次使用服务",
  production_accepted: "印厂接收",
  failure_notified: "无法交付通知",
  error_discovered: "发现错误",
};
/** Only consumer fields enter this DTO. Never return review records or recursively strip private keys. */
export function publicTerms(
  d01: unknown,
  admission: unknown,
  shippingRegionLabels: unknown,
): PackageTerm[] {
  const read = (path: string) => at(admission, path);
  const value = (path: string) => String(read(path));
  const start = (path: string) => starts[value(path)];
  const terms: PackageTerm[] = [
    {
      label: "参与范围",
      text: "一个项目、一位成年讲述者、一位发起人、首本实体书一本。付款及赠礼称呼不替代讲述者本人授权。",
    },
    {
      key: "print_specification",
      label: "印刷规格",
      text: `${at(d01, "widthMm")} × ${at(d01, "heightMm")} mm；${at(d01, "paper")}；${at(d01, "binding")}；${at(d01, "color")}；${at(d01, "minPages")}–${at(d01, "maxPages")} 页。`,
    },
    {
      key: "creation_window",
      label: "制作期限",
      text: `自${start("d02.startsAt")}起 ${value("d02.duration.value")} 个自然日。未开始参与的最长等待为付款后 ${value("d02.notStarted.maxWait.value")} 个自然日，之后${read("d02.notStarted.resolution") === "expire_creation" ? "制作权益到期" : "联系并提供退款处理"}。`,
    },
    {
      key: "creation_expiration",
      label: "暂停与到期",
      text: `暂停时${read("d02.pause.clock") === "stops" ? "停止" : "继续"}计时，累计最多 ${value("d02.pause.maxTotal.value")} 天，达到上限后${read("d02.pause.atLimit") === "resume_clock" ? "恢复计时" : "人工核验"}。到期后停止新录音，首本制作${read("d02.expiration.firstCopy") === "blocked" ? "停止受理" : "需人工核验"}；资料按各自保留期限处理。`,
    },
    {
      key: "shipping",
      label: "配送范围",
      text: `约定运费已包含。支持地区：${(read("d05.includedRegionCodes") as string[]).map((code) => at(shippingRegionLabels, code)).join("、")}；不支持地区：${(read("d05.excludedRegionCodes") as string[]).map((code) => at(shippingRegionLabels, code)).join("、")}。未列地区不开放付款，付款前核验收货地址。`,
    },
    {
      label: "原声回听",
      text: `自${start("d03.onlinePlayback.startsAt")}起 ${value("d03.onlinePlayback.duration.value")} 天，到期停止在线访问。`,
    },
    {
      label: "完整资料导出",
      text: `已包含，客服核验本人身份及范围后人工交付原声、转录、确认稿、照片、PDF和清单。申请期限自${start("d03.exportRequests.startsAt")}起 ${value("d03.exportRequests.duration.value")} 天。`,
    },
  ];
  for (const [key, label] of Object.entries({
    originalAudio: "原始录音",
    originalPhotos: "照片原图",
    derivedAudio: "衍生音频",
    derivedPhotos: "衍生图片",
    transcripts: "转录",
    confirmedStories: "确认稿",
    bookPdf: "书稿PDF",
    exportPackages: "导出包",
    activeData: "活动资料",
    historicalObjects: "历史对象",
    backupCopies: "备份副本",
    supplierCopies: "服务方副本",
  }))
    terms.push({
      label: `${label}保留`,
      text: `自${start(`d03.retention.${key}.startsAt`)}起 ${value(`d03.retention.${key}.duration.value`)} 天。`,
    });
  for (const [key, label] of Object.entries({
    activeData: "活动资料",
    historicalObjects: "历史对象",
    backupCopies: "备份副本",
    supplierCopies: "服务方副本",
  }))
    terms.push({
      label: `${label}删除`,
      text: `删除请求核验后 ${value(`d03.deletion.${key}.within.value`)} 个自然日内处理，分别告知进度。`,
    });
  terms.push({
    label: "到期告知",
    text: `提前 ${value("d03.expiryNotice.advance.value")} 天告知；退款不等于删除资料。`,
  });
  for (const [key, label] of Object.entries({
    recordingPerClip: "单段录音",
    recordingTotal: "总录音",
    photos: "照片",
    storyOrganizations: "故事整理",
    activeRegenerations: "主动重新生成",
    followUps: "追问",
  }))
    terms.push({
      label: `${label}额度`,
      text: `${value(`d04.userQuotas.${key}.value`)} ${read(`d04.userQuotas.${key}.unit`) === "seconds" ? "秒" : key === "photos" ? "张" : "次"}；超额后${read(`d04.userQuotas.${key}.excess`) === "stop" ? "停止受理" : "停止并联系客服"}。系统重试不扣用户额度。`,
    });
  for (const [key, label, trigger] of [
    ["proofreading", "校对", "提出校对申请"],
    ["completeExport", "导出处理", "核验身份和范围"],
    ["production", "生产", "书稿锁定且运营审核通过"],
    ["logistics", "物流", "承运方接收"],
    ["customerService", "客服响应", "收到请求"],
    ["afterSales", "售后处理", "核验售后请求"],
  ])
    terms.push({
      key: `service.${key}`,
      label,
      text: `${trigger}后 ${value(`d06.${key}.within.value`)} 个工作日内处理。`,
    });
  const remedies: Record<string, string> = {
    refund: "退款",
    reprint_or_refund: "重印或退款",
    resend_or_refund: "补寄或退款",
    correction_and_explain: "更正与说明",
  };
  const creation: Record<string, string> = {
    retain: "保留",
    suspend: "暂停",
    terminate: "终止",
  };
  const copy: Record<string, string> = {
    retain: "保留",
    cancel: "取消",
    consumed: "已使用",
    quality_remedy: "原单质量处理",
  };
  const production: Record<string, string> = {
    none: "无需生产处理",
    check_and_stop_if_possible: "核查并尽可能停止生产",
    remedy_original_order: "按原订单补救",
    already_produced: "已生产",
  };
  for (const [key, label] of Object.entries({
    notParticipated: "未参与",
    usedNotProduced: "已使用未投产",
    inProduction: "已投产",
    platformUnableDeliver: "平台无法交付",
    qualityDamaged: "破损",
    qualityMissingPages: "缺页",
    qualityWrongVersion: "印错版本",
    qualityLayoutError: "排版错误",
    postConfirmationFactualError: "确认后发现事实错误",
  })) {
    const p = `d07.${key}`;
    terms.push({
      label: `退款与售后 · ${label}`,
      text: `自${start(`${p}.requestWindow.startsAt`)}起 ${value(`${p}.requestWindow.duration.value`)} 天内申请；${remedies[value(`${p}.remedy`)]}，退款金额 ¥${(Number(read(`${p}.refundAmount.value`)) / 100).toFixed(2)}，核验后 ${value(`${p}.processing.within.value`)} 天内处理。制作权益${creation[value(`${p}.entitlementEffect.creation`)]}，首本权益${copy[value(`${p}.entitlementEffect.firstCopy`)]}；${production[value(`${p}.productionAction`)]}。`,
    });
  }
  terms.push({
    label: "售后与资料权利",
    text: "质量重印沿用原订单；没有个人微信的讲述者可经客服核验申请撤回、导出与删除。",
  });
  return terms;
}
