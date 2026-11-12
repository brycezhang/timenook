import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harness,
  projectId,
  version,
  versionId,
  tick,
} from "./helpers/senior-page";

function firstCopy(address = true): any {
  return {
    projectId,
    role: "initiator",
    book: version(),
    address: {
      version: address ? 1 : 0,
      hash: address ? "c".repeat(64) : null,
      value: address
        ? {
            recipientName: "测试收件人",
            phone: "13800000000",
            regionCode: "CN-110000",
            detail: "朝阳区测试街道 12 号",
          }
        : null,
    },
    confirmations: { narrator: false, initiator: false },
    payment: {
      paidAmountFen: 99900,
      currency: "CNY",
      copies: 1,
      amountDueFen: 0,
    },
    shipping: {
      regionCodes: ["CN-110000"],
      regionLabels: { "CN-110000": "北京市" },
      terms: [],
    },
    creation: { state: "active", expiresAt: null },
    blockers: address ? [] : ["ADDRESS_REQUIRED"],
    canSubmit: address,
    canReviseProduction: false,
    production: null,
    accessExpiresAt: null,
  };
}
function fulfillment(state: string | null = null): any {
  const binding = {
    bookVersionId: versionId,
    snapshotHash: "b".repeat(64),
    pdfHash: "f".repeat(64),
    addressHash: "c".repeat(64),
  };
  const current = state
    ? {
        ...binding,
        id: "88888888-8888-4888-8888-888888888888",
        state,
        handoffId: "synthetic",
        printedAt: null,
        printedBy: null,
        deliveredAt: state === "delivered" ? "2026-11-11T12:00:00Z" : null,
        grantExpiresAt: null,
        tracking:
          state === "shipped"
            ? {
                carrier: "合成配送",
                number: "SYNTHETIC123",
                shippedAt: "2026-11-11T12:00:00Z",
              }
            : null,
      }
    : null;
  return {
    projectId,
    orderId: "99999999-9999-4999-8999-999999999999",
    reservation: binding,
    deliveryAddress: { ...firstCopy().address.value, regionLabel: "北京市" },
    attempts: current ? [current] : [],
    current,
    canGrant: false,
    canGrantNarrator: false,
    grantMaxMinutes: 30,
    noticeVersion: "synthetic-d08-v1",
    evidencePrefix: "synthetic:",
    creation: { state: "active", expiresAt: null },
    accessExpiresAt: null,
  };
}

test("ready PDF without address enters address then continues to print confirmation", async () => {
  const p = harness("print");
  p.page.onLoad({ projectId });
  const load = p.page.refresh();
  p.respond(0, firstCopy(false));
  await load;
  assert.equal(p.routes[0], `/pages/address/index?projectId=${projectId}`);

  const a = harness("address");
  a.page.onLoad({ projectId });
  const show = a.page.onShow();
  a.respond(0, firstCopy(false));
  await show;
  a.page.input({
    currentTarget: { dataset: { field: "name" } },
    detail: { value: "测试收件人" },
  });
  a.page.input({
    currentTarget: { dataset: { field: "phone" } },
    detail: { value: "13800000000" },
  });
  a.page.input({
    currentTarget: { dataset: { field: "detail" } },
    detail: { value: "朝阳区测试街道 12 号" },
  });
  a.page.region({ detail: { value: 0 } });
  const save = a.page.save();
  assert.equal(a.requests[1].data.regionCode, "CN-110000");
  a.respond(1, firstCopy());
  await save;
  assert.equal(a.routes[0], `/pages/print/index?projectId=${projectId}`);
});

test("unknown print submission survives page re-entry and retries the original binding and key after querying", async () => {
  const h = harness("print");
  h.page.onLoad({ projectId });
  const load = h.page.refresh();
  h.respond(0, firstCopy());
  await load;
  const submit = h.page.submit();
  const original = h.requests[1];
  original.fail({ errMsg: "offline after submit" });
  await submit;
  h.page.onUnload();
  const next = harness("print");
  for (const [key, value] of h.storage) next.storage.set(key, value);
  next.page.onLoad({ projectId });
  assert.equal(next.page.data.unknown, true);
  const changed = firstCopy();
  changed.book.version = 4;
  changed.book.snapshot.cover.title = "后来修改的书名";
  changed.address.hash = "d".repeat(64);
  const query = next.page.refresh();
  next.respond(0, changed);
  await query;
  assert.equal(
    next.page.data.unknown,
    true,
    "a retry keeps showing the original submission summary",
  );
  assert.equal(next.page.data.queryComplete, true);
  assert.notEqual(
    next.page.data.pendingIntent.title,
    changed.book.snapshot.cover.title,
  );
  assert.equal(next.page.data.pendingIntent.version, 3);
  const retry = next.page.submit();
  assert.equal(
    next.requests[1].header["Idempotency-Key"],
    original.header["Idempotency-Key"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(next.requests[1].data)),
    JSON.parse(JSON.stringify(original.data)),
  );
  next.respond(1, {
    ...firstCopy(),
    production: { id: "order" },
    canSubmit: false,
  });
  await retry;
  assert.match(next.routes[0], /production/);
});

test("production reads the submitted version and actual shipment without marking a reservation as printing", async () => {
  const h = harness("production");
  h.page.onLoad({ projectId });
  const pending = h.page.refresh();
  h.respond(0, fulfillment());
  await tick();
  assert.match(h.requests[1].url, new RegExp(`/book/versions/${versionId}$`));
  h.respond(1, version());
  await pending;
  assert.equal(h.page.data.label, "已提交，等待制作");
  assert.equal(h.page.data.steps[1].done, false);
  h.page.preview();
  assert.equal(
    h.routes[0],
    `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
  );
  const shipped = h.page.refresh();
  h.respond(2, fulfillment("shipped"));
  await shipped;
  assert.equal(h.page.data.screen, "shipped");
  assert.equal(h.page.data.steps[2].done, true);
  assert.equal(h.page.data.steps[3].done, false);
  assert.equal(h.page.data.view.current.tracking.number, "SYNTHETIC123");
});
