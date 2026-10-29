import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function checkFile(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "timenook-admission-"));
  try {
    const path = join(directory, "decisions.json");
    writeFileSync(path, JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [join(__dirname, "../src/commerce/admission-cli.js"), "--file", path],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("local decision check rejects an empty file without authorizing sales", () => {
  const result = checkFile({});
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completeness, "incomplete");
  assert.equal(report.salesAuthorized, false);
  assert.ok(
    report.issues.some(
      (issue: { path: string; code: string }) =>
        issue.path === "schemaVersion" && issue.code === "INVALID_VALUE",
    ),
  );
});

import { validateSalesAdmission } from "../src/commerce/admission";

const frozen = {
  state: "frozen",
  ownerRef: "record:operations-owner",
  decisionRef: "record:decision-review",
  decidedAt: "2026-10-22T08:00:00Z",
};
const base = () => ({
  schemaVersion: 1,
  purpose: "admission_review",
  package: {
    price: { value: 99900, unit: "fen", currency: "CNY" },
    projects: 1,
    adultSubjects: 1,
    initiators: 1,
    firstCopies: 1,
    rolesDistinct: true,
    agreedShippingIncluded: true,
    completeExportIncluded: true,
    paidExtraCopies: false,
    paidExtraPages: false,
  },
});
const hasIssue = (input: unknown, path: string, code: string) =>
  validateSalesAdmission(input).issues.some(
    (issue) => issue.path === path && issue.code === code,
  );

test("999 yuan must be integer fen and all seven decisions need named frozen review records", () => {
  const candidate = {
    ...base(),
    package: {
      ...base().package,
      price: { value: 999, unit: "yuan", currency: "CNY" },
    },
    d02: { review: { state: "approved" } },
  };
  assert.ok(hasIssue(candidate, "package.price.value", "INVALID_VALUE"));
  assert.ok(hasIssue(candidate, "package.price.unit", "INVALID_VALUE"));
  assert.ok(hasIssue(candidate, "d02.review.state", "NOT_FROZEN"));
  assert.ok(hasIssue(candidate, "d02.review.ownerRef", "REFERENCE_REQUIRED"));
  assert.ok(hasIssue(candidate, "d08.review.state", "NOT_FROZEN"));
  assert.ok(
    !validateSalesAdmission(candidate).issues.some((issue) =>
      /^d0[19]|^d10/.test(issue.path),
    ),
  );
});

const days = (value: number) => ({ value, unit: "calendar_days" });
const creationDecision = () => ({ review: frozen, service: "lifetime" });
test("creation service is lifetime and configurable creation clocks are rejected", () => {
  const d02 = creationDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d02 }).issues.filter((issue) =>
      issue.path.startsWith("d02."),
    ),
    [],
  );
  assert.ok(
    hasIssue(
      { ...base(), d02: { ...d02, service: "finite" } },
      "d02.service",
      "INVALID_VALUE",
    ),
  );
  assert.ok(
    validateSalesAdmission({
      ...base(),
      d02: { ...d02, duration: days(180) },
    }).issues.some((issue) => issue.path === "d02"),
  );
});

const term = (value: number, startsAt = "delivery_completed") => ({
  duration: days(value),
  startsAt,
});
const deletion = (value: number) => ({
  within: days(value),
  startsAt: "verified_deletion_request",
  procedureRef: "record:deletion-procedure",
});
const dataDecision = () => ({
  review: frozen,
  onlinePlayback: { service: "lifetime" },
  exportRequests: { service: "lifetime", channelRef: "record:export-intake" },
  retention: {
    ...Object.fromEntries(
      [
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
      ].map((kind) => [kind, { service: "lifetime" }]),
    ),
    supplierCopies: term(30, "processing_completed"),
  },
  deletion: {
    activeData: deletion(7),
    historicalObjects: deletion(7),
    backupCopies: deletion(30),
    supplierCopies: deletion(30),
  },
  copyStatusSeparately: true,
});
test("necessary materials and downloads are lifetime while verified deletion and temporary supplier handling remain bounded", () => {
  const d03 = dataDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d03 }).issues.filter((issue) =>
      issue.path.startsWith("d03."),
    ),
    [],
  );
  const input = {
    ...base(),
    d03: {
      ...d03,
      onlinePlayback: { service: "finite" },
      retention: { ...d03.retention, originalAudio: term(400) },
      deletion: { ...d03.deletion, backupCopies: null },
    },
  };
  assert.ok(hasIssue(input, "d03.onlinePlayback.service", "INVALID_VALUE"));
  assert.ok(
    hasIssue(input, "d03.retention.originalAudio.service", "INVALID_VALUE"),
  );
  assert.ok(
    hasIssue(
      input,
      "d03.deletion.backupCopies.within.value",
      "INVALID_INTEGER",
    ),
  );
});

const quota = (value: number, unit: string) => ({
  value,
  unit,
  excess: "stop_and_contact_support",
  noticeRef: "record:quota-notice",
});
const quotaDecision = () => ({
  review: frozen,
  userQuotas: {
    recordingPerClip: quota(600, "seconds"),
    recordingTotal: quota(36000, "seconds"),
    photos: quota(80, "count"),
    storyOrganizations: quota(50, "count"),
    activeRegenerations: quota(20, "count"),
    followUps: quota(100, "count"),
  },
  providerBudget: {
    asrSubmissions: { value: 150, unit: "count" },
    asrPolls: { value: 1000, unit: "count" },
    systemRetries: { value: 20, unit: "count" },
    costCap: { value: 5000, unit: "fen" },
    scope: "per_project",
    exhausted: "manual_review",
    ownerRef: "record:cost-owner",
  },
  systemRetriesChargeUserQuota: false,
});

test("user quotas are explicit and provider submissions, polling and retry budgets cannot stand in for them", () => {
  const d04 = quotaDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d04 }).issues.filter((issue) =>
      issue.path.startsWith("d04."),
    ),
    [],
  );
  const input = {
    ...base(),
    d04: {
      ...d04,
      userQuotas: {
        ...d04.userQuotas,
        recordingTotal: quota(60, "seconds"),
        activeRegenerations: null,
        followUps: quota(100, "calls"),
        photos: { ...quota(80, "count"), excess: "buy_more" },
      },
      providerBudget: { ...d04.providerBudget, asrPolls: null },
      systemRetriesChargeUserQuota: true,
    },
  };
  assert.ok(
    hasIssue(
      input,
      "d04.userQuotas.recordingTotal.value",
      "INCONSISTENT_LIMIT",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d04.userQuotas.activeRegenerations.value",
      "INVALID_INTEGER",
    ),
  );
  assert.ok(hasIssue(input, "d04.userQuotas.followUps.unit", "INVALID_VALUE"));
  assert.ok(hasIssue(input, "d04.userQuotas.photos.excess", "INVALID_VALUE"));
  assert.ok(
    hasIssue(input, "d04.providerBudget.asrPolls.value", "INVALID_INTEGER"),
  );
  assert.ok(
    hasIssue(input, "d04.systemRetriesChargeUserQuota", "INVALID_VALUE"),
  );
});

const shippingDecision = () => ({
  review: frozen,
  regionCatalogRef: "record:shipping-region-catalog",
  includedRegionCodes: ["CN-110000", "CN-310000"],
  excludedRegionCodes: ["CN-810000"],
  unlistedRegion: "reject_before_payment",
  shippingFeeIncluded: true,
  beforePaymentNoticeRef: "record:shipping-notice",
  verification: {
    method: "address_code_and_manual_review",
    evidenceRef: "record:shipping-check",
    checkedAt: "2026-10-22T08:00:00Z",
    ownerRef: "record:shipping-owner",
  },
});

test("shipping lists must be explicit, disjoint and checked before payment", () => {
  const d05 = shippingDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d05 }).issues.filter((issue) =>
      issue.path.startsWith("d05."),
    ),
    [],
  );
  const input = {
    ...base(),
    d05: {
      ...d05,
      excludedRegionCodes: ["CN-110000"],
      verification: { status: "approved" },
      unlistedRegion: "allow",
    },
  };
  assert.ok(hasIssue(input, "d05.excludedRegionCodes", "OVERLAPPING_REGIONS"));
  assert.ok(
    hasIssue(input, "d05.verification.evidenceRef", "REFERENCE_REQUIRED"),
  );
  assert.ok(hasIssue(input, "d05.unlistedRegion", "INVALID_VALUE"));
});

const sla = (value: number, startsAt: string) => ({
  within: { value, unit: "business_days" },
  startsAt,
  ownerRef: "record:service-owner",
  procedureRef: "record:service-procedure",
});
const serviceDecision = () => ({
  review: frozen,
  businessCalendarRef: "record:service-calendar",
  proofreading: sla(3, "proofreading_requested"),
  completeExport: sla(3, "export_identity_and_scope_verified"),
  production: sla(10, "book_locked_and_operations_approved"),
  logistics: sla(5, "carrier_accepted"),
  customerService: sla(1, "request_received"),
  afterSales: sla(3, "after_sales_request_verified"),
  logisticsScope: "all_included_regions",
});

test("each human SLA names its owner and production starts after locked-book approval", () => {
  const d06 = serviceDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d06 }).issues.filter((issue) =>
      issue.path.startsWith("d06."),
    ),
    [],
  );
  const input = {
    ...base(),
    d06: {
      ...d06,
      production: { ...d06.production, startsAt: "payment_verified" },
      completeExport: { ...d06.completeExport, ownerRef: null },
      afterSales: null,
    },
  };
  assert.ok(hasIssue(input, "d06.production.startsAt", "INVALID_VALUE"));
  assert.ok(
    hasIssue(input, "d06.completeExport.ownerRef", "REFERENCE_REQUIRED"),
  );
  assert.ok(hasIssue(input, "d06.afterSales.within.value", "INVALID_INTEGER"));
});

const refundRule = (amount: number, startsAt: string, remedy = "refund") => ({
  refundAmount: { value: amount, unit: "fen" },
  requestWindow: term(30, startsAt),
  processing: { within: days(7), startsAt: "verified_refund_request" },
  remedy,
  entitlementEffect: { creation: "terminate", firstCopy: "cancel" },
  productionAction: "check_and_stop_if_possible",
  policyRef: "record:refund-policy",
  ownerRef: "record:refund-owner",
});
const refundDecision = () => ({
  review: frozen,
  refundDeletesData: false,
  qualityReprintUsesOriginalOrder: true,
  notParticipated: refundRule(99900, "payment_verified"),
  usedNotProduced: refundRule(70000, "service_first_used"),
  inProduction: refundRule(20000, "production_accepted"),
  platformUnableDeliver: refundRule(99900, "failure_notified"),
  qualityDamaged: refundRule(99900, "delivered", "resend_or_refund"),
  qualityMissingPages: refundRule(99900, "delivered", "reprint_or_refund"),
  qualityWrongVersion: refundRule(99900, "delivered", "reprint_or_refund"),
  qualityLayoutError: refundRule(99900, "delivered", "reprint_or_refund"),
  postConfirmationFactualError: refundRule(
    0,
    "error_discovered",
    "correction_and_explain",
  ),
});

test("refund rules cover each production stage and quality problem with bounded money, windows and effects", () => {
  const d07 = refundDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d07 }).issues.filter((issue) =>
      issue.path.startsWith("d07."),
    ),
    [],
  );
  const input = {
    ...base(),
    d07: {
      ...d07,
      usedNotProduced: {
        ...d07.usedNotProduced,
        refundAmount: { value: 100000, unit: "fen" },
        entitlementEffect: "已完成",
      },
      inProduction: null,
      qualityWrongVersion: null,
      refundDeletesData: true,
    },
  };
  assert.ok(
    hasIssue(
      input,
      "d07.usedNotProduced.refundAmount.value",
      "INVALID_INTEGER",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d07.usedNotProduced.entitlementEffect.firstCopy",
      "INVALID_VALUE",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d07.inProduction.requestWindow.duration.value",
      "INVALID_INTEGER",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d07.qualityWrongVersion.processing.within.value",
      "INVALID_INTEGER",
    ),
  );
  assert.ok(hasIssue(input, "d07.refundDeletesData", "INVALID_VALUE"));
});

const scope = () => ({
  legalEntityRef: "record:synthetic-entity",
  appId: "wx0123456789abcdef",
  merchantId: "1900000109",
  categoryId: "record:synthetic-category",
  paymentPathId: "record:synthetic-payment-path",
  productType: "digital-production-plus-physical-book",
});
const platformEvidence = () => ({
  outcome: "approved",
  scope: scope(),
  evidenceRef: "record:synthetic-platform-result",
  requirementsRef: "record:synthetic-platform-requirements",
  reviewerRef: "record:platform-reviewer",
  checkedAt: "2026-10-22T08:00:00Z",
});
const platformDecision = () => ({
  review: frozen,
  identity: scope(),
  platform: {
    merchantBinding: platformEvidence(),
    productAdmission: platformEvidence(),
    iosPayment: {
      ...platformEvidence(),
      deviceTestRef: "record:ios-test",
      paymentAndQuery: "passed",
    },
    androidPayment: {
      ...platformEvidence(),
      deviceTestRef: "record:android-test",
      paymentAndQuery: "passed",
    },
    shippingManagement: {
      ...platformEvidence(),
      fulfillmentTestRef: "record:shipping-test",
      requirementHandling: "implemented_and_verified",
    },
  },
});

test("platform evidence covers both devices and shipping for the same actual app, entity, merchant and product path", () => {
  const d08 = platformDecision();
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d08 }).issues.filter(
      (issue) =>
        issue.path.startsWith("d08.platform") ||
        issue.path.startsWith("d08.identity."),
    ),
    [],
  );
  const input = {
    ...base(),
    d08: {
      ...d08,
      platform: {
        ...d08.platform,
        merchantBinding: {
          ...platformEvidence(),
          scope: { ...scope(), merchantId: "1900000110" },
        },
        iosPayment: {
          ...d08.platform.iosPayment,
          scope: { ...scope(), appId: "wx1111111111111111" },
        },
        androidPayment: { outcome: "approved" },
        shippingManagement: null,
      },
    },
  };
  assert.ok(
    hasIssue(
      input,
      "d08.platform.merchantBinding.scope.merchantId",
      "IDENTITY_MISMATCH",
    ),
  );
  assert.ok(
    hasIssue(input, "d08.platform.iosPayment.scope.appId", "IDENTITY_MISMATCH"),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.platform.androidPayment.evidenceRef",
      "REFERENCE_REQUIRED",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.platform.shippingManagement.fulfillmentTestRef",
      "REFERENCE_REQUIRED",
    ),
  );
});

const approvalRecord = () => ({
  outcome: "approved",
  evidenceRef: "record:synthetic-review-evidence",
  reviewerRef: "record:synthetic-reviewer",
  checkedAt: "2026-10-22T08:00:00Z",
});
const rightsRoute = () => ({
  channelRef: "record:subject-service-channel",
  identityVerificationRef: "record:subject-verification",
  scopeVerificationRef: "record:request-scope",
  confirmationChannelRef: "record:subject-confirmation",
  ownerRef: "record:rights-owner",
  responseWithin: days(3),
  applicant: "verified_subject",
});
const consentDecision = () => ({
  identityBinding: {
    ...approvalRecord(),
    procedureRef: "record:binding-procedure",
    subjectAndOperatorSeparate: true,
    subjectAppliesInitiatorConfirms: true,
    rejectInitiatorSelfBinding: true,
    paymentIsNotConsent: true,
  },
  assistedConsent: {
    ...approvalRecord(),
    subjectPresenceRequired: true,
    evidenceFormRef: "record:assisted-evidence-form",
    captureProcedureRef: "record:assisted-capture",
    bindsSubjectAndOperator: true,
    bindsPurposeAndNoticeVersion: true,
    bindsExactContentVersion: true,
    everyConfirmationRecorded: true,
    ownerRef: "record:consent-owner",
  },
  disputes: {
    channelRef: "record:dispute-intake",
    verificationProcedureRef: "record:dispute-verification",
    interimAction: "freeze_access_and_processing",
    resolutionWithin: days(7),
    ownerRef: "record:dispute-owner",
    decisionNoticeRef: "record:dispute-notice",
  },
  withoutWechat: {
    withdrawal: rightsRoute(),
    export: {
      ...rightsRoute(),
      deliveryChannelRef: "record:verified-subject-delivery",
      recipient: "verified_subject_or_explicitly_authorized_recipient",
      neverDefaultToInitiator: true,
    },
    deletion: rightsRoute(),
  },
  privacy: {
    ...approvalRecord(),
    noticeVersionRef: "record:privacy-notice-version",
    collectionAiSharingPrintSeparate: true,
    withdrawalStopsAccessAndProcessing: true,
    minimumProductionDataOnly: true,
  },
});

test("same-device evidence, dispute handling and no-WeChat withdrawal/export/deletion cannot be replaced by approval text", () => {
  const d08 = { ...platformDecision(), ...consentDecision() };
  assert.deepEqual(
    validateSalesAdmission({ ...base(), d08 }).issues.filter(
      (issue) =>
        issue.path.startsWith("d08.") &&
        !issue.path.startsWith("d08.suppliers"),
    ),
    [],
  );
  const input = {
    ...base(),
    d08: {
      ...d08,
      identityBinding: { ...d08.identityBinding, paymentIsNotConsent: false },
      assistedConsent: { outcome: "approved" },
      disputes: null,
      withoutWechat: {
        ...d08.withoutWechat,
        withdrawal: null,
        export: { ...d08.withoutWechat.export, neverDefaultToInitiator: false },
        deletion: { status: "已完成" },
      },
    },
  };
  assert.ok(
    hasIssue(input, "d08.identityBinding.paymentIsNotConsent", "INVALID_VALUE"),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.assistedConsent.evidenceFormRef",
      "REFERENCE_REQUIRED",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.assistedConsent.bindsExactContentVersion",
      "INVALID_VALUE",
    ),
  );
  assert.ok(hasIssue(input, "d08.disputes.ownerRef", "REFERENCE_REQUIRED"));
  assert.ok(
    hasIssue(
      input,
      "d08.withoutWechat.withdrawal.channelRef",
      "REFERENCE_REQUIRED",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.withoutWechat.export.neverDefaultToInitiator",
      "INVALID_VALUE",
    ),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.withoutWechat.deletion.identityVerificationRef",
      "REFERENCE_REQUIRED",
    ),
  );
});

const supplier = (purpose: string, dataKinds: string[]) => ({
  ...approvalRecord(),
  providerRef: "record:synthetic-provider",
  serviceConfigRef: "record:synthetic-service-version",
  termsRef: "record:synthetic-processing-terms",
  dataRegionRef: "record:synthetic-processing-region",
  ownerRef: "record:supplier-owner",
  purpose,
  dataKinds,
  retention: term(30, "processing_completed"),
  deletionWithin: days(30),
  deletionProcedureRef: "record:supplier-deletion",
  trainingUse: "prohibited",
  onwardSharing: "contracted_subprocessors_only",
});
const suppliers = () => ({
  asr: supplier("file_asr", ["original_audio"]),
  text: supplier("story_and_follow_up", ["transcripts"]),
  printing: supplier("print_and_ship", ["production_pdf", "shipping_address"]),
});

test("AI and printer admission require processing scopes and copy terms compatible with the customer promise", () => {
  const d08 = {
    ...platformDecision(),
    ...consentDecision(),
    suppliers: suppliers(),
  };
  assert.deepEqual(
    validateSalesAdmission({
      ...base(),
      d03: dataDecision(),
      d08,
    }).issues.filter((issue) => issue.path.startsWith("d08.suppliers.")),
    [],
  );
  const input = {
    ...base(),
    d03: dataDecision(),
    d08: {
      ...d08,
      suppliers: {
        ...d08.suppliers,
        asr: { outcome: "approved" },
        text: { ...d08.suppliers.text, deletionWithin: days(31) },
        printing: {
          ...d08.suppliers.printing,
          dataKinds: ["original_audio", "production_pdf", "shipping_address"],
          retention: term(31, "processing_completed"),
        },
      },
    },
  };
  assert.ok(
    hasIssue(input, "d08.suppliers.asr.serviceConfigRef", "REFERENCE_REQUIRED"),
  );
  assert.ok(
    hasIssue(input, "d08.suppliers.asr.termsRef", "REFERENCE_REQUIRED"),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.suppliers.text.deletionWithin.value",
      "COPY_TERM_MISMATCH",
    ),
  );
  assert.ok(
    hasIssue(input, "d08.suppliers.printing.dataKinds", "INVALID_DATA_SCOPE"),
  );
  assert.ok(
    hasIssue(
      input,
      "d08.suppliers.printing.retention.duration.value",
      "COPY_TERM_MISMATCH",
    ),
  );
});

// Entirely synthetic, in-memory test data. None of these terms or references is an approved offer.
const syntheticCompleteDecision = () => ({
  ...base(),
  d02: creationDecision(),
  d03: dataDecision(),
  d04: quotaDecision(),
  d05: shippingDecision(),
  d06: serviceDecision(),
  d07: refundDecision(),
  d08: { ...platformDecision(), ...consentDecision(), suppliers: suppliers() },
});

test("a structurally complete review is not sales authorization; unknown fields fail without echoing their data", () => {
  const input = syntheticCompleteDecision();
  assert.deepEqual(validateSalesAdmission(input), {
    completeness: "complete",
    salesAuthorized: false,
    evidenceAuthenticity: "not_verified",
    issues: [],
  });
  const result = checkFile({
    ...input,
    d02: { ...input.d02, private_sample_text: "NEVER_ECHO_PRIVATE_SAMPLE" },
  });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes("NEVER_ECHO_PRIVATE_SAMPLE"));
  assert.ok(!result.stdout.includes("private_sample_text"));
  assert.ok(
    JSON.parse(result.stdout).issues.some(
      (issue: { path: string; code: string }) =>
        issue.path === "d02" && issue.code === "UNEXPECTED_FIELD",
    ),
  );
});

test("frozen review dates must exist and identifiers are bounded opaque values, not guessed vendor lengths", () => {
  const input = syntheticCompleteDecision();
  input.d02.review = { ...frozen, decidedAt: "2026-02-30T08:00:00Z" };
  assert.ok(hasIssue(input, "d02.review.decidedAt", "INVALID_DATE"));
  const valid = syntheticCompleteDecision();
  valid.d08.identity.appId = "wx-externally-confirmed-identifier";
  valid.d08.identity.merchantId = "MCH-verified-2026";
  for (const entry of Object.values(valid.d08.platform))
    entry.scope = { ...valid.d08.identity };
  assert.equal(validateSalesAdmission(valid).completeness, "complete");
});

test("pending references, unapproved platform checks and synthetic-purpose files remain closed even with complete-looking fields", () => {
  const input = syntheticCompleteDecision();
  input.d02.review = { ...frozen, decisionRef: "record:pending" };
  input.d06.review = { ...frozen, state: "pending" };
  input.d08.platform.androidPayment.outcome = "pending";
  input.purpose = "synthetic_test_fixture";
  assert.ok(hasIssue(input, "d02.review.decisionRef", "REFERENCE_REQUIRED"));
  assert.ok(hasIssue(input, "d06.review.state", "NOT_FROZEN"));
  assert.ok(
    hasIssue(input, "d08.platform.androidPayment.outcome", "NOT_APPROVED"),
  );
  assert.ok(hasIssue(input, "purpose", "INVALID_VALUE"));
  assert.equal(validateSalesAdmission(input).salesAuthorized, false);
});

test("the shipped decision template stays pending and never contains synthetic commercial terms", () => {
  const input = JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../docs/delivery/2026-10-22/commerce-decisions.json",
      ),
      "utf8",
    ),
  );
  assert.equal(input.package.price.value, 99900);
  assert.equal(input.d02.service, "lifetime");
  assert.equal(input.d03.onlinePlayback.service, "lifetime");
  assert.equal(input.d04.userQuotas.recordingTotal.value, null);
  assert.equal(input.d07.notParticipated.refundAmount.value, null);
  assert.equal(input.d08.identity.appId, null);
  const result = checkFile(input);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completeness, "incomplete");
  assert.equal(report.salesAuthorized, false);
  assert.ok(
    report.issues.some(
      (issue: { path: string; code: string }) =>
        issue.path === "d02.review.state" && issue.code === "NOT_FROZEN",
    ),
  );
});

test("CLI usage and malformed input errors do not print files, keys, parse fragments or exception details", () => {
  const directory = mkdtempSync(join(tmpdir(), "timenook-admission-private-"));
  try {
    const path = join(directory, "NEVER_ECHO_PATH.json");
    writeFileSync(path, '{"private_story": "NEVER_ECHO_PARSE_FRAGMENT"');
    for (const args of [
      [],
      ["--file", path],
      ["--file", join(directory, "NEVER_ECHO_MISSING_FILE")],
      ["--file", path, "--publish"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [join(__dirname, "../src/commerce/admission-cli.js"), ...args],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 2);
      assert.equal(result.stderr, "");
      assert.ok(!result.stdout.includes("NEVER_ECHO"));
      assert.ok(!result.stdout.includes("private_story"));
      assert.equal(JSON.parse(result.stdout).issues[0].code, "INPUT_ERROR");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sparse shipping arrays cannot stand in for explicit supported or excluded regions", () => {
  for (const field of ["includedRegionCodes", "excludedRegionCodes"] as const) {
    const input = syntheticCompleteDecision();
    input.d05[field] = new Array<string>(1);
    const report = validateSalesAdmission(input);
    assert.equal(report.completeness, "incomplete");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.path === `d05.${field}` && issue.code === "INVALID_REGIONS",
      ),
    );
  }
});
