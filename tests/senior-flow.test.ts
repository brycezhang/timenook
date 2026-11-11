import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base,
  projectId,
  versionId,
  storyId,
  login,
  harness,
  version,
  context,
  overview,
  tick,
} from "./helpers/senior-page";
function outline() {
  const c = context();
  return {
    projectId,
    revision: 4,
    chapters: [
      ...c.directory.chapters,
      { key: "future", title: "未来", storyRefs: [] },
    ].map((ch) => ({ ...ch, questions: [] })),
    starters: [],
    preferences: { version: 1, blockedTopics: [] },
    questionStates: [],
    actualQuestions: [],
    answers: [],
    subjectDecision: "member",
    accessExpiresAt: null,
  };
}
test("chapter directory saves the unified order and opens chapter content", async () => {
  const h = harness("directory");
  h.page.onLoad({ projectId });
  const pending = h.page.onShow();
  const p = outline();
  h.respond(0, p);
  h.respond(1, overview());
  await pending;
  h.page.reorder({ detail: { ids: ["future", "home"] } });
  assert.deepEqual(
    Array.from(h.requests[2].data.content.chapters, (x: any) => x.key),
    ["future", "home"],
  );
  assert.match(h.requests[2].url, /\/plan$/);
  h.respond(2, { ...p, revision: 5, chapters: [p.chapters[1], p.chapters[0]] });
  await tick();
  h.page.open({ detail: { id: "home" } });
  assert.match(h.routes[0], /pages\/chapter-outline\/index/);
});
test("choosing a story moves it out of its former chapter and presents one selected row", async () => {
  const h = harness("chapter-stories");
  h.page.onLoad({ projectId, chapter: "future" });
  const p = outline(),
    c = context();
  c.directory.chapters = p.chapters;
  const pending = h.page.onShow();
  h.respond(0, c);
  h.respond(1, p);
  await pending;
  assert.equal(h.page.data.available[0].elsewhere, true);
  h.page.add({ currentTarget: { dataset: { id: storyId } } });
  const chapters = h.requests[2].data.content.chapters;
  assert.equal(chapters[0].storyRefs.length, 0);
  assert.equal(chapters[1].storyRefs[0], storyId);
  h.respond(2, { ...p, revision: 5, chapters });
  await tick();
  h.respond(3, { ...c, directory: { ...c.directory, version: 5, chapters } });
  await tick();
  assert.equal(h.page.data.selected.length, 1);
  assert.equal(h.page.data.available.length, 0);
});
test("complete manuscript opens only the pinned PDF and discards mismatched bytes", async () => {
  for (const matching of [true, false]) {
    const h = harness("manuscript");
    h.page.onLoad({ projectId, versionId });
    const show = h.page.onShow();
    const v = version();
    if (!matching) v.pdf.sha256 = "0".repeat(64);
    h.respond(0, v);
    await show;
    const download = h.page.openPdf();
    h.downloads[0].success({ statusCode: 200, tempFilePath: "/tmp/book.pdf" });
    await download;
    assert.equal(h.opened.length, matching ? 1 : 0);
    if (!matching) assert.ok(h.removed.includes("/tmp/book.pdf"));
    h.page.onUnload();
  }
});
test("a PDF response from the previous account is removed and never opened", async () => {
  const h = harness("manuscript");
  h.page.onLoad({ projectId, versionId });
  const show = h.page.onShow();
  h.respond(0, version());
  await show;
  const download = h.page.openPdf();
  h.storage.delete(`timenook.session.v1:${base}`);
  h.downloads[0].success({ statusCode: 200, tempFilePath: "/tmp/old.pdf" });
  await download;
  assert.equal(h.opened.length, 0);
  assert.ok(h.removed.includes("/tmp/old.pdf"));
  h.page.onUnload();
});
test("current session invalidation clears the book and private preview", async () => {
  const h = harness();
  h.page.onLoad({ projectId });
  const show = h.page.refresh();
  h.respond(0, context());
  h.respond(1, overview());
  await show;
  assert.ok(h.page.data.context);
  const next = h.page.refresh();
  h.respond(2, {}, 401);
  h.respond(3, {}, 401);
  await next;
  assert.equal(h.page.data.context, null);
  assert.equal(h.page.data.busy, false);
  h.page.onUnload();
});

function printContext(): any {
  return {
    projectId,
    noticeVersion: "synthetic-d08-v1",
    evidencePrefix: "synthetic:",
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
    blockers: ["ADDRESS_REQUIRED"],
    canSubmit: false,
    canReviseProduction: false,
    production: null,
    accessExpiresAt: null,
  };
}
test("member submits pinned PDF and address without confirmation; unknown result queries before retry with same key", async () => {
  const h = harness("print");
  h.page.onLoad({ projectId });
  const c = printContext();
  c.canSubmit = true;
  c.blockers = [];
  c.address = {
    version: 1,
    hash: "c".repeat(64),
    value: {
      recipientName: "测试",
      phone: "13800000000",
      regionCode: "CN-SH",
      detail: "合成地址",
    },
  };
  const show = h.page.refresh();
  h.respond(0, c);
  await show;
  const first = h.page.submit();
  assert.equal(h.requests[1].data.pdfHash, "f".repeat(64));
  assert.equal(h.requests[1].data.addressHash, "c".repeat(64));
  const key = h.requests[1].header["Idempotency-Key"];
  h.requests[1].fail({});
  await first;
  assert.equal(h.page.data.unknown, true);
  await h.page.submit();
  assert.equal(h.requests.length, 2);
  const query = h.page.refresh();
  h.respond(2, c);
  await query;
  const retry = h.page.submit();
  assert.equal(h.requests[3].header["Idempotency-Key"], key);
  h.respond(3, { ...c, production: { id: "order" } });
  await retry;
  assert.match(h.routes[0], /production/);
  h.page.onUnload();
});
test("cover selection returns a local choice without saving the cover", async () => {
  const h = harness("cover-photos");
  h.page.onLoad({ projectId, selected: storyId });
  const show = h.page.onShow();
  h.respond(0, context());
  await show;
  h.page.choose({ currentTarget: { dataset: { id: "" } } });
  await h.page.save();
  assert.equal(h.requests.length, 1);
  assert.equal(h.events[0].name, "coverPhotoSelected");
  assert.equal(h.events[0].value.photoAssetId, null);
  assert.deepEqual(h.routes, ["back"]);
  h.page.onUnload();
});
test("drag handle reorders once and cancel restores; tapping content never starts a drag", async () => {
  const source = (
    await build({
      entryPoints: ["miniprogram/components/sort-list/index.ts"],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
    })
  ).outputFiles[0].text;
  let component: any;
  const events: any[] = [];
  const rows = [
    { id: "one", title: "一" },
    { id: "two", title: "二" },
  ];
  runInNewContext(source, {
    Component(value: any) {
      component = value;
    },
    wx: {
      env: { USER_DATA_PATH: "/user-data" },
      vibrateShort() {},
      getSystemInfoSync() {
        return { windowHeight: 800 };
      },
      pageScrollTo() {},
    },
  });
  component.data = {
    ...component.data,
    items: rows,
    rows: [...rows],
    disabled: false,
  };
  component.setData = (patch: any) => Object.assign(component.data, patch);
  component.triggerEvent = (name: string, detail: any) =>
    events.push({ name, detail });
  Object.assign(component, component.methods);
  component.createSelectorQuery = () => ({
    selectAll() {
      return this;
    },
    boundingClientRect(fn: any) {
      fn([
        { top: 120, bottom: 220 },
        { top: 220, bottom: 320 },
      ]);
      return this;
    },
    exec() {},
  });
  component.open({ currentTarget: { dataset: { id: "one" } } });
  assert.equal(component.data.dragging, "");
  assert.equal(events[0].name, "open");
  component.start({ currentTarget: { dataset: { id: "one" } } });
  component.move({ touches: [{ clientY: 260 }] });
  component.end();
  assert.equal(events[1].name, "reorder");
  assert.deepEqual(Array.from(events[1].detail.ids), ["two", "one"]);
  component.end();
  assert.equal(events.length, 2);
  component.start({ currentTarget: { dataset: { id: "two" } } });
  component.cancel();
  assert.deepEqual(component.data.rows, rows);
});
