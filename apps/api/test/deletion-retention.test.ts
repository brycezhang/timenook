import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  project,
  data,
  request,
  restartBookApplication,
  formUpload,
  syntheticAudio,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { ProjectServiceTerms } from "../src/projects/service-terms";
import { Deletions } from "../src/care/deletions";
before(startBookFixture);
after(stopBookFixture);
test("derived-photo expiry and repeated cache cleanup preserve a fresh valid original-audio upload in the same project", async (t) => {
  const p = await readyFirstCopyBook(
    {},
    {},
    { derivedPhotos: 1, originalAudio: 30 },
    30,
  );
  const terms = new ProjectServiceTerms(config.databaseUrl),
    anchor = new Date();
  await terms.recordFact({
    projectId: p.projectId,
    eventId: "synthetic-category-cache-" + randomUUID(),
    kind: "delivery_completed",
    occurredAt: anchor,
  });
  await terms.close();
  const cutoff = new Date(anchor.getTime() + 86400000);
  await db.session.updateMany({
    where: { userId: p.narrator.id },
    data: { expiresAt: new Date(cutoff.getTime() + 86400000) },
  });
  t.mock.timers.enable({ apis: ["Date"], now: cutoff.getTime() });
  try {
    await app.get(Deletions).sweep(cutoff);
    assert.equal(
      (
        await db.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${p.projectId}::uuid AND categories ? 'derivedPhotos'`
      )[0].n,
      1n,
    );
    const audio = syntheticAudio(),
      base = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/clips`;
    const clip = data(
      await request("POST", base, p.narrator.token, {
        clientClipId: randomUUID(),
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
      }),
    );
    const form = data(
      await request("POST", `${base}/${clip.id}/upload`, p.narrator.token, {}),
    );
    await app.get(Deletions).sweep(new Date(cutoff.getTime() + 1));
    assert.equal(
      (await formUpload(app, form, audio, {}, p.narrator.token)).statusCode,
      204,
    );
  } finally {
    t.mock.timers.reset();
  }
});
test("the selected D03 category uses its original deadline before, at and after expiry and preserves an independently retained PDF across replay", async () => {
  const p = await readyFirstCopyBook({}, {}, { transcripts: 1, bookPdf: 20 });
  const terms = new ProjectServiceTerms(config.databaseUrl),
    anchor = new Date();
  await terms.recordFact({
    projectId: p.projectId,
    eventId: "synthetic-retention-delivery-" + randomUUID(),
    kind: "delivery_completed",
    occurredAt: anchor,
  });
  await terms.close();
  const cutoff = new Date(anchor.getTime() + 86400000),
    deletions = app.get(Deletions);
  await deletions.sweep(new Date(cutoff.getTime() - 1));
  assert.equal(
    (
      await db.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${p.projectId}::uuid`
    )[0].n,
    0n,
  );
  const output = await db.bookOutput.findUniqueOrThrow({
      where: { bookId: p.book.id },
    }),
    path = join(config.books!.storageRoot, output.objectKey),
    pdf = await readFile(path);
  await deletions.sweep(cutoff);
  const at = data(
    await request(
      "GET",
      `/v1/projects/${p.projectId}/deletion-status`,
      p.narrator.token,
    ),
    200,
  );
  const event = at.changes.find((e: any) =>
    e.categories.includes("transcripts"),
  );
  assert.ok(event);
  assert.equal(event.effectiveAt, cutoff.toISOString());
  assert.equal(at.permanentProjectDeletion, false);
  const [transcript] = await db.$queryRaw<
    { text: null }[]
  >`SELECT text FROM formal_transcripts WHERE project_id=${p.projectId}::uuid LIMIT 1`;
  assert.equal(transcript.text, null);
  const revisions = await db.$queryRaw<
    { source_manifest: null; paragraphs: unknown }[]
  >`SELECT source_manifest,paragraphs FROM story_revisions WHERE project_id=${p.projectId}::uuid`;
  assert.ok(
    revisions.every((r) => r.source_manifest === null && r.paragraphs !== null),
  );
  assert.deepEqual(
    await readFile(path),
    pdf,
    "source transcript expiry cannot cascade into the separate bookPdf lifetime",
  );
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
  await deletions.sweep(new Date(cutoff.getTime() + 1));
  await restartBookApplication();
  await app.get(Deletions).sweep(new Date(cutoff.getTime() + 60000));
  const events = await db.$queryRaw<
    { effective_at: Date }[]
  >`SELECT effective_at FROM privacy_deletions WHERE project_id=${p.projectId}::uuid AND categories ? 'transcripts'`;
  assert.equal(events.length, 1);
  assert.equal(events[0].effective_at.toISOString(), cutoff.toISOString());
});
test("downtime catch-up paginates beyond the first hundred projects and records external layers without claiming a receipt", async () => {
  const snapshot = JSON.parse(
    readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  for (const rule of Object.values(snapshot.admission.d03.retention) as any[])
    rule.duration.value = 30;
  for (const c of [
    "activeData",
    "derivedAudio",
    "historicalObjects",
    "backupCopies",
  ])
    snapshot.admission.d03.retention[c].duration.value = 1;
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
        title: "合成到期覆盖",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const projects = [];
  for (let n = 0; n < 102; n++) projects.push(await project(packageId));
  projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
  const target = projects[projects.length - 1],
    anchor = new Date(),
    terms = new ProjectServiceTerms(config.databaseUrl);
  await terms.recordFact({
    projectId: target.projectId,
    eventId: "synthetic-catchup-delivery-" + randomUUID(),
    kind: "delivery_completed",
    occurredAt: anchor,
  });
  await terms.close();
  const due = new Date(anchor.getTime() + 86400000);
  await app.get(Deletions).sweep(due);
  const state = data(
    await request(
      "GET",
      `/v1/projects/${target.projectId}/deletion-status`,
      target.buyer.token,
    ),
    200,
  );
  for (const category of [
    "activeData",
    "derivedAudio",
    "historicalObjects",
    "backupCopies",
  ])
    assert.ok(
      state.changes.some((e: any) => e.categories.includes(category)),
      category,
    );
  for (const [category, layer] of [
    ["historicalObjects", "object_history"],
    ["backupCopies", "backup"],
  ]) {
    const e = state.changes.find((e: any) => e.categories.includes(category));
    assert.equal(e.items.length, 1);
    assert.equal(e.items[0].layer, layer);
    assert.equal(e.items[0].state, "awaiting_evidence");
    assert.equal(e.items[0].deadline, due.toISOString());
  }
  assert.equal(state.permanentProjectDeletion, false);
  const [count] = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${target.projectId}::uuid`;
  assert.equal(count.n, 4n);
  await app.get(Deletions).sweep(new Date(due.getTime() + 60000));
  assert.equal(
    (
      await db.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) n FROM privacy_deletions WHERE project_id=${target.projectId}::uuid`
    )[0].n,
    4n,
  );
});
