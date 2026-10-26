import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
async function harness() {
  const script = readFileSync("apps/admin/src/views/fulfillment.vue", "utf8")
    .split('<script setup lang="ts">')[1]
    .split("</script>")[0]
    .replace(/^import[\s\S]*?;\n/gm, "");
  const { code } = await transform(
    `${script}\nexport { rows, selected, busy, error, supplierRef, dueAt, materials, createAttempt, open, loadMaterials, evidence, receipt, carrier, trackingNumber, shippedAt, shippingEvidence, wechatEvidence, wechatResult, saveShipping };`,
    { loader: "ts", format: "cjs" },
  );
  const calls: {
    args: unknown[];
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const clock = { now: Date.now() };
  const timers: { run: () => void; delay: number }[] = [];
  const unmount: (() => void)[] = [];
  const module = { exports: {} as any };
  runInNewContext(code, {
    module,
    exports: module.exports,
    ref: (value: unknown) => ({ value }),
    computed: (fn: () => unknown) => ({
      get value() {
        return fn();
      },
    }),
    onMounted() {},
    onUnmounted: (fn: () => void) => unmount.push(fn),
    defineProps: () => ({ csrf: "synthetic-csrf" }),
    defineEmits: () => () => {},
    fulfillmentApi: {
      attempt: (...args: unknown[]) =>
        new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
      read: (...args: unknown[]) =>
        new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
      materials: (...args: unknown[]) =>
        new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
      command: (...args: unknown[]) =>
        new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    },
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout(run: () => void, delay: number) {
      timers.push({ run, delay });
      return timers.length;
    },
    clearTimeout() {},
    crypto: { randomUUID: () => `synthetic-command-${calls.length}` },
    URL: { revokeObjectURL() {} },
  });
  return {
    page: module.exports,
    calls,
    clock,
    timers,
    unmount: () => unmount.forEach((fn) => fn()),
  };
}
function initial() {
  return {
    projectId: "project",
    orderId: "order",
    approvedSupplierRef: "synthetic:local-printer",
    reservation: {
      bookVersionId: "book",
      snapshotHash: "b".repeat(64),
      pdfHash: "f".repeat(64),
      addressHash: "c".repeat(64),
    },
    current: null,
    attempts: [],
    creation: { state: "active", expiresAt: null },
    canGrant: false,
  };
}

test("operational creation binds the selected reservation and keeps one uncertain attempt intent", async () => {
  const h = await harness(),
    view = initial();
  h.page.selected.value = view;
  h.page.rows.value = [view];
  h.page.supplierRef.value = "synthetic:unapproved-form-value";
  h.page.dueAt.value = "2098-10-26T14:30";
  const creating = h.page.createAttempt();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args[1])), {
    ...view.reservation,
    supplierRef: "synthetic:local-printer",
    dueAt: new Date("2098-10-26T14:30").toISOString(),
  });
  const key = h.calls[0].args[2];
  h.calls[0].reject(new Error("synthetic network failure"));
  await creating;
  const retry = h.page.createAttempt();
  assert.equal(h.calls[1].args[2], key);
  h.calls[1].resolve({
    ...view,
    current: { id: "attempt", state: "approved" },
  });
  await retry;
  assert.equal(h.page.selected.value.current.id, "attempt");
  assert.equal(
    h.page.rows.value[0].current.id,
    "attempt",
    "list and detail expose the same actual phase",
  );
  h.unmount();
});

test("limited production materials clear at exact expiry and an unmounted response cannot restore addresses", async () => {
  const h = await harness(),
    view: any = initial();
  view.current = {
    ...view.reservation,
    id: "attempt",
    state: "approved",
    handoffId: "handoff",
    grantExpiresAt: new Date(h.clock.now + 500).toISOString(),
  };
  h.page.selected.value = view;
  const loading = h.page.loadMaterials();
  const materials = {
    address: {
      recipientName: "合成收件人",
      phone: "13800000000",
      regionCode: "CN-SH",
      detail: "合成路1号",
    },
    pdf: { sha256: "f".repeat(64), bytes: 100 },
    grantExpiresAt: view.current.grantExpiresAt,
    handoffId: "handoff",
  };
  h.calls[0].resolve(materials);
  await loading;
  assert.equal(h.page.materials.value.address.recipientName, "合成收件人");
  h.clock.now += 500;
  h.timers[h.timers.length - 1].run();
  assert.equal(h.page.materials.value, null);
  h.clock.now -= 500;
  const next = h.page.loadMaterials();
  h.unmount();
  h.calls[1].resolve(materials);
  await next;
  assert.equal(h.page.materials.value, null);
  assert.equal(h.page.selected.value, null);
});

test("unknown supplier receipt stays a pending command owned by the same attempt on uncertain retry", async () => {
  const h = await harness(),
    view: any = initial();
  view.current = { id: "attempt", state: "handoff_pending" };
  h.page.selected.value = view;
  h.page.evidence.value = "synthetic:manual-receipt-check";
  const saving = h.page.receipt("unknown");
  assert.equal(h.calls[0].args[0], "order");
  assert.equal(h.calls[0].args[1], "attempt");
  assert.equal(h.calls[0].args[2], "receipt");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args[3])), {
    outcome: "unknown",
    evidenceRef: "synthetic:manual-receipt-check",
  });
  h.calls[0].reject(new Error("synthetic network failure"));
  await saving;
  const retry = h.page.receipt("unknown");
  assert.equal(h.calls[1].args[4], h.calls[0].args[4]);
  h.calls[1].resolve(view);
  await retry;
  assert.equal(h.page.selected.value.current.state, "handoff_pending");
  h.unmount();
});

test("a later WeChat result uses the original immutable tracking including seconds and milliseconds", async () => {
  const h = await harness(),
    view: any = initial();
  view.current = {
    id: "attempt",
    state: "delivered",
    tracking: {
      carrier: "合成物流",
      number: "SYNTHETIC-001",
      shippedAt: "2026-10-25T04:30:45.123Z",
    },
    wechat: { result: "pending" },
  };
  const opening = h.page.open("order");
  h.calls[0].resolve(view);
  await opening;
  assert.equal(h.page.carrier.value, "合成物流");
  assert.equal(h.page.trackingNumber.value, "SYNTHETIC-001");
  h.page.shippingEvidence.value = "synthetic:shipping-check";
  h.page.wechatEvidence.value = "synthetic:wechat-record-confirmed";
  h.page.wechatResult.value = "recorded";
  const saving = h.page.saveShipping();
  assert.equal(
    (h.calls[1].args[3] as any).shippedAt,
    "2026-10-25T04:30:45.123Z",
  );
  assert.equal((h.calls[1].args[3] as any).wechat.result, "recorded");
  h.calls[1].resolve(view);
  await saving;
  assert.equal(h.page.selected.value.current.state, "delivered");
  h.unmount();
});
