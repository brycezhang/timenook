import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

// Exercise the actual SFC's click handlers; Vue refs, device clock and HTTP are the boundaries.
const script = readFileSync("apps/admin/src/views/care.vue", "utf8")
  .split('<script setup lang="ts">')[1]
  .split("</script>")[0]
  .replace(/^import .*;\n/gm, "");
const { code } = await transform(
  `${script}\nexport {selected, correction, correctionTitle, correctionParagraphs, loadCorrection, saveCorrection};`,
  { loader: "ts", format: "cjs" },
);
const original = {
  version: 1,
  revision: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "合成私人故事",
    paragraphs: [{ text: "仅该有限授权可读的合成正文", sourceRefs: [] }],
    reviewItems: [],
    reviewResolutions: [],
  },
};
function harness() {
  let now = 1000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const unmount: (() => void)[] = [];
  const loads: { resolve: (value: unknown) => void }[] = [];
  const saves: {
    key: string;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const module = { exports: {} as any };
  runInNewContext(code, {
    module,
    exports: module.exports,
    ref: (value: unknown) => ({ value }),
    onMounted() {},
    onUnmounted: (fn: () => void) => unmount.push(fn),
    defineProps: () => ({ csrf: "synthetic-csrf" }),
    defineEmits: () => () => {},
    careApi: {
      story: () => new Promise((resolve) => loads.push({ resolve })),
      correct: (...args: unknown[]) =>
        new Promise((resolve, reject) =>
          saves.push({ key: args[5] as string, resolve, reject }),
        ),
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (run: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    crypto: { randomUUID: () => `synthetic-command-${saves.length}` },
  });
  const page = module.exports;
  const care = {
    id: "synthetic-case",
    kind: "correction",
    state: "verified",
    correctionGrant: { expiresAt: new Date(1200).toISOString() },
  };
  page.selected.value = care;
  return {
    page,
    care,
    loads,
    saves,
    advance(value: number, runTimers = true) {
      now = value;
      if (!runTimers) return;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
    },
    unmount: () => unmount.forEach((fn) => fn()),
  };
}
async function loaded(h: ReturnType<typeof harness>) {
  const loading = h.page.loadCorrection();
  h.loads[0].resolve(structuredClone(original));
  await loading;
  assert.ok(h.page.correction.value);
}

test("Care correction cannot restore controlled memory when its pending save completes at the exact grant expiry", async () => {
  const h = harness();
  await loaded(h);
  const saving = h.page.saveCorrection();
  h.advance(1200);
  assert.equal(h.page.correction.value, null);
  h.saves[0].resolve({ ...original, version: 2 });
  await saving;
  assert.equal(h.page.correction.value, null);
  assert.equal(h.page.correctionTitle.value, "");
  assert.equal(h.page.correctionParagraphs.value.length, 0);
  h.unmount();
});

test("Care correction rechecks the original grant before accepting a late read", async () => {
  const h = harness();
  const loading = h.page.loadCorrection();
  h.advance(1200);
  h.loads[0].resolve(structuredClone(original));
  await loading;
  assert.equal(h.page.correction.value, null);
  assert.equal(h.page.correctionTitle.value, "");
  h.unmount();
});

test("Care correction enforces grant expiry even when its device cleanup timer has not run", async () => {
  const h = harness();
  await loaded(h);
  const saving = h.page.saveCorrection();
  h.advance(1200, false);
  h.saves[0].resolve({ ...original, version: 2 });
  await saving;
  assert.equal(h.page.correction.value, null);
  assert.equal(h.page.correctionTitle.value, "");
  h.unmount();
});

test("Care correction's unmounted request cannot repopulate its controlled memory", async () => {
  const h = harness();
  await loaded(h);
  const saving = h.page.saveCorrection();
  h.unmount();
  h.saves[0].resolve({ ...original, version: 2 });
  await saving;
  assert.equal(h.page.correction.value, null);
});

test("Care correction ignores a response owned by a different selected case", async () => {
  const h = harness();
  await loaded(h);
  const saving = h.page.saveCorrection();
  const next = { ...h.care, id: "later-case" };
  // Ref replacement is the Vue owner boundary; this is not a rendered navigation claim.
  h.page.selected.value = next;
  h.page.correction.value = null;
  h.saves[0].resolve({ ...original, version: 2 });
  await saving;
  assert.equal(h.page.selected.value, next);
  assert.equal(h.page.correction.value, null);
  h.unmount();
});

test("Care correction keeps a valid failed-save intent for retry and accepts a current success until expiry", async () => {
  const h = harness();
  await loaded(h);
  const saving = h.page.saveCorrection();
  h.saves[0].reject(new Error("synthetic network failure"));
  await saving;
  assert.ok(h.page.correction.value);
  assert.equal(h.page.correctionTitle.value, original.revision.title);
  const retry = h.page.saveCorrection();
  assert.equal(h.saves[1].key, h.saves[0].key);
  h.saves[1].resolve({ ...original, version: 2 });
  await retry;
  assert.equal(h.page.correction.value.version, 2);
  h.advance(1200);
  assert.equal(h.page.correction.value, null);
  h.unmount();
});
