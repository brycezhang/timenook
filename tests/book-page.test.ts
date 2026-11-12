import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base,
  projectId,
  versionId,
  login,
  harness,
  version,
  context,
  overview,
  tick,
} from "./helpers/senior-page";

async function book(c = context()) {
  const h = harness("book");
  h.page.onLoad({ projectId });
  const loading = h.page.refresh();
  h.respond(0, c);
  h.respond(1, overview());
  await loading;
  return h;
}
async function manuscript(v = version()) {
  const h = harness("manuscript");
  h.page.onLoad({ projectId, versionId });
  const loading = h.page.onShow();
  h.respond(0, v);
  await loading;
  return h;
}
test("initial book loading ends on success or failure, while updates keep the current book visible", async () => {
  const h = harness("book");
  h.page.onLoad({ projectId });
  assert.equal(h.page.data.pageLoading, true);
  const initial = h.page.refresh();
  h.respond(0, context(null));
  await tick();
  assert.equal(h.page.data.pageLoading, true, "wait for the project title too");
  h.respond(1, overview());
  await initial;
  assert.equal(h.page.data.pageLoading, false);

  const current = h.page.data.context;
  const generation = h.page.generate();
  assert.equal(h.page.data.busy, true);
  assert.equal(h.page.data.pageLoading, false);
  assert.equal(h.page.data.context, current);
  h.respond(2, version("queued"));
  await generation;
  h.page.onUnload();

  const failed = harness("book");
  failed.page.onLoad({ projectId });
  const pending = failed.page.refresh();
  failed.requests[0].fail({ errMsg: "offline" });
  failed.respond(1, overview());
  await pending;
  assert.equal(failed.page.data.pageLoading, false);
  assert.ok(failed.page.data.status);
  failed.page.onUnload();
});
test("ready book exposes separate cover, directory, exact PDF and printing entries", async () => {
  const h = await book();
  h.page.cover();
  h.page.directory();
  h.page.manuscript();
  h.page.print();
  assert.deepEqual(h.routes, [
    `/pages/cover/index?projectId=${projectId}`,
    `/pages/directory/index?projectId=${projectId}`,
    `/pages/manuscript/index?projectId=${projectId}&versionId=${versionId}`,
    `/pages/print/index?projectId=${projectId}`,
  ]);
  assert.equal(h.page.data.stateLabel, "PDF 已生成 · V3");
});
test("changed inputs require a new version before preview or printing", async () => {
  const c = context();
  c.inputHash = "9".repeat(64);
  const h = await book(c);
  assert.equal(h.page.data.dirty, true);
  assert.equal(h.page.data.stateLabel, "书稿待更新");
  h.page.manuscript();
  h.page.print();
  assert.equal(h.routes.length, 0);
  assert.equal(h.page.data.screen, "changed");
  const pending = h.page.generate();
  assert.equal(h.requests[2].data.expectedInputHash, c.inputHash);
  h.respond(2, version("queued"));
  await pending;
});
test("unknown generation result retries the same observed input and idempotency key", async () => {
  const h = await book(context(null));
  const first = h.page.generate();
  const command = h.requests[2];
  command.fail({ errMsg: "offline" });
  await first;
  assert.equal(h.page.data.busy, false);
  assert.ok(h.page.data.status);
  const retry = h.page.generate();
  assert.equal(
    h.requests[3].header["idempotency-key"],
    command.header["idempotency-key"],
  );
  h.respond(3, version("queued"));
  await retry;
  assert.equal(h.page.data.context.current.state, "queued");
});
test("failed current book retries the existing version instead of creating another", async () => {
  const h = await book(context(version("failed")));
  const pending = h.page.generate();
  assert.match(h.requests[2].url, new RegExp(`/versions/${versionId}/retry$`));
  h.respond(2, version("queued"));
  await pending;
});
test("a late book refresh cannot restore private data after leaving", async () => {
  const h = harness("book");
  h.page.onLoad({ projectId });
  const pending = h.page.refresh();
  h.page.onHide();
  h.respond(0, context());
  h.respond(1, overview());
  await pending;
  assert.equal(h.page.data.context, null);
});
test("a denied book reload removes the old private version", async () => {
  const h = await book();
  const pending = h.page.refresh();
  h.respond(2, {}, 403);
  h.respond(3, overview());
  await pending;
  assert.equal(h.page.data.context, null);
  assert.ok(h.storage.get(`timenook.session.v1:${base}`));
});
test("a ready PDF remains available without an optional raw cover photograph", async () => {
  const v = version();
  v.coverPhotoAccess = { allowed: false, expiresAt: null };
  const h = await manuscript(v);
  assert.equal(h.page.data.version.id, versionId);
  const opening = h.page.openPdf();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "/tmp/book.pdf" });
  await opening;
  assert.equal(h.opened.length, 1);
});
test("a late PDF download after leaving only deletes its temporary file", async () => {
  const h = await manuscript();
  const opening = h.page.openPdf();
  h.page.onHide();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "/tmp/late.pdf" });
  await opening;
  assert.deepEqual(h.removed, ["/tmp/late.pdf"]);
  assert.equal(h.opened.length, 0);
});
test("a non-ready version never issues a PDF download", async () => {
  const h = await manuscript(version("obsolete"));
  await h.page.openPdf();
  assert.equal(h.downloads.length, 0);
});
test("production preview opens its reserved PDF after draft changes without enabling a new print submission", async (t) => {
  const h = harness("manuscript");
  t.after(() => h.page.onUnload());
  h.page.onLoad({ projectId, versionId, production: "1" });
  const loading = h.page.onShow();
  assert.equal(
    h.requests[0].url,
    `${base}/projects/${projectId}/fulfillment/book`,
  );
  h.respond(0, { ...version(), state: "obsolete" });
  await loading;
  const opening = h.page.openPdf();
  assert.equal(
    h.downloads[0].url,
    `${base}/projects/${projectId}/fulfillment/book/pdf`,
  );
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "/tmp/fixed-production.pdf",
  });
  await opening;
  assert.equal(h.opened[0].filePath, "/tmp/fixed-production.pdf");
  h.page.print();
  assert.equal(h.routes.length, 0);
});
test("failed PDF HTTP response is removed without opening a viewer", async () => {
  const h = await manuscript();
  const opening = h.page.openPdf();
  h.downloads[0].success({ statusCode: 503, tempFilePath: "/tmp/failed.pdf" });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.removed, ["/tmp/failed.pdf"]);
});
test("wrong PDF size is refused even if its digest matches", async () => {
  const v = version();
  v.pdf.bytes = 4568;
  const h = await manuscript(v);
  const opening = h.page.openPdf();
  h.downloads[0].success({ statusCode: 200, tempFilePath: "/tmp/short.pdf" });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.removed, ["/tmp/short.pdf"]);
});
test("remote project-access denial clears an open private manuscript", async () => {
  const h = await manuscript();
  const checking = h.timers[0].callback();
  h.respond(1, { canRead: false, accessEpoch: 1 });
  await checking;
  await tick();
  assert.equal(h.page.data.version, null);
  assert.ok(h.page.data.status);
});
test("a 401 during PDF download removes bytes and the expired session", async () => {
  const h = await manuscript();
  const opening = h.page.openPdf();
  h.downloads[0].success({ statusCode: 401, tempFilePath: "/tmp/denied.pdf" });
  await opening;
  assert.equal(h.opened.length, 0);
  assert.equal(h.page.data.version, null);
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
});

test("PDF viewer failure clears its temporary file and retries the same fixed version", async () => {
  const h = await manuscript();
  h.faults.openDocument = true;
  const failed = h.page.openPdf();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "/tmp/not-opened.pdf",
  });
  await failed;
  assert.equal(h.page.data.openFailed, true);
  assert.ok(h.removed.includes("/tmp/not-opened.pdf"));
  h.faults.openDocument = false;
  const retry = h.page.openPdf();
  h.downloads[1].success({ statusCode: 200, tempFilePath: "/tmp/retried.pdf" });
  await retry;
  assert.equal(h.page.data.openFailed, false);
  assert.equal(h.opened[1].fileType, "pdf");
  h.page.onUnload();
  assert.ok(h.removed.includes("/tmp/retried.pdf"));
});

test("ordinary unassigned stories never block the already assigned manuscript", async () => {
  const c = context(null);
  c.eligibleStories.push({
    ...c.eligibleStories[0],
    id: "88888888-8888-4888-8888-888888888888",
  });
  const h = await book(c);
  assert.equal(h.page.data.storyCount, 1);
  assert.equal(h.page.data.unassignedCount, 1);
  const creating = h.page.generate();
  h.respond(2, version("queued"));
  await creating;
  assert.equal(h.page.data.rendering, true);
  h.page.onUnload();

  c.directory.chapters = [];
  const empty = await book(c);
  await empty.page.generate();
  assert.equal(empty.requests.length, 2);
  assert.match(empty.routes[0], /directory/);
  empty.page.onUnload();
});
