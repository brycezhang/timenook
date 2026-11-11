import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  joinedProject,
  projectPhoto,
  request,
  data,
} from "./book-fixture";

before(startBookFixture);
after(stopBookFixture);

test("one cover save commits title, salutation and project photo together while preserving the purchased title", async () => {
  const p = await joinedProject();
  const photo = await projectPhoto(p);
  const base = `/v1/projects/${p.projectId}`;
  const overview = data(
    await request("GET", base + "/overview", p.buyer.token),
    200,
  );
  const cover = data(await request("GET", base + "/book", p.buyer.token), 200);
  const order = data(
    await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token),
    200,
  );
  const input = {
    expectedVersion: cover.cover.version,
    expectedMetadataVersion: overview.metadataVersion,
    title: "一起走过的那些年",
    salutation: "献给家人的时光",
    photoAssetId: cover.coverPhotoOptions.find((v: any) => v.id === photo.id)
      .assetId,
  };
  const key = randomUUID();
  const saved = data(
    await request("POST", base + "/book/cover", p.buyer.token, input, key),
  );
  const updated = data(
    await request("GET", base + "/overview", p.buyer.token),
    200,
  );
  assert.equal(updated.bookTitle, input.title);
  assert.equal(updated.metadataVersion, overview.metadataVersion + 1);
  assert.equal(saved.cover.salutation, input.salutation);
  assert.equal(saved.cover.photoAssetId, input.photoAssetId);
  assert.deepEqual(
    data(await request("POST", base + "/book/cover", p.buyer.token, input, key))
      .cover,
    saved.cover,
  );
  assert.equal(
    data(await request("GET", `/v1/orders/${p.orderId}`, p.buyer.token), 200)
      .bookTitle,
    order.bookTitle,
  );

  const rejected = await request(
    "POST",
    base + "/book/cover",
    p.narrator.token,
    {
      ...input,
      expectedVersion: saved.cover.version,
      expectedMetadataVersion: updated.metadataVersion,
      title: "不应保存的书名",
      salutation: "不应保存的寄语",
      photoAssetId: randomUUID(),
    },
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(
    data(await request("GET", base + "/overview", p.buyer.token), 200)
      .bookTitle,
    input.title,
  );
  assert.deepEqual(
    data(await request("GET", base + "/book", p.buyer.token), 200).cover,
    saved.cover,
  );
  assert.equal(
    (
      await request("POST", base + "/book/cover", p.narrator.token, {
        ...input,
        expectedVersion: saved.cover.version,
        title: "过期草稿",
        photoAssetId: null,
      })
    ).statusCode,
    409,
  );
});
