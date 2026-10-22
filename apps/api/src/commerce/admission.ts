export interface AdmissionIssue {
  path: string;
  code: string;
  message: string;
}

export interface AdmissionReport {
  completeness: "complete" | "incomplete";
  salesAuthorized: false;
  evidenceAuthenticity: "not_verified";
  issues: AdmissionIssue[];
}

/** Checks decision-file completeness only. Never authorizes sales or verifies evidence. */
export function validateSalesAdmission(input: unknown): AdmissionReport {
  const issues: AdmissionIssue[] = [];
  const at = (path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value !== null &&
          typeof value === "object" &&
          Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined,
        input,
      );
  const issue = (path: string, code: string, message: string) =>
    issues.push({ path, code, message });
  const shape = (path: string, allowed: readonly string[]) => {
    const value = path === "$" ? input : at(path);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issue(
        path,
        "OBJECT_REQUIRED",
        "须按模板逐项填写对象，不能以完成状态文字替代。",
      );
    } else if (Object.keys(value).some((key) => !allowed.includes(key))) {
      // Do not echo unexpected keys: they can themselves contain private material.
      issue(
        path,
        "UNEXPECTED_FIELD",
        "含未支持字段；请对照模板，勿在决策文件中放凭据或私人证据正文。",
      );
    }
  };
  const exact = (path: string, expected: unknown, code = "INVALID_VALUE") => {
    if (at(path) !== expected)
      issue(path, code, "缺少已确定的规定值；请按填表说明核对。");
  };
  const reference = (path: string) => {
    if (
      typeof at(path) !== "string" ||
      !/^record:[A-Za-z0-9][A-Za-z0-9._/-]{2,119}$/.test(at(path) as string) ||
      /(?:^record:|[/.])(pending|unknown|tbd|todo|approved|completed|null|undefined)$/i.test(
        at(path) as string,
      )
    ) {
      issue(
        path,
        "REFERENCE_REQUIRED",
        "须填受限证据库的 record: 引用，不填写证据正文或凭据。",
      );
    }
  };
  const date = (path: string) => {
    const value = at(path);
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value.replace("Z", ".000Z")
    ) {
      issue(path, "INVALID_DATE", "须填明确的 UTC 审核时间。");
    }
  };
  const choice = (path: string, values: readonly string[]) => {
    if (!values.includes(at(path) as string))
      issue(path, "INVALID_VALUE", "必须明确选择填表说明中的规则。");
  };
  const integer = (
    path: string,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
  ) => {
    const value = at(path);
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      issue(
        path,
        "INVALID_INTEGER",
        "须填规定范围内的整数，不接受字符串、负值或未知值。",
      );
    }
  };
  const quantity = (
    path: string,
    unit: string,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
    extra: string[] = [],
  ) => {
    shape(path, ["value", "unit", ...extra]);
    integer(`${path}.value`, minimum, maximum);
    exact(`${path}.unit`, unit);
  };
  shape("$", [
    "schemaVersion",
    "purpose",
    "package",
    "d02",
    "d03",
    "d04",
    "d05",
    "d06",
    "d07",
    "d08",
  ]);
  shape("package", [
    "price",
    "projects",
    "adultSubjects",
    "initiators",
    "firstCopies",
    "rolesDistinct",
    "agreedShippingIncluded",
    "completeExportIncluded",
    "paidExtraCopies",
    "paidExtraPages",
  ]);
  shape("package.price", ["value", "unit", "currency"]);
  exact("schemaVersion", 1);
  exact("purpose", "admission_review");
  exact("package.price.value", 99900);
  exact("package.price.unit", "fen");
  exact("package.price.currency", "CNY");
  for (const field of [
    "projects",
    "adultSubjects",
    "initiators",
    "firstCopies",
  ])
    exact(`package.${field}`, 1);
  for (const field of [
    "rolesDistinct",
    "agreedShippingIncluded",
    "completeExportIncluded",
  ])
    exact(`package.${field}`, true);
  for (const field of ["paidExtraCopies", "paidExtraPages"])
    exact(`package.${field}`, false);
  for (const decision of ["d02", "d03", "d04", "d05", "d06", "d07", "d08"]) {
    shape(`${decision}.review`, [
      "state",
      "ownerRef",
      "decisionRef",
      "decidedAt",
    ]);
    exact(`${decision}.review.state`, "frozen", "NOT_FROZEN");
    reference(`${decision}.review.ownerRef`);
    reference(`${decision}.review.decisionRef`);
    date(`${decision}.review.decidedAt`);
  }
  quantity("d02.duration", "calendar_days");
  choice("d02.startsAt", ["payment_verified", "subject_participation"]);
  quantity("d02.notStarted.maxWait", "calendar_days");
  exact("d02.notStarted.startsAt", "payment_verified");
  choice("d02.notStarted.resolution", [
    "contact_and_offer_refund",
    "expire_creation",
  ]);
  reference("d02.notStarted.noticeRef");
  choice("d02.pause.clock", ["continues", "stops"]);
  quantity("d02.pause.maxTotal", "calendar_days", 0);
  choice("d02.pause.atLimit", ["resume_clock", "manual_review"]);
  reference("d02.pause.policyRef");
  exact("d02.expiration.newRecording", "blocked");
  choice("d02.expiration.firstCopy", ["blocked", "manual_review"]);
  exact("d02.expiration.existingData", "per_d03");
  reference("d02.expiration.noticeRef");
  const serviceTerm = (
    path: string,
    starts: readonly string[],
    extra: string[] = [],
  ) => {
    shape(path, ["duration", "startsAt", ...extra]);
    quantity(`${path}.duration`, "calendar_days");
    choice(`${path}.startsAt`, starts);
  };
  const serviceStarts = [
    "payment_verified",
    "subject_participation",
    "creation_expired",
    "delivery_completed",
  ];
  serviceTerm("d03.onlinePlayback", serviceStarts, ["expires"]);
  exact("d03.onlinePlayback.expires", "stop_access");
  serviceTerm("d03.exportRequests", serviceStarts, ["channelRef"]);
  reference("d03.exportRequests.channelRef");
  for (const kind of [
    "originalAudio",
    "originalPhotos",
    "derivedAudio",
    "derivedPhotos",
    "transcripts",
    "confirmedStories",
    "bookPdf",
    "activeData",
    "historicalObjects",
    "backupCopies",
  ]) {
    serviceTerm(`d03.retention.${kind}`, [...serviceStarts, "asset_created"]);
  }
  serviceTerm("d03.retention.exportPackages", ["export_ready"]);
  serviceTerm("d03.retention.supplierCopies", ["processing_completed"]);
  for (const kind of [
    "activeData",
    "historicalObjects",
    "backupCopies",
    "supplierCopies",
  ]) {
    quantity(`d03.deletion.${kind}.within`, "calendar_days");
    exact(`d03.deletion.${kind}.startsAt`, "verified_deletion_request");
    reference(`d03.deletion.${kind}.procedureRef`);
  }
  quantity("d03.expiryNotice.advance", "calendar_days", 0);
  reference("d03.expiryNotice.channelRef");
  reference("d03.expiryNotice.policyRef");
  exact("d03.copyStatusSeparately", true);
  exact("d03.restoreAppliesDeletionLedger", true);
  for (const [kind, unit] of [
    ["recordingPerClip", "seconds"],
    ["recordingTotal", "seconds"],
    ["photos", "count"],
    ["storyOrganizations", "count"],
    ["activeRegenerations", "count"],
    ["followUps", "count"],
  ]) {
    quantity(`d04.userQuotas.${kind}`, unit, 1, Number.MAX_SAFE_INTEGER, [
      "excess",
      "noticeRef",
    ]);
    choice(`d04.userQuotas.${kind}.excess`, [
      "stop",
      "stop_and_contact_support",
    ]);
    reference(`d04.userQuotas.${kind}.noticeRef`);
  }
  const clip = at("d04.userQuotas.recordingPerClip.value");
  const total = at("d04.userQuotas.recordingTotal.value");
  if (typeof clip === "number" && typeof total === "number" && total < clip) {
    issue(
      "d04.userQuotas.recordingTotal.value",
      "INCONSISTENT_LIMIT",
      "总录音额度不得小于单段额度。",
    );
  }
  for (const kind of ["asrSubmissions", "asrPolls", "systemRetries"])
    quantity(
      `d04.providerBudget.${kind}`,
      "count",
      kind === "systemRetries" ? 0 : 1,
    );
  quantity("d04.providerBudget.costCap", "fen");
  exact("d04.providerBudget.scope", "per_project");
  exact("d04.providerBudget.exhausted", "manual_review");
  reference("d04.providerBudget.ownerRef");
  exact("d04.systemRetriesChargeUserQuota", false);
  reference("d05.regionCatalogRef");
  for (const kind of ["includedRegionCodes", "excludedRegionCodes"]) {
    const value = at(`d05.${kind}`);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      Array.from(value).some(
        (code) =>
          typeof code !== "string" || !/^[A-Z]{2}-[A-Z0-9]{2,8}$/.test(code),
      ) ||
      new Set(value).size !== value.length
    ) {
      issue(
        `d05.${kind}`,
        "INVALID_REGIONS",
        "须填不重复的明确地区代码清单，不接受通配符。",
      );
    }
  }
  const included = at("d05.includedRegionCodes");
  const excluded = at("d05.excludedRegionCodes");
  if (
    Array.isArray(included) &&
    Array.isArray(excluded) &&
    included.some((code) => excluded.includes(code))
  ) {
    issue(
      "d05.excludedRegionCodes",
      "OVERLAPPING_REGIONS",
      "含运费地区与不支持地区不得重叠。",
    );
  }
  exact("d05.unlistedRegion", "reject_before_payment");
  exact("d05.shippingFeeIncluded", true);
  reference("d05.beforePaymentNoticeRef");
  exact("d05.verification.method", "address_code_and_manual_review");
  reference("d05.verification.evidenceRef");
  reference("d05.verification.ownerRef");
  date("d05.verification.checkedAt");
  reference("d06.businessCalendarRef");
  for (const [kind, startsAt] of [
    ["proofreading", "proofreading_requested"],
    ["completeExport", "export_identity_and_scope_verified"],
    ["production", "book_locked_and_operations_approved"],
    ["logistics", "carrier_accepted"],
    ["customerService", "request_received"],
    ["afterSales", "after_sales_request_verified"],
  ]) {
    quantity(`d06.${kind}.within`, "business_days");
    exact(`d06.${kind}.startsAt`, startsAt);
    reference(`d06.${kind}.ownerRef`);
    reference(`d06.${kind}.procedureRef`);
  }
  exact("d06.logisticsScope", "all_included_regions");
  exact("d07.refundDeletesData", false);
  exact("d07.qualityReprintUsesOriginalOrder", true);
  const refundCases = [
    ["notParticipated", "payment_verified"],
    ["usedNotProduced", "service_first_used"],
    ["inProduction", "production_accepted"],
    ["platformUnableDeliver", "failure_notified"],
    ["qualityDamaged", "delivered"],
    ["qualityMissingPages", "delivered"],
    ["qualityWrongVersion", "delivered"],
    ["qualityLayoutError", "delivered"],
    ["postConfirmationFactualError", "error_discovered"],
  ] as const;
  for (const [kind, startsAt] of refundCases) {
    quantity(`d07.${kind}.refundAmount`, "fen", 0, 99900);
    serviceTerm(`d07.${kind}.requestWindow`, [startsAt]);
    quantity(`d07.${kind}.processing.within`, "calendar_days");
    exact(`d07.${kind}.processing.startsAt`, "verified_refund_request");
    choice(`d07.${kind}.remedy`, [
      "refund",
      "reprint_or_refund",
      "resend_or_refund",
      "correction_and_explain",
    ]);
    choice(`d07.${kind}.entitlementEffect.creation`, [
      "retain",
      "suspend",
      "terminate",
    ]);
    choice(`d07.${kind}.entitlementEffect.firstCopy`, [
      "retain",
      "cancel",
      "consumed",
      "quality_remedy",
    ]);
    choice(`d07.${kind}.productionAction`, [
      "none",
      "check_and_stop_if_possible",
      "remedy_original_order",
      "already_produced",
    ]);
    reference(`d07.${kind}.policyRef`);
    reference(`d07.${kind}.ownerRef`);
  }
  for (const kind of ["legalEntityRef", "categoryId", "paymentPathId"])
    reference(`d08.identity.${kind}`);
  for (const field of ["appId", "merchantId"]) {
    const value = at(`d08.identity.${field}`);
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value) ||
      /^(pending|unknown|null|undefined|approved|completed|tbd)$/i.test(value)
    ) {
      issue(
        `d08.identity.${field}`,
        "INVALID_IDENTIFIER",
        "须填有界、无空白的实际标识；格式检查不代表平台身份有效。",
      );
    }
  }
  exact("d08.identity.productType", "digital-production-plus-physical-book");
  const evidence = (path: string) => {
    exact(`${path}.outcome`, "approved", "NOT_APPROVED");
    reference(`${path}.evidenceRef`);
    reference(`${path}.reviewerRef`);
    date(`${path}.checkedAt`);
  };
  for (const kind of [
    "merchantBinding",
    "productAdmission",
    "iosPayment",
    "androidPayment",
    "shippingManagement",
  ]) {
    const path = `d08.platform.${kind}`;
    evidence(path);
    reference(`${path}.requirementsRef`);
    for (const field of [
      "legalEntityRef",
      "appId",
      "merchantId",
      "categoryId",
      "paymentPathId",
      "productType",
    ]) {
      if (
        at(`${path}.scope.${field}`) === undefined ||
        at(`${path}.scope.${field}`) === null ||
        at(`${path}.scope.${field}`) !== at(`d08.identity.${field}`)
      ) {
        issue(
          `${path}.scope.${field}`,
          "IDENTITY_MISMATCH",
          "证据范围须与本文件的主体、AppID、商户和实际商品支付路径完全一致。",
        );
      }
    }
  }
  for (const device of ["iosPayment", "androidPayment"]) {
    reference(`d08.platform.${device}.deviceTestRef`);
    exact(`d08.platform.${device}.paymentAndQuery`, "passed", "NOT_APPROVED");
  }
  reference("d08.platform.shippingManagement.fulfillmentTestRef");
  choice("d08.platform.shippingManagement.requirementHandling", [
    "implemented_and_verified",
    "platform_exemption_verified",
  ]);
  evidence("d08.identityBinding");
  reference("d08.identityBinding.procedureRef");
  for (const field of [
    "subjectAndOperatorSeparate",
    "subjectAppliesInitiatorConfirms",
    "rejectInitiatorSelfBinding",
    "paymentIsNotConsent",
  ])
    exact(`d08.identityBinding.${field}`, true);
  evidence("d08.assistedConsent");
  for (const field of ["evidenceFormRef", "captureProcedureRef", "ownerRef"])
    reference(`d08.assistedConsent.${field}`);
  for (const field of [
    "subjectPresenceRequired",
    "bindsSubjectAndOperator",
    "bindsPurposeAndNoticeVersion",
    "bindsExactContentVersion",
    "everyConfirmationRecorded",
  ])
    exact(`d08.assistedConsent.${field}`, true);
  for (const field of [
    "channelRef",
    "verificationProcedureRef",
    "ownerRef",
    "decisionNoticeRef",
  ])
    reference(`d08.disputes.${field}`);
  exact("d08.disputes.interimAction", "freeze_access_and_processing");
  quantity("d08.disputes.resolutionWithin", "calendar_days");
  for (const right of ["withdrawal", "export", "deletion"]) {
    const path = `d08.withoutWechat.${right}`;
    for (const field of [
      "channelRef",
      "identityVerificationRef",
      "scopeVerificationRef",
      "confirmationChannelRef",
      "ownerRef",
    ])
      reference(`${path}.${field}`);
    quantity(`${path}.responseWithin`, "calendar_days");
    exact(`${path}.applicant`, "verified_subject");
  }
  reference("d08.withoutWechat.export.deliveryChannelRef");
  exact(
    "d08.withoutWechat.export.recipient",
    "verified_subject_or_explicitly_authorized_recipient",
  );
  exact("d08.withoutWechat.export.neverDefaultToInitiator", true);
  evidence("d08.privacy");
  reference("d08.privacy.noticeVersionRef");
  for (const field of [
    "collectionAiSharingPrintSeparate",
    "withdrawalStopsAccessAndProcessing",
    "minimumProductionDataOnly",
  ])
    exact(`d08.privacy.${field}`, true);
  for (const [kind, purpose, requiredKinds, allowedKinds] of [
    ["asr", "file_asr", ["original_audio"], ["original_audio"]],
    [
      "text",
      "story_and_follow_up",
      ["transcripts"],
      ["transcripts", "photo_descriptions"],
    ],
    [
      "printing",
      "print_and_ship",
      ["production_pdf", "shipping_address"],
      ["production_pdf", "shipping_address"],
    ],
  ] as const) {
    const path = `d08.suppliers.${kind}`;
    evidence(path);
    for (const field of [
      "providerRef",
      "serviceConfigRef",
      "termsRef",
      "dataRegionRef",
      "ownerRef",
      "deletionProcedureRef",
    ])
      reference(`${path}.${field}`);
    exact(`${path}.purpose`, purpose);
    const kinds = at(`${path}.dataKinds`);
    if (
      !Array.isArray(kinds) ||
      new Set(kinds).size !== kinds.length ||
      requiredKinds.some((value) => !kinds.includes(value)) ||
      kinds.some(
        (value) => !(allowedKinds as readonly unknown[]).includes(value),
      )
    ) {
      issue(
        `${path}.dataKinds`,
        "INVALID_DATA_SCOPE",
        "处理范围须覆盖此用途的必要资料，且不得包含该用途以外的资料。",
      );
    }
    serviceTerm(`${path}.retention`, ["processing_completed"]);
    quantity(`${path}.deletionWithin`, "calendar_days");
    choice(`${path}.trainingUse`, ["prohibited", "separate_subject_consent"]);
    choice(`${path}.onwardSharing`, [
      "prohibited",
      "contracted_subprocessors_only",
    ]);
    for (const [field, promisePath] of [
      [
        "retention.duration.value",
        "d03.retention.supplierCopies.duration.value",
      ],
      ["deletionWithin.value", "d03.deletion.supplierCopies.within.value"],
    ]) {
      const supplierValue = at(`${path}.${field}`);
      const promised = at(promisePath);
      if (
        typeof supplierValue === "number" &&
        typeof promised === "number" &&
        supplierValue > promised
      ) {
        issue(
          `${path}.${field}`,
          "COPY_TERM_MISMATCH",
          "供应商副本期限不得超过 D03 对用户公示的期限。",
        );
      }
    }
  }
  shape("d02", [
    "review",
    "duration",
    "startsAt",
    "notStarted",
    "pause",
    "expiration",
  ]);
  shape("d02.notStarted", ["maxWait", "startsAt", "resolution", "noticeRef"]);
  shape("d02.pause", ["clock", "maxTotal", "atLimit", "policyRef"]);
  shape("d02.expiration", [
    "newRecording",
    "firstCopy",
    "existingData",
    "noticeRef",
  ]);
  shape("d03", [
    "review",
    "onlinePlayback",
    "exportRequests",
    "retention",
    "deletion",
    "expiryNotice",
    "copyStatusSeparately",
    "restoreAppliesDeletionLedger",
  ]);
  shape("d03.retention", [
    "originalAudio",
    "originalPhotos",
    "derivedAudio",
    "derivedPhotos",
    "transcripts",
    "confirmedStories",
    "bookPdf",
    "exportPackages",
    "activeData",
    "historicalObjects",
    "backupCopies",
    "supplierCopies",
  ]);
  shape("d03.deletion", [
    "activeData",
    "historicalObjects",
    "backupCopies",
    "supplierCopies",
  ]);
  for (const kind of [
    "activeData",
    "historicalObjects",
    "backupCopies",
    "supplierCopies",
  ])
    shape(`d03.deletion.${kind}`, ["within", "startsAt", "procedureRef"]);
  shape("d03.expiryNotice", ["advance", "channelRef", "policyRef"]);
  shape("d04", [
    "review",
    "userQuotas",
    "providerBudget",
    "systemRetriesChargeUserQuota",
  ]);
  shape("d04.userQuotas", [
    "recordingPerClip",
    "recordingTotal",
    "photos",
    "storyOrganizations",
    "activeRegenerations",
    "followUps",
  ]);
  shape("d04.providerBudget", [
    "asrSubmissions",
    "asrPolls",
    "systemRetries",
    "costCap",
    "scope",
    "exhausted",
    "ownerRef",
  ]);
  shape("d05", [
    "review",
    "regionCatalogRef",
    "includedRegionCodes",
    "excludedRegionCodes",
    "unlistedRegion",
    "shippingFeeIncluded",
    "beforePaymentNoticeRef",
    "verification",
  ]);
  shape("d05.verification", ["method", "evidenceRef", "checkedAt", "ownerRef"]);
  shape("d06", [
    "review",
    "businessCalendarRef",
    "proofreading",
    "completeExport",
    "production",
    "logistics",
    "customerService",
    "afterSales",
    "logisticsScope",
  ]);
  for (const kind of [
    "proofreading",
    "completeExport",
    "production",
    "logistics",
    "customerService",
    "afterSales",
  ])
    shape(`d06.${kind}`, ["within", "startsAt", "ownerRef", "procedureRef"]);
  shape("d07", [
    "review",
    "refundDeletesData",
    "qualityReprintUsesOriginalOrder",
    ...refundCases.map(([kind]) => kind),
  ]);
  for (const [kind] of refundCases) {
    shape(`d07.${kind}`, [
      "refundAmount",
      "requestWindow",
      "processing",
      "remedy",
      "entitlementEffect",
      "productionAction",
      "policyRef",
      "ownerRef",
    ]);
    shape(`d07.${kind}.processing`, ["within", "startsAt"]);
    shape(`d07.${kind}.entitlementEffect`, ["creation", "firstCopy"]);
  }
  shape("d08", [
    "review",
    "identity",
    "platform",
    "identityBinding",
    "assistedConsent",
    "disputes",
    "withoutWechat",
    "privacy",
    "suppliers",
  ]);
  const identityFields = [
    "legalEntityRef",
    "appId",
    "merchantId",
    "categoryId",
    "paymentPathId",
    "productType",
  ];
  const evidenceFields = ["outcome", "evidenceRef", "reviewerRef", "checkedAt"];
  shape("d08.identity", identityFields);
  shape("d08.platform", [
    "merchantBinding",
    "productAdmission",
    "iosPayment",
    "androidPayment",
    "shippingManagement",
  ]);
  for (const kind of [
    "merchantBinding",
    "productAdmission",
    "iosPayment",
    "androidPayment",
    "shippingManagement",
  ]) {
    const extra =
      kind === "iosPayment" || kind === "androidPayment"
        ? ["deviceTestRef", "paymentAndQuery"]
        : kind === "shippingManagement"
          ? ["fulfillmentTestRef", "requirementHandling"]
          : [];
    shape(`d08.platform.${kind}`, [
      ...evidenceFields,
      "scope",
      "requirementsRef",
      ...extra,
    ]);
    shape(`d08.platform.${kind}.scope`, identityFields);
  }
  shape("d08.identityBinding", [
    ...evidenceFields,
    "procedureRef",
    "subjectAndOperatorSeparate",
    "subjectAppliesInitiatorConfirms",
    "rejectInitiatorSelfBinding",
    "paymentIsNotConsent",
  ]);
  shape("d08.assistedConsent", [
    ...evidenceFields,
    "subjectPresenceRequired",
    "evidenceFormRef",
    "captureProcedureRef",
    "bindsSubjectAndOperator",
    "bindsPurposeAndNoticeVersion",
    "bindsExactContentVersion",
    "everyConfirmationRecorded",
    "ownerRef",
  ]);
  shape("d08.disputes", [
    "channelRef",
    "verificationProcedureRef",
    "interimAction",
    "resolutionWithin",
    "ownerRef",
    "decisionNoticeRef",
  ]);
  shape("d08.withoutWechat", ["withdrawal", "export", "deletion"]);
  for (const right of ["withdrawal", "export", "deletion"]) {
    const extra =
      right === "export"
        ? ["deliveryChannelRef", "recipient", "neverDefaultToInitiator"]
        : [];
    shape(`d08.withoutWechat.${right}`, [
      "channelRef",
      "identityVerificationRef",
      "scopeVerificationRef",
      "confirmationChannelRef",
      "ownerRef",
      "responseWithin",
      "applicant",
      ...extra,
    ]);
  }
  shape("d08.privacy", [
    ...evidenceFields,
    "noticeVersionRef",
    "collectionAiSharingPrintSeparate",
    "withdrawalStopsAccessAndProcessing",
    "minimumProductionDataOnly",
  ]);
  shape("d08.suppliers", ["asr", "text", "printing"]);
  for (const kind of ["asr", "text", "printing"])
    shape(`d08.suppliers.${kind}`, [
      ...evidenceFields,
      "providerRef",
      "serviceConfigRef",
      "termsRef",
      "dataRegionRef",
      "ownerRef",
      "purpose",
      "dataKinds",
      "retention",
      "deletionWithin",
      "deletionProcedureRef",
      "trainingUse",
      "onwardSharing",
    ]);
  return {
    completeness: issues.length ? "incomplete" : "complete",
    salesAuthorized: false,
    evidenceAuthenticity: "not_verified",
    issues,
  };
}
