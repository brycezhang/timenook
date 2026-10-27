import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const id = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
async function harness() {
  const bundle = await build({
    entryPoints: ["miniprogram/pages/quality/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  });
  const storage = new Map<string, unknown>([
    ["timenook.mode.v1", "live"],
    [
      `timenook.session.v1:${base}`,
      {
        user: { id },
        session: {
          id,
          token: "a".repeat(43),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    ],
  ]);
  const calls: any[] = [],
    routes: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0,
    page: any;
  const clock = { now: Date.now() };
  runInNewContext(bundle.outputFiles[0].text, {
    Page(p: any) {
      page = p;
      page.setData = (x: object) => Object.assign(page.data, x);
    },
    wx: {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      request: (call: unknown) => {
        calls.push(call);
        return { abort() {} };
      },
      navigateTo: ({ url }: { url: string }) => routes.push(url),
      reLaunch() {},
      showToast() {},
    },
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout(fn: () => void) {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout(key: number) {
      timers.delete(key);
    },
  });
  return { page, calls, storage, routes, clock, timers };
}
function success(call: any, data: unknown, statusCode = 200) {
  assert.ok(call, "expected authenticated request");
  call.success({
    statusCode,
    data: { data, meta: { requestId: "synthetic" } },
  });
}
const tick = () => new Promise((r) => setImmediate(r));
function original() {
  return {
    attemptId,
    sequence: 1,
    bookVersion: 1,
    deliveredAt: "2026-10-20T12:00:00Z",
    bookVersionId: id,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
    tracking: null,
  };
}
function initial() {
  return {
    orderId: id,
    attempts: [{ ...original(), id: attemptId }],
    requests: [],
  };
}
function row() {
  return {
    id: requestId,
    caseId: requestId,
    orderId: id,
    productionOrderId: id,
    projectId,
    version: 1,
    reason: "qualityDamaged",
    state: "requested",
    original: original(),
    createdAt: "2026-10-21T12:00:00Z",
    ownerLabel: null,
    dueAt: null,
    assignedAt: null,
    reviewedAt: null,
    resolution: null,
    reprintMode: null,
    grant: null,
    productionAttemptId: null,
    productionState: null,
    refund: null,
  };
}
test("quality page uses delivered attempts and retains one uncertain request intent", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  assert.equal(h.calls[0]?.url, `${base}/orders/${id}/quality-care`);
  success(h.calls[0], initial());
  await shown;
  assert.equal(h.page.data.attempts[0].id, attemptId);
  h.page.setData({ description: "合成：纸页破损，希望客服核验" });
  const first = h.page.apply();
  await tick();
  assert.equal(h.calls[1].data.attemptId, attemptId);
  assert.equal(h.calls[1].data.description, "合成：纸页破损，希望客服核验");
  h.calls[1].fail({ errMsg: "timeout" });
  await first;
  const retry = h.page.apply();
  await tick();
  assert.equal(
    h.calls[2].header["Idempotency-Key"],
    h.calls[1].header["Idempotency-Key"],
  );
  success(h.calls[2], row(), 201);
  await retry;
  assert.equal(h.page.data.rows[0].stateLabel, "待客服核验");
  assert.equal(h.page.data.description, "");
  h.page.onUnload();
});
test("a second quality request selects its own case and requires fresh case-specific access choices", async () => {
  const h = await harness();
  const nextId = "77777777-7777-4777-8777-777777777777";
  h.page.onLoad({
    orderId: id,
    projectId,
    requestId,
    assistedSessionId: attemptId,
  });
  const assigned = {
    ...row(),
    version: 2,
    state: "assigned",
    ownerLabel: "客服一",
  };
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], { ...initial(), requests: [assigned] });
  await shown;
  const preparing = h.page.prepareAccess();
  await tick();
  const permission = {
    projectId,
    subjectId: id,
    role: "initiator",
    bindingVersion: 1,
    accessEpoch: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  };
  success(h.calls[1], permission);
  await preparing;
  h.page.chooseGrant();
  h.page.chooseScope({ currentTarget: { dataset: { scope: "pdf" } } });
  const granting = h.page.grant();
  await tick();
  assert.equal(h.calls[2].data.assistedSessionId, attemptId);
  h.calls[2].fail({ errMsg: "timeout" });
  await granting;

  h.page.descriptionInput({ detail: { value: "合成第二次质量申请" } });
  const applying = h.page.apply();
  await tick();
  const requested = { ...row(), id: nextId, caseId: nextId };
  success(h.calls[3], requested, 201);
  await applying;
  assert.equal(h.page.data.selectedId, nextId);
  assert.equal(h.page.data.selected.id, nextId);
  assert.equal(h.page.data.selected.ownerLabel, null);
  for (const choice of [
    "accessChoice",
    "canGrant",
    "canAssist",
    "grantChecked",
    "pdfScope",
    "evidenceScope",
  ])
    assert.equal(
      h.page.data[choice],
      false,
      `${choice} belongs to the old case`,
    );
  await h.page.prepareAccess();
  await h.page.grant();
  assert.equal(
    h.calls.length,
    4,
    "new unassigned case cannot grant to the old owner",
  );

  const nextAssigned = {
    ...requested,
    version: 2,
    state: "assigned",
    ownerLabel: "客服二",
  };
  const refreshing = h.page.refresh();
  await tick();
  success(h.calls[4], { ...initial(), requests: [nextAssigned, assigned] });
  await refreshing;
  const nextChoice = h.page.prepareAccess();
  await tick();
  success(h.calls[5], permission);
  await nextChoice;
  assert.equal(
    h.page.data.canGrant,
    false,
    "another case needs a fresh assisted session",
  );
  assert.equal(h.page.data.canAssist, true);
  h.page.assist();
  assert.match(h.routes[0], new RegExp(`requestId=${nextId}$`));
  h.page.chooseRequest({ currentTarget: { dataset: { id: requestId } } });
  const oldChoice = h.page.prepareAccess();
  await tick();
  success(h.calls[6], { ...permission, role: "narrator" });
  await oldChoice;
  await h.page.grant();
  assert.equal(
    h.calls.length,
    7,
    "returning to the old case cannot reuse unchecked scopes",
  );
  h.page.chooseGrant();
  h.page.chooseScope({ currentTarget: { dataset: { scope: "pdf" } } });
  const fresh = h.page.grant();
  await tick();
  assert.equal(
    h.calls[7].url,
    `${base}/orders/${id}/quality-care/${requestId}/access`,
  );
  assert.notEqual(
    h.calls[7].header["Idempotency-Key"],
    h.calls[2].header["Idempotency-Key"],
  );
  assert.equal(h.calls[7].data.assistedSessionId, undefined);
  success(h.calls[7], assigned, 201);
  await fresh;
  h.page.onUnload();
});
test("only the narrator or an explicit assisted session grants selected scopes, with a stable retry expiry", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  const assigned = {
    ...row(),
    version: 2,
    state: "assigned",
    ownerLabel: "客服一",
    assignedAt: "2026-10-21T12:01:00Z",
  };
  success(h.calls[0], { ...initial(), requests: [assigned] });
  await shown;
  const preparing = h.page.prepareAccess();
  await tick();
  assert.equal(h.calls[1]?.url, `${base}/projects/${projectId}/participation`);
  success(h.calls[1], {
    projectId,
    subjectId: id,
    role: "narrator",
    bindingVersion: 1,
    accessEpoch: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  });
  await preparing;
  await h.page.grant();
  assert.equal(h.calls.length, 2, "a fresh affirmative choice is required");
  h.page.chooseGrant();
  h.page.chooseScope({ currentTarget: { dataset: { scope: "pdf" } } });
  const first = h.page.grant();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].data.scopes)), ["pdf"]);
  assert.equal(h.calls[2].data.expectedVersion, 2);
  assert.equal(
    h.calls[2].data.expiresAt,
    new Date(h.clock.now + 600000).toISOString(),
  );
  const firstExpiry = h.calls[2].data.expiresAt;
  h.calls[2].fail({ errMsg: "timeout" });
  await first;
  h.clock.now += 1000;
  const retry = h.page.grant();
  await tick();
  assert.equal(
    h.calls[3].header["Idempotency-Key"],
    h.calls[2].header["Idempotency-Key"],
  );
  assert.equal(h.calls[3].data.expiresAt, firstExpiry);
  success(
    h.calls[3],
    {
      ...assigned,
      version: 3,
      grant: { scopes: ["pdf"], expiresAt: firstExpiry },
    },
    201,
  );
  await retry;
  assert.equal(h.page.data.grantChecked, false);
  assert.match(h.page.data.status, /限时授权已记录/);
  h.page.onUnload();
});
test("a late poll cannot restore a previous case after a new application, and refund retries remain within the current selection", async () => {
  const h = await harness(),
    nextId = "77777777-7777-4777-8777-777777777777",
    reviewed = {
      ...row(),
      version: 4,
      state: "reviewed",
      resolution: "refund",
    },
    value = { ...initial(), requests: [reviewed] },
    permission = {
      projectId,
      subjectId: id,
      role: "initiator",
      bindingVersion: 1,
      accessEpoch: 0,
      choices: ["collection", "ai", "sharing"].map((purpose) => ({
        purpose,
        granted: true,
      })),
      canRead: true,
    };
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], value);
  await shown;
  const first = h.page.requestRefund();
  await tick();
  success(h.calls[1], permission);
  await tick();
  h.calls[2].fail({ errMsg: "timeout" });
  await first;
  const retry = h.page.requestRefund();
  await tick();
  success(h.calls[3], permission);
  await tick();
  assert.equal(
    h.calls[4].header["Idempotency-Key"],
    h.calls[2].header["Idempotency-Key"],
  );
  h.calls[4].fail({ errMsg: "timeout" });
  await retry;
  const polling = [...h.timers.values()].pop()!();
  await tick();
  h.page.descriptionInput({ detail: { value: "合成第二次质量申请" } });
  const applying = h.page.apply();
  await tick();
  success(h.calls[6], { ...row(), id: nextId, caseId: nextId }, 201);
  await applying;
  success(h.calls[5], value);
  await polling;
  assert.equal(h.page.data.selectedId, nextId);
  assert.equal(h.page.data.selected.id, nextId);
  await h.page.requestRefund();
  assert.equal(
    h.calls.length,
    7,
    "an old refund remedy cannot be used from the new selection",
  );
  h.page.chooseRequest({ currentTarget: { dataset: { id: requestId } } });
  const fresh = h.page.requestRefund();
  await tick();
  success(h.calls[7], permission);
  await tick();
  assert.equal(
    h.calls[8].url,
    `${base}/orders/${id}/quality-care/${requestId}/refund`,
  );
  assert.notEqual(
    h.calls[8].header["Idempotency-Key"],
    h.calls[2].header["Idempotency-Key"],
  );
  success(
    h.calls[8],
    {
      ...reviewed,
      state: "refund_requested",
      refund: { id, state: "requested" },
    },
    201,
  );
  await fresh;
  assert.equal(h.routes[0], `/pages/refunds/index?orderId=${id}`);
  h.page.onUnload();
});
test("quality page clears private drafts when account ownership changes and ignores late departure results", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], initial());
  await shown;
  h.page.setData({ description: "未发送的私人问题", grantChecked: true });
  const stored: any = h.storage.get(`timenook.session.v1:${base}`);
  h.storage.set(`timenook.session.v1:${base}`, {
    ...stored,
    user: { id: projectId },
  });
  const timer = [...h.timers.values()].pop()!;
  await timer();
  assert.equal(h.page.data.view, null);
  assert.equal(h.page.data.description, "");
  assert.equal(h.page.data.grantChecked, false);
  const another = await harness();
  another.page.onLoad({ orderId: id, projectId });
  const pending = another.page.onShow();
  await tick();
  another.page.onHide();
  success(another.calls[0], initial());
  await pending;
  assert.equal(another.page.data.view, null);
  assert.equal(another.page.data.rows.length, 0);
  another.page.onUnload();
});
test("an account change during an explicit refresh clears the old visible data", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], initial());
  await shown;
  h.page.setData({ description: "原账号私人草稿" });
  const pending = h.page.refresh();
  await tick();
  const stored: any = h.storage.get(`timenook.session.v1:${base}`);
  h.storage.set(`timenook.session.v1:${base}`, {
    ...stored,
    user: { id: projectId },
  });
  success(h.calls[1], initial());
  await pending;
  assert.equal(h.page.data.view, null);
  assert.equal(h.page.data.description, "");
  h.page.onUnload();
});
test("a reviewed revision returns to the actual book and both-party confirmation flows", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], {
    ...initial(),
    requests: [
      {
        ...row(),
        state: "reviewed",
        resolution: "reprint",
        reprintMode: "revised",
      },
    ],
  });
  await shown;
  h.page.revise();
  h.page.confirmRevision();
  h.page.production();
  assert.deepEqual(h.routes, [
    `/pages/book/index?projectId=${projectId}`,
    `/pages/print/index?projectId=${projectId}`,
    `/pages/production/index?projectId=${projectId}`,
  ]);
  h.page.onUnload();
});
test("the buyer continues a quality remedy through the existing refund use case", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  const reviewed = {
    ...row(),
    state: "reviewed",
    resolution: "refund",
    version: 4,
  };
  success(h.calls[0], { ...initial(), requests: [reviewed] });
  await shown;
  const requesting = h.page.requestRefund();
  await tick();
  success(h.calls[1], {
    projectId,
    subjectId: id,
    role: "initiator",
    bindingVersion: 1,
    accessEpoch: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  });
  await tick();
  assert.equal(
    h.calls[2]?.url,
    `${base}/orders/${id}/quality-care/${requestId}/refund`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[2].data)), {
    expectedVersion: 4,
  });
  success(
    h.calls[2],
    {
      ...reviewed,
      version: 5,
      state: "refund_requested",
      refund: { id, state: "requested" },
    },
    201,
  );
  await requesting;
  assert.equal(h.routes[0], `/pages/refunds/index?orderId=${id}`);
  assert.equal(h.page.data.selected.refund.state, "requested");
  h.page.onUnload();
});
test("remote withdrawal clears a private draft and unsubmitted scope choices while retaining minimal case progress", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  const value = { ...initial(), requests: [row()] };
  success(h.calls[0], value);
  await shown;
  const firstWatch = [...h.timers.values()].pop()!();
  await tick();
  success(h.calls[1], value);
  await tick();
  success(h.calls[2], {
    projectId,
    subjectId: id,
    role: "initiator",
    bindingVersion: 1,
    accessEpoch: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: true,
    })),
    canRead: true,
  });
  await firstWatch;
  h.page.setData({
    description: "尚未发送的私人说明",
    accessChoice: true,
    grantChecked: true,
    pdfScope: true,
  });
  const watching = [...h.timers.values()].pop()!();
  await tick();
  success(h.calls[3], value);
  await tick();
  assert.equal(h.calls[4]?.url, `${base}/projects/${projectId}/participation`);
  success(h.calls[4], {
    projectId,
    subjectId: id,
    role: "initiator",
    bindingVersion: 1,
    accessEpoch: 0,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: false,
    })),
    canRead: false,
  });
  await watching;
  assert.equal(h.page.data.description, "");
  assert.equal(h.page.data.accessChoice, false);
  assert.equal(h.page.data.grantChecked, false);
  assert.equal(h.page.data.rows[0].id, requestId);
  h.page.onUnload();
});
test("a current buyer with content access already withdrawn can write and retry a new commercial quality request across repeated polls", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId });
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], initial());
  await shown;
  const permission = {
    projectId,
    subjectId: id,
    role: "initiator",
    bindingVersion: 1,
    accessEpoch: 1,
    choices: ["collection", "ai", "sharing"].map((purpose) => ({
      purpose,
      granted: false,
    })),
    canRead: false,
  };
  async function poll() {
    const start = h.calls.length,
      watching = [...h.timers.values()].pop()!();
    await tick();
    success(h.calls[start], initial());
    await tick();
    success(h.calls[start + 1], permission);
    await watching;
  }
  await poll();
  h.page.setData({ description: "新填写的合成书页破损申请" });
  const first = h.page.apply();
  await tick();
  const request = h.calls[h.calls.length - 1];
  request.fail({ errMsg: "timeout" });
  await first;
  await poll();
  assert.equal(h.page.data.description, "新填写的合成书页破损申请");
  const retry = h.page.apply();
  await tick();
  const repeated = h.calls[h.calls.length - 1];
  assert.equal(
    repeated.header["Idempotency-Key"],
    request.header["Idempotency-Key"],
  );
  success(repeated, row(), 201);
  await retry;
  assert.equal(h.page.data.rows[0].id, requestId);
  h.page.onUnload();
});
test("buyer content sharing is independent of a fresh explicit assisted quality grant", async () => {
  const h = await harness();
  h.page.onLoad({ orderId: id, projectId, assistedSessionId: attemptId });
  const assigned = {
    ...row(),
    version: 2,
    state: "assigned",
    ownerLabel: "客服一",
  };
  const value = { ...initial(), requests: [assigned] },
    permission = {
      projectId,
      subjectId: id,
      role: "initiator",
      bindingVersion: 1,
      accessEpoch: 1,
      choices: [
        { purpose: "collection", granted: true },
        { purpose: "ai", granted: false },
        { purpose: "sharing", granted: false },
      ],
      canRead: false,
    };
  const shown = h.page.onShow();
  await tick();
  success(h.calls[0], value);
  await shown;
  const preparing = h.page.prepareAccess();
  await tick();
  success(h.calls[1], permission);
  await preparing;
  assert.equal(h.page.data.canGrant, true);
  h.page.chooseGrant();
  h.page.chooseScope({ currentTarget: { dataset: { scope: "pdf" } } });
  const watching = [...h.timers.values()].pop()!();
  await tick();
  success(h.calls[2], value);
  await tick();
  success(h.calls[3], permission);
  await watching;
  assert.equal(h.page.data.canGrant, true);
  const granting = h.page.grant();
  await tick();
  assert.equal(h.calls[4]?.data.assistedSessionId, attemptId);
  success(h.calls[4], {
    ...assigned,
    grant: { scopes: ["pdf"], expiresAt: h.calls[4].data.expiresAt },
  });
  await granting;
  h.page.onUnload();
  const buyer = await harness();
  buyer.page.onLoad({ orderId: id, projectId });
  const loaded = buyer.page.onShow();
  await tick();
  success(buyer.calls[0], value);
  await loaded;
  const choice = buyer.page.prepareAccess();
  await tick();
  success(buyer.calls[1], permission);
  await choice;
  assert.equal(buyer.page.data.canGrant, false);
  assert.equal(buyer.page.data.canAssist, true);
  buyer.page.onUnload();
});
