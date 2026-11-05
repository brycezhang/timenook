import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  data,
  request,
  restartBookApplication,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { Deletions } from "../src/care/deletions";
before(startBookFixture);
after(stopBookFixture);
test("maintenance and restart beyond 2099 preserve necessary sources, stories and the complete PDF", async (t) => {
  const p = await readyFirstCopyBook();
  const output = await db.bookOutput.findUniqueOrThrow({
    where: { bookId: p.book.id },
  });
  const path = join(config.books!.storageRoot, output.objectKey),
    pdf = await readFile(path);
  const future = new Date("2100-01-01T00:00:00.000Z");
  await db.session.updateMany({
    where: { userId: { in: [p.narrator.id, p.buyer.id] } },
    data: { expiresAt: new Date("2200-01-01T00:00:00Z") },
  });
  t.mock.timers.enable({ apis: ["Date"], now: future.getTime() });
  try {
    await app.get(Deletions).sweep();
    await restartBookApplication();
    await app.get(Deletions).sweep();
    const status = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/deletion-status`,
        p.narrator.token,
      ),
      200,
    );
    assert.equal(status.changes.length, 0);
    assert.equal(status.permanentProjectDeletion, false);
    const story = data(
      await request(
        "GET",
        `/v1/projects/${p.projectId}/stories/${p.story.id}`,
        p.narrator.token,
      ),
      200,
    );
    assert.ok(story.revision.paragraphs.length);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/projects/${p.projectId}/book/versions/${p.book.id}/pdf`,
          p.narrator.token,
        )
      ).statusCode,
      200,
    );
    assert.deepEqual(await readFile(path), pdf);
    const [sources] = await db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) n FROM formal_transcripts WHERE project_id=${p.projectId}::uuid AND text IS NOT NULL`;
    assert.ok(sources.n > 0n);
  } finally {
    t.mock.timers.reset();
  }
});
