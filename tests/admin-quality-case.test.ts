import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
const script = readFileSync("apps/admin/src/views/quality-case.vue", "utf8")
  .split('<script setup lang="ts">')[1]
  .split("</script>")[0]
  .replace(/^import[\s\S]*?;\n/gm, "");
const { code } = await transform(
  `${script}\nexport { view, materials, busy, error, loadMaterials, dueAt, evidence, command };`,
  { loader: "ts", format: "cjs" },
);
function harness() {
  let now = 1000;
  const loads: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const commands: {
    args: any[];
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const unmounts: (() => void)[] = [],
    emitted: string[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const module = { exports: {} as any };
  runInNewContext(code, {
    module,
    exports: module.exports,
    ref: (value: unknown) => ({ value }),
    onMounted() {},
    onUnmounted: (f: () => void) => unmounts.push(f),
    defineProps: () => ({ caseId: "synthetic-case", csrf: "synthetic-csrf" }),
    defineEmits: () => (event: string) => emitted.push(event),
    qualityApi: {
      materials: () =>
        new Promise((resolve, reject) => loads.push({ resolve, reject })),
      command: (...args: any[]) =>
        new Promise((resolve, reject) =>
          commands.push({ args, resolve, reject }),
        ),
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(run: () => void, delay: number) {
      timers.set(++nextTimer, { at: now + delay, run });
      return nextTimer;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    URL: { revokeObjectURL() {} },
    crypto: { randomUUID: () => `synthetic-${commands.length}` },
  });
  const page = module.exports;
  page.view.value = {
    id: "synthetic-quality",
    original: { pdfHash: "f".repeat(64) },
    grant: { scopes: ["evidence"], expiresAt: new Date(2000).toISOString() },
  };
  return {
    page,
    loads,
    commands,
    emitted,
    advance(value: number) {
      now = value;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
    },
    unmount() {
      unmounts.forEach((f) => f());
    },
  };
}
const value = {
  description: "合成私人质量说明",
  pdf: null,
  grantExpiresAt: new Date(2000).toISOString(),
};
test("shared quality case exposes only scoped materials while a current grant is alive", async () => {
  const h = harness(),
    pending = h.page.loadMaterials();
  assert.equal(h.loads.length, 1);
  h.loads[0].resolve(value);
  await pending;
  assert.equal(h.page.materials.value.description, "合成私人质量说明");
  h.advance(2000);
  assert.equal(h.page.materials.value, null);
  const late = harness(),
    loading = late.page.loadMaterials();
  late.advance(2000);
  late.loads[0].resolve(value);
  await loading;
  assert.equal(late.page.materials.value, null);
  const departed = harness(),
    old = departed.page.loadMaterials();
  departed.unmount();
  departed.loads[0].resolve(value);
  await old;
  assert.equal(departed.page.materials.value, null);
});
test("shared quality assignment uses the original case version and keeps an uncertain intent", async () => {
  const h = harness();
  h.page.view.value.version = 2;
  h.page.dueAt.value = "2026-10-28T12:00";
  h.page.evidence.value = "synthetic:original-d06-reviewed";
  const assigning = h.page.command("assign");
  assert.equal(h.commands.length, 1);
  const call = h.commands[0];
  assert.equal(call.args[0], "synthetic-case");
  assert.equal(call.args[1], "assign");
  assert.equal(call.args[2].expectedVersion, 2);
  assert.equal(call.args[2].evidenceRef, "synthetic:original-d06-reviewed");
  assert.equal(call.args[4], "synthetic-csrf");
  call.reject({ error: { code: "UNAVAILABLE" } });
  await assigning;
  const retry = h.page.command("assign");
  assert.equal(h.commands[1].args[3], call.args[3]);
  h.commands[1].resolve({
    ...h.page.view.value,
    version: 3,
    ownerLabel: "客服一",
  });
  await retry;
  assert.equal(h.page.view.value.ownerLabel, "客服一");
  h.unmount();
});
test("a revised reprint uses only the server's fresh confirmed replacement binding", async () => {
  const h = harness();
  Object.assign(h.page.view.value, {
    version: 4,
    resolution: "reprint",
    reprintMode: "revised",
    state: "reviewed",
    replacement: null,
  });
  await h.page.command("reprints");
  assert.equal(h.commands.length, 0);
  const replacement = {
    bookVersionId: "new-book",
    snapshotHash: "b".repeat(64),
    pdfHash: "c".repeat(64),
    addressHash: "d".repeat(64),
  };
  h.page.view.value.replacement = replacement;
  const reprinting = h.page.command("reprints");
  assert.equal(h.commands.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0].args[2])), {
    expectedVersion: 4,
    ...replacement,
  });
  h.commands[0].resolve({
    ...h.page.view.value,
    version: 5,
    state: "reprinting",
    productionAttemptId: "new-attempt",
  });
  await reprinting;
  assert.equal(h.page.view.value.productionAttemptId, "new-attempt");
  h.unmount();
});
