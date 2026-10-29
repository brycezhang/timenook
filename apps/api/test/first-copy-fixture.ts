import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db, readyStory, bound, data, request, app } from "./book-fixture";
import { ProductionTasks } from "../src/tasks/tasks";
export async function readyFirstCopyBook(
  specification: {
    minPages?: number;
    maxPages?: number;
    bleedMm?: number;
  } = {},
) {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  snapshot.d01.minPages = 1;
  snapshot.d01.bleedMm = 0;
  Object.assign(snapshot.d01, specification);
  const draftId = randomUUID(),
    packageId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: packageId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "首本合成套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await readyStory(await bound(packageId));
  const story = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: p.story.revision.title,
        theme: p.story.revision.theme,
        paragraphs: p.story.revision.paragraphs,
        reviewResolutions: p.story.revision.reviewItems.map((item: string) => ({
          item,
          reason: "本人核对",
        })),
        notes: [],
      },
    ),
  );
  data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/stories/${story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: story.revision.id,
        expectedVersion: story.version,
        contentHash: story.revision.contentHash,
        confirmed: true,
        allowInBook: true,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:首本故事-${randomUUID()}`,
      },
    ),
  );
  const context = data(
    await request("GET", `/v1/projects/${p.projectId}/book`, p.narrator.token),
    200,
  );
  const book = data(
    await request(
      "POST",
      `/v1/projects/${p.projectId}/book/versions`,
      p.narrator.token,
      { expectedInputHash: context.inputHash },
    ),
    202,
  );
  await app.get(ProductionTasks).run(book.task.id);
  const base = `/v1/projects/${p.projectId}/first-copy`;
  const current = data(await request("GET", base, p.buyer.token), 200);
  assert.equal(current.book.state, "ready");
  return { ...p, story, base, book: current.book };
}
export async function readyReservedFirstCopy() {
  const p = await readyFirstCopyBook();
  const address = data(
    await request("POST", p.base + "/address", p.buyer.token, {
      expectedVersion: 0,
      recipientName: "合成收件人",
      phone: "13800000000",
      regionCode: "CN-110000",
      detail: "合成地址一号",
    }),
  );
  const binding = {
    bookVersionId: p.book.id,
    snapshotHash: p.book.snapshotHash,
    pdfHash: p.book.pdf.sha256,
    addressHash: address.address.hash,
  };
  for (const role of ["narrator", "initiator"]) {
    data(
      await request(
        "POST",
        p.base + "/confirmations",
        role === "narrator" ? p.narrator.token : p.buyer.token,
        {
          role,
          ...binding,
          ...(role === "narrator" ? { addressHash: undefined } : {}),
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:${randomUUID()}`,
        },
      ),
    );
  }
  const originalSubmitKey = randomUUID();
  const reserved = data(
    await request(
      "POST",
      p.base + "/submit",
      p.buyer.token,
      binding,
      originalSubmitKey,
    ),
  );
  return { ...p, binding, originalSubmitKey, order: reserved.production };
}
