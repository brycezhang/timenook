import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, projectId, context, overview } from "./helpers/senior-page";

async function cover() {
  const h = harness("cover");
  h.page.onLoad({ projectId });
  const load = h.page.onShow();
  h.respond(0, context());
  h.respond(1, overview());
  await load;
  return h;
}
const input = (field: string, value: string) => ({
  currentTarget: { dataset: { field } },
  detail: { value },
});

test("choosing a cover photo preserves the unsaved title and salutation; leaving writes nothing", async () => {
  const h = await cover();
  h.page.input(input("title", "一起走过的时光"));
  h.page.input(input("salutation", "送给家人"));
  void h.page.choose();
  assert.equal(
    h.requests.length,
    2,
    "opening the picker must not persist either field",
  );
  assert.match(h.routes[0], /cover-photos/);
  h.page.onHide();
  h.navigations[0].events.coverPhotoSelected({ photoAssetId: null });
  await h.page.onShow();
  assert.equal(h.page.data.title, "一起走过的时光");
  assert.equal(h.page.data.salutation, "送给家人");
  h.page.onUnload();
  assert.equal(h.requests.length, 2);
});

test("saving submits one complete cover draft and retries an unknown result with the same key", async () => {
  const h = await cover();
  h.page.input(input("title", "新书名"));
  h.page.input(input("salutation", "新寄语"));
  const pending = h.page.save();
  const command = h.requests[2];
  assert.match(command.url, /book\/cover$/);
  assert.deepEqual(JSON.parse(JSON.stringify(command.data)), {
    expectedVersion: 0,
    expectedMetadataVersion: 1,
    title: "新书名",
    salutation: "新寄语",
    photoAssetId: null,
  });
  command.fail({ errMsg: "offline" });
  await pending;
  assert.equal(h.page.data.title, "新书名");
  assert.equal(h.page.data.dirty, true);
  const retry = h.page.save();
  assert.equal(
    h.requests[3].header["idempotency-key"],
    command.header["idempotency-key"],
  );
  h.respond(3, context());
  await retry;
  assert.deepEqual(h.routes, ["back"]);
  assert.equal(h.requests.length, 4);
});
