import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const projectId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const bundle = (
  await build({
    entryPoints: ["miniprogram/pages/print/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  })
).outputFiles[0].text;
function harness() {
  const clock = { now: Date.now() },
    storage = new Map<string, any>([
      ["timenook.mode.v1", "live"],
      [`timenook.session.v1:${base}`, structuredClone(login)],
    ]);
  const requests: any[] = [],
    routes: string[] = [],
    timers: { callback: () => void; delay: number }[] = [];
  let page: any;
  runInNewContext(bundle, {
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    Page(value: any) {
      page = value;
      page.setData = (patch: object) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(key, "timenook.frontend.v1", "live never reads demo");
        return structuredClone(storage.get(key));
      },
      setStorageSync: (key: string, value: any) =>
        storage.set(key, structuredClone(value)),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (r: any) => requests.push(r),
      navigateTo: ({ url }: any) => routes.push(url),
      reLaunch: ({ url }: any) => routes.push(url),
      showToast() {},
    },
  });
  return {
    page,
    storage,
    requests,
    routes,
    clock,
    timers,
    respond(index: number, data: any, statusCode = 200) {
      assert.ok(requests[index], "expected HTTP request");
      requests[index].success({
        statusCode,
        data:
          statusCode < 400
            ? { data, meta: { requestId: "synthetic" } }
            : {
                error: {
                  code:
                    statusCode === 409
                      ? "VERSION_CONFLICT"
                      : statusCode === 401
                        ? "UNAUTHENTICATED"
                        : "FORBIDDEN",
                },
                meta: { requestId: "synthetic" },
              },
      });
    },
  };
}
function context(): any {
  return {
    projectId,
    role: "initiator",
    book: {
      id: versionId,
      projectId,
      version: 3,
      state: "ready",
      snapshotHash: "b".repeat(64),
      pdf: { sha256: "f".repeat(64), bytes: 4567 },
      pageCount: 7,
      snapshot: { cover: { title: "小路与岁月" } },
    },
    address: { version: 0, hash: null, value: null },
    confirmations: { narrator: false, initiator: false },
    payment: {
      paidAmountFen: 99900,
      currency: "CNY",
      copies: 1,
      amountDueFen: 0,
    },
    shipping: {
      regionCodes: ["CN-SH"],
      terms: [{ label: "配送约定", text: "合成样本：审核后按约定配送" }],
    },
    creation: { state: "active", expiresAt: null },
    blockers: [
      "ADDRESS_REQUIRED",
      "NARRATOR_CONFIRMATION_REQUIRED",
      "INITIATOR_CONFIRMATION_REQUIRED",
    ],
    canSubmit: false,
    canReviseProduction: false,
    production: null,
    accessExpiresAt: null,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("live first-copy page reads paid entitlement and shipping snapshot without touching demo and pins its review link", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  assert.equal(h.requests[0].url, `${base}/projects/${projectId}/first-copy`);
  h.respond(0, context());
  await show;
  assert.equal(h.page.data.live, true);
  assert.equal(h.page.data.context.payment.paidAmountFen, 99900);
  assert.equal(
    h.page.data.context.shipping.terms[0].text,
    "合成样本：审核后按约定配送",
  );
  assert.equal(h.page.data.canSubmit, false);
  h.page.review();
  assert.equal(
    h.routes[0],
    `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
  );
  h.page.onUnload();
});

test("saving a delivery address pins the observed address version and clears only the initiator confirmation", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  const initial = context();
  initial.confirmations = { narrator: true, initiator: true };
  h.respond(0, initial);
  await show;
  for (const [field, value] of Object.entries({
    name: "合成收件人",
    phone: "13800000000",
    detail: "上海市合成路1号",
  }))
    h.page.input({ currentTarget: { dataset: { field } }, detail: { value } });
  h.page.chooseRegion({ detail: { value: "0" } });
  assert.equal(h.page.data.addressDirty, true);
  assert.equal(h.page.data.canSubmit, false);
  const save = h.page.saveAddress();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/first-copy/address`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].data)), {
    expectedVersion: 0,
    recipientName: "合成收件人",
    phone: "13800000000",
    regionCode: "CN-SH",
    detail: "上海市合成路1号",
  });
  const saved = context();
  saved.address = {
    version: 1,
    hash: "c".repeat(64),
    value: {
      recipientName: "合成收件人",
      phone: "13800000000",
      regionCode: "CN-SH",
      detail: "上海市合成路1号",
    },
  };
  saved.confirmations.narrator = true;
  h.respond(1, saved);
  await save;
  assert.equal(h.page.data.context.confirmations.narrator, true);
  assert.equal(h.page.data.context.confirmations.initiator, false);
  assert.equal(h.page.data.addressDirty, false);
  h.page.onUnload();
});

test("narrator confirmation binds the actual book, snapshot and PDF after an independent current choice", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    initial = context();
  initial.role = "narrator";
  initial.canConfirmNarrator = true;
  h.respond(0, initial);
  await show;
  await h.page.confirmNarrator();
  assert.equal(h.requests.length, 1);
  h.page.chooseConfirmation({
    currentTarget: { dataset: { role: "narrator" } },
  });
  h.page.evidenceInput({
    currentTarget: { dataset: { role: "narrator" } },
    detail: { value: "我已逐页核对这一版内容" },
  });
  const confirm = h.page.confirmNarrator();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].data)), {
    role: "narrator",
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    noticeVersion: "synthetic-d08-v1",
    evidenceRef: "synthetic:我已逐页核对这一版内容",
  });
  const saved = structuredClone(initial);
  saved.confirmations.narrator = true;
  h.respond(1, saved);
  await confirm;
  assert.equal(h.page.data.context.confirmations.narrator, true);
  assert.equal(h.page.data.narratorChecked, false);
  assert.equal(h.page.data.narratorEvidence, "");
  h.page.onUnload();
});

test("first-copy submission binds both hashes and address and retries an uncertain result with the same key", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    initial = context();
  initial.confirmations = { narrator: true, initiator: true };
  initial.address.hash = "c".repeat(64);
  initial.canSubmit = true;
  initial.blockers = [];
  h.respond(0, initial);
  await show;
  const submit = h.page.submit();
  assert.equal(
    h.requests[1].url,
    `${base}/projects/${projectId}/first-copy/submit`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].data)), {
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
  });
  const key = h.requests[1].header["Idempotency-Key"];
  h.requests[1].fail({ errMsg: "network unavailable" });
  await submit;
  assert.equal(h.page.data.busy, false);
  const retry = h.page.submit();
  assert.equal(h.requests[2].header["Idempotency-Key"], key);
  const saved = structuredClone(initial);
  saved.canSubmit = false;
  saved.production = {
    id: "55555555-5555-4555-8555-555555555555",
    state: "reserved",
    ...h.requests[2].data,
    copies: 1,
    amountDueFen: 0,
  };
  saved.blockers = ["ALREADY_SUBMITTED"];
  h.respond(2, saved);
  await retry;
  assert.equal(h.page.data.context.production.id, saved.production.id);
  assert.equal(h.page.data.canSubmit, false);
  assert.match(h.page.data.status, /已预留/);
  h.page.onUnload();
});

test("a confirmation finishing at exact content expiry clears private book and address before its timer runs", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    initial = context();
  initial.role = "narrator";
  initial.canConfirmNarrator = true;
  initial.accessExpiresAt = new Date(h.clock.now + 500).toISOString();
  h.respond(0, initial);
  await show;
  h.page.chooseConfirmation({
    currentTarget: { dataset: { role: "narrator" } },
  });
  h.page.evidenceInput({
    currentTarget: { dataset: { role: "narrator" } },
    detail: { value: "本人已核对本版内容" },
  });
  const confirm = h.page.confirmNarrator();
  h.clock.now += 500;
  h.respond(1, initial);
  await confirm;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.name, "");
  assert.equal(h.page.data.narratorEvidence, "");
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

test("editing an already confirmed address clears the new initiator choice and prevents submitting until it is saved and confirmed", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    initial = context();
  initial.confirmations = { narrator: true, initiator: true };
  initial.address.hash = "c".repeat(64);
  initial.canSubmit = true;
  initial.blockers = [];
  h.respond(0, initial);
  await show;
  h.page.chooseConfirmation({
    currentTarget: { dataset: { role: "initiator" } },
  });
  h.page.evidenceInput({
    currentTarget: { dataset: { role: "initiator" } },
    detail: { value: "我已核对原地址" },
  });
  h.page.input({
    currentTarget: { dataset: { field: "detail" } },
    detail: { value: "上海市另一个合成地址" },
  });
  assert.equal(h.page.data.initiatorChecked, false);
  assert.equal(h.page.data.initiatorEvidence, "");
  await h.page.confirmInitiator();
  await h.page.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.page.data.context.confirmations.narrator, true);
  h.page.onUnload();
});

test("switching accounts before a submit clears the former book and address before sending any command", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    initial = context();
  initial.confirmations = { narrator: true, initiator: true };
  initial.address.hash = "c".repeat(64);
  initial.canSubmit = true;
  initial.blockers = [];
  h.respond(0, initial);
  await show;
  h.storage.set(`timenook.session.v1:${base}`, {
    ...login,
    user: { id: "77777777-7777-4777-8777-777777777777" },
  });
  const submit = h.page.submit();
  assert.equal(h.requests.length, 1);
  await submit;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.name, "");
  h.page.onUnload();
});

test("old-version and over-specification contexts cannot submit a first copy", async () => {
  for (const blocker of ["BOOK_NOT_READY", "SPECIFICATION_MISMATCH"]) {
    const h = harness();
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow(),
      initial = context();
    initial.blockers = [blocker];
    initial.confirmations = { narrator: true, initiator: true };
    initial.address.hash = "c".repeat(64);
    if (blocker === "BOOK_NOT_READY")
      initial.book.id = "77777777-7777-4777-8777-777777777777";
    h.respond(0, initial);
    await show;
    await h.page.submit();
    assert.equal(h.requests.length, 1);
    assert.equal(h.page.data.canSubmit, false);
    h.page.onUnload();
  }
});

test("authorization denial clears all private confirmation data, and departure fences a late context", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, context());
  await show;
  h.page.input({
    currentTarget: { dataset: { field: "name" } },
    detail: { value: "合成私有姓名" },
  });
  const refresh = h.page.refresh();
  h.respond(1, null, 403);
  await refresh;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.name, "");
  assert.equal(h.page.data.canSubmit, false);
  const next = h.page.onShow();
  h.page.onHide();
  h.respond(2, context());
  await next;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

test("a ready first-copy response with a missing PDF hash cannot enable confirmation or submission", async () => {
  const h = harness();
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow(),
    invalid = context();
  invalid.book.pdf.sha256 = null;
  invalid.canSubmit = true;
  h.respond(0, invalid);
  await show;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.canSubmit, false);
  h.page.onUnload();
});

test("a definitively cancelled attempt allows address correction, fresh initiator confirmation and same-order resubmission", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    initial = context();
  initial.canReviseProduction = true;
  initial.canSubmit = true;
  initial.address = {
    version: 1,
    hash: "c".repeat(64),
    value: {
      recipientName: "合成收件人",
      phone: "13800000000",
      regionCode: "CN-SH",
      detail: "原合成地址",
    },
  };
  initial.confirmations = { narrator: true, initiator: true };
  initial.blockers = [];
  initial.production = {
    id: "55555555-5555-4555-8555-555555555555",
    state: "approved",
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
    copies: 1,
    amountDueFen: 0,
  };
  h.respond(0, initial);
  await loading;
  h.page.input({
    currentTarget: { dataset: { field: "detail" } },
    detail: { value: "更正后的合成地址" },
  });
  const saving = h.page.saveAddress();
  assert.ok(
    h.requests[1],
    "definitively cancelled production can save a corrected address",
  );
  assert.equal(h.requests[1].data.expectedVersion, 1);
  const corrected = structuredClone(initial);
  corrected.canSubmit = false;
  corrected.address = {
    ...initial.address,
    version: 2,
    hash: "d".repeat(64),
    value: { ...initial.address.value, detail: "更正后的合成地址" },
  };
  corrected.confirmations.initiator = false;
  corrected.blockers = ["INITIATOR_CONFIRMATION_REQUIRED"];
  h.respond(1, corrected);
  await saving;
  assert.equal(h.page.data.context.confirmations.narrator, true);
  assert.equal(h.page.data.context.confirmations.initiator, false);
  await h.page.submit();
  assert.equal(h.requests.length, 2);
  h.page.chooseConfirmation({
    currentTarget: { dataset: { role: "initiator" } },
  });
  h.page.evidenceInput({
    currentTarget: { dataset: { role: "initiator" } },
    detail: { value: "本人重新核对当前书稿与更正地址" },
  });
  const confirming = h.page.confirmInitiator();
  assert.equal(h.requests[2].data.addressHash, "d".repeat(64));
  const confirmed = structuredClone(corrected);
  confirmed.confirmations.initiator = true;
  confirmed.canSubmit = true;
  confirmed.blockers = [];
  h.respond(2, confirmed);
  await confirming;
  const submitting = h.page.submit();
  assert.equal(h.requests[3].data.addressHash, "d".repeat(64));
  const resubmitted = structuredClone(confirmed);
  resubmitted.canReviseProduction = false;
  resubmitted.canSubmit = false;
  resubmitted.production.addressHash = "d".repeat(64);
  resubmitted.production.state = "reserved";
  resubmitted.blockers = ["ALREADY_SUBMITTED"];
  h.respond(3, resubmitted);
  await submitting;
  assert.equal(h.page.data.context.production.id, initial.production.id);
  assert.equal(h.page.data.context.canReviseProduction, false);
  assert.equal(h.page.data.canSubmit, false);
  h.page.onUnload();
});

test("a revised PDF after definitive cancellation needs the current narrator confirmation and leaves initiator confirmation pending", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    revised = context();
  revised.role = "narrator";
  revised.canConfirmNarrator = true;
  revised.canReviseProduction = true;
  revised.book.id = "77777777-7777-4777-8777-777777777777";
  revised.book.snapshotHash = "d".repeat(64);
  revised.book.pdf.sha256 = "e".repeat(64);
  revised.production = {
    id: "55555555-5555-4555-8555-555555555555",
    state: "approved",
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
    copies: 1,
    amountDueFen: 0,
  };
  h.respond(0, revised);
  await loading;
  h.page.chooseConfirmation({
    currentTarget: { dataset: { role: "narrator" } },
  });
  h.page.evidenceInput({
    currentTarget: { dataset: { role: "narrator" } },
    detail: { value: "本人重新逐页核对更正后的完整书稿" },
  });
  const confirming = h.page.confirmNarrator();
  assert.equal(h.requests[1].data.bookVersionId, revised.book.id);
  assert.equal(h.requests[1].data.snapshotHash, "d".repeat(64));
  assert.equal(h.requests[1].data.pdfHash, "e".repeat(64));
  const confirmed = structuredClone(revised);
  confirmed.confirmations.narrator = true;
  h.respond(1, confirmed);
  await confirming;
  assert.equal(h.page.data.context.confirmations.initiator, false);
  assert.equal(h.page.data.canSubmit, false);
  h.page.onUnload();
});

test("existing production without the definitive revision capability cannot save, reconfirm or resubmit", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const loading = h.page.onShow(),
    locked = context();
  locked.canReviseProduction = false;
  locked.canSubmit = true;
  locked.address.hash = "c".repeat(64);
  locked.production = {
    id: "55555555-5555-4555-8555-555555555555",
    state: "approved",
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
    copies: 1,
    amountDueFen: 0,
  };
  h.respond(0, locked);
  await loading;
  h.page.input({
    currentTarget: { dataset: { field: "detail" } },
    detail: { value: "不允许的地址更正" },
  });
  await h.page.saveAddress();
  await h.page.confirmInitiator();
  await h.page.submit();
  assert.equal(h.requests.length, 1);
  h.page.onUnload();
});
