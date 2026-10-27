import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { runInNewContext } from "node:vm";
async function harness() {
  const script = readFileSync("apps/admin/src/views/deletion-case.vue", "utf8")
    .split('<script setup lang="ts">')[1]
    .split("</script>")[0]
    .replace(/^import .*;\n/gm, "");
  const { code } = await transform(
    `${script}\nexport {value, busy, error, evidence, selectedItem, refresh, command};`,
    { loader: "ts", format: "cjs" },
  );
  const props = { caseId: "case-a", csrf: "synthetic-csrf" },
    calls: any[] = [],
    unmount: (() => void)[] = [],
    emitted: string[] = [];
  const module = { exports: {} as any };
  runInNewContext(code, {
    module,
    exports: module.exports,
    ref: (value: any) => ({ value }),
    categoryLabels: {},
    layerLabels: {},
    computed: (fn: () => any) => ({
      get value() {
        return fn();
      },
    }),
    defineProps: () => props,
    defineEmits: () => (event: string) => emitted.push(event),
    onMounted() {},
    onUnmounted: (fn: () => void) => unmount.push(fn),
    watch() {},
    crypto: { randomUUID: () => `key-${calls.length}` },
    Date,
    deletionApi: {
      read: (id: string) =>
        new Promise((resolve, reject) => calls.push({ id, resolve, reject })),
      command: (...args: any[]) =>
        new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    },
  });
  return {
    page: module.exports,
    props,
    calls,
    unmount: () => unmount.forEach((fn) => fn()),
    emitted,
  };
}
const value = {
  projectId: "project-a",
  onlineAccessStopped: true,
  permanentProjectDeletion: true,
  accessEpoch: 1,
  changes: [
    {
      id: "change-a",
      items: [
        {
          id: "item-a",
          category: "audio",
          layer: "backup",
          state: "awaiting_evidence",
          deadline: null,
          completedAt: null,
          reason: "RULE_NOT_FROZEN",
          evidenceRef: null,
        },
        {
          id: "db-a",
          category: "audio",
          layer: "active_database",
          state: "pending",
          deadline: null,
          completedAt: null,
          reason: null,
          evidenceRef: null,
        },
      ],
    },
  ],
  boundary: "不能远程收回已下载副本",
};
test("Care deletion records one allowed external item and retries unknown outcome with the same key", async () => {
  const h = await harness();
  const read = h.page.refresh();
  h.calls[0].resolve(value);
  await read;
  h.page.selectedItem.value = value.changes[0].items[0];
  h.page.evidence.value = "record:synthetic-receipt";
  const pending = h.page.command("confirmed");
  assert.equal(h.calls[1].args[1], "items/item-a/evidence");
  assert.equal(h.calls[1].args[2].state, "confirmed");
  h.calls[1].reject(Error("network"));
  await pending;
  const retry = h.page.command("confirmed");
  assert.equal(h.calls[2].args[3], h.calls[1].args[3]);
  h.calls[2].resolve(value);
  await retry;
  h.page.selectedItem.value = value.changes[0].items[1];
  h.page.evidence.value = "record:synthetic-receipt";
  await h.page.command("confirmed");
  assert.equal(h.calls.length, 3);
  h.unmount();
});
for (const state of ["resolved", "forbidden", "expired"])
  test(`Care deletion discards an old case's late ${state} response`, async () => {
    const h = await harness();
    const read = h.page.refresh();
    h.calls[0].resolve(value);
    await read;
    const pending = h.page.command("reconcile");
    h.props.caseId = "case-b";
    h.page.value.value = null;
    if (state === "resolved") h.calls[1].resolve(value);
    else
      h.calls[1].reject({
        error: {
          code: state === "forbidden" ? "FORBIDDEN" : "UNAUTHENTICATED",
        },
      });
    await pending;
    assert.equal(h.page.value.value, null);
    assert.equal(h.page.error.value, "");
    assert.equal(h.emitted.length, 0);
    h.unmount();
  });
test("Care deletion discards a response after leaving the component", async () => {
  const h = await harness();
  const read = h.page.refresh();
  h.unmount();
  h.calls[0].resolve(value);
  await read;
  assert.equal(h.page.value.value, null);
});
test("Care deletion refresh keeps the selected item and stable unknown intent tied to the current returned row", async () => {
  const h = await harness();
  const read = h.page.refresh();
  h.calls[0].resolve(value);
  await read;
  h.page.selectedItem.value = value.changes[0].items[0];
  h.page.evidence.value = "record:synthetic-refresh";
  const write = h.page.command("pending");
  h.calls[1].reject(Error("unknown"));
  await write;
  const refresh = h.page.refresh();
  const refreshed = structuredClone(value);
  h.calls[2].resolve(refreshed);
  await refresh;
  const retry = h.page.command("pending");
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3].args[3], h.calls[1].args[3]);
  h.calls[3].resolve(refreshed);
  await retry;
  h.unmount();
});
