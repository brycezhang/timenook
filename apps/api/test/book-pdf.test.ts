import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { startProductionWorker } from "../src/tasks/worker";
import { createOpenApiDocument, createApplication } from "../src/application";
import { ProductionTasks } from "../src/tasks/tasks";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  db,
  root,
  bound,
  choose,
  login,
  request,
  data,
  readyStory,
  storyPhoto,
  restartBookApplication,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("book context requires real participation and returns an immutable-input token without inventing stories", async () => {
  const p = await bound();
  data((await choose(p, p.narrator.token, "collection", true)).response);
  const base = `/v1/projects/${p.projectId}/book`;
  assert.equal((await request("GET", base)).statusCode, 401);
  assert.equal(
    (await request("GET", base, (await login()).token)).statusCode,
    403,
  );
  const context = data(await request("GET", base, p.narrator.token), 200);
  assert.equal(context.current, null);
  assert.deepEqual(context.eligibleStories, []);
  assert.match(context.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: context.inputHash,
      })
    ).statusCode,
    409,
  );
});

async function confirmedStory(
  existing?: Awaited<ReturnType<typeof bound>>,
  withPhoto = false,
  long = false,
  text?: string,
  materials?: {
    caption?: string;
    portrait?: boolean;
    notes?: { id: string; text: string }[];
  },
) {
  const p = await readyStory(existing);
  const photo = withPhoto
    ? await storyPhoto(
        p,
        materials?.caption ?? "合成照片：那年家门前的红墙",
        materials?.portrait ? { width: 120, height: 180 } : undefined,
      )
    : null;
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
        paragraphs: text
          ? [{ text, sourceRefs: p.story.revision.paragraphs[0].sourceRefs }]
          : long
            ? [
                {
                  text: "我记得那时候，家门前有一面红墙，夏天常听到树上的蝉声。".repeat(
                    100,
                  ),
                  sourceRefs: p.story.revision.paragraphs[0].sourceRefs,
                },
                {
                  text: "后来搬家的日子，我把这些往事一件件记了下来，仍然记得大家笑着说话的样子。".repeat(
                    60,
                  ),
                  sourceRefs: p.story.revision.paragraphs[0].sourceRefs,
                },
              ]
            : p.story.revision.paragraphs,
        ...(photo ? { photoSnapshotId: photo.id } : {}),
        reviewResolutions: p.story.revision.reviewItems.map((item: string) => ({
          item,
          reason: "本人核对后保留约略年代",
        })),
        notes: materials?.notes ?? [],
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
        evidenceRef: `synthetic:本人确认-${randomUUID()}`,
      },
    ),
  );
  return { ...p, story };
}
test("generation freezes one current permitted revision and stable original-audio entry under concurrent replay", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}/book`;
  const context = data(await request("GET", base, p.narrator.token), 200);
  assert.equal(context.eligibleStories.length, 1);
  const key = randomUUID(),
    body = { expectedInputHash: context.inputHash };
  const [a, b] = await Promise.all([
    request("POST", base + "/versions", p.narrator.token, body, key),
    request("POST", base + "/versions", p.narrator.token, body, key),
  ]);
  const book = data(a, 202);
  assert.equal(data(b, 202).id, book.id);
  assert.equal(
    book.snapshot.chapters[0].stories[0].revisionId,
    p.story.revision.id,
  );
  assert.deepEqual(
    book.snapshot.chapters[0].stories[0].paragraphs,
    p.story.revision.paragraphs.map((p: any) => p.text),
  );
  assert.match(
    book.snapshot.chapters[0].stories[0].entry.id,
    /^[A-Za-z0-9_-]{22}$/,
  );
  assert.equal(book.snapshot.chapters[0].stories[0].audio.length, 2);
  assert.equal(book.snapshot.specification.productionReady, false);
  assert.match(
    book.snapshot.chapters[0].stories[0].provenance.label,
    /AI整理.*人工校对/,
  );
  const current = data(await request("GET", base, p.buyer.token), 200).current;
  assert.equal(current.snapshotHash, book.snapshotHash);
  assert.equal(
    (
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: "0".repeat(64),
      })
    ).statusCode,
    409,
  );
});

test("the shared worker renders a complete frozen PDF and its authorized download has the inspected hash and real pages", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}/book`;
  const context = data(await request("GET", base, p.narrator.token), 200);
  const book = data(
    await request("POST", base + "/versions", p.narrator.token, {
      expectedInputHash: context.inputHash,
    }),
    202,
  );
  await app.get(ProductionTasks).run(book.task.id);
  const current = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready", JSON.stringify(current.task));
  assert.ok(current.pageCount >= 4);
  const downloaded = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(downloaded.statusCode, 200);
  assert.match(downloaded.headers["content-type"]!, /^application\/pdf/);
  assert.equal(
    createHash("sha256").update(downloaded.rawPayload).digest("hex"),
    current.pdf.sha256,
  );
  assert.equal(downloaded.rawPayload.length, current.pdf.bytes);
  assert.equal(
    (await request("GET", base + `/versions/${book.id}/pdf`)).statusCode,
    401,
  );
});

test("a frozen book rejects a changed original-entry or provenance configuration rather than delivering an old file", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}/book`,
    ctx = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  const previous = config.books!.entryBaseUrl;
  config.books!.entryBaseUrl = "https://changed.invalid/timenook/audio/";
  try {
    const changed = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
    assert.equal(changed.state, "obsolete");
    await app.get(ProductionTasks).run(book.task.id);
    assert.equal(
      (
        await request(
          "GET",
          base + `/versions/${book.id}/pdf`,
          p.narrator.token,
        )
      ).statusCode,
      409,
    );
  } finally {
    config.books!.entryBaseUrl = previous;
  }
});

test("the actual directory omits empty chapters and the full long manuscript retains photographs, captions and one original-code per story", async () => {
  const p = await confirmedStory(undefined, true, true),
    second = await confirmedStory(p),
    base = `/v1/projects/${p.projectId}/book`;
  const initial = data(await request("GET", base, p.narrator.token), 200);
  data(
    await request("POST", base + "/directory", p.narrator.token, {
      expectedVersion: initial.directory.version,
      chapters: [
        { key: "empty", title: "不应补写的空章节", storyRefs: [] },
        { key: "later", title: "后来的日子", storyRefs: [second.story.id] },
        { key: "childhood", title: "家门前的红墙", storyRefs: [p.story.id] },
      ],
    }),
  );
  const contextBeforeCover = data(
      await request("GET", base, p.narrator.token),
      200,
    ),
    context = data(
      await request("POST", base + "/cover", p.narrator.token, {
        expectedVersion: contextBeforeCover.cover.version,
        salutation: "献给这些年一路相伴的家人",
        photoAssetId: contextBeforeCover.coverPhotoOptions[0].assetId,
      }),
    ),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
  assert.deepEqual(
    book.snapshot.chapters.map((c: any) => c.title),
    ["后来的日子", "家门前的红墙"],
  );
  await Promise.all([
    app.get(ProductionTasks).run(book.task.id),
    app.get(ProductionTasks).run(book.task.id),
  ]);
  const done = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(done.state, "ready", JSON.stringify(done.task));
  assert.ok(done.pageCount > 6);
  assert.equal(
    done.snapshot.chapters[1].stories[0].photos[0].caption,
    "合成照片：那年家门前的红墙",
  );
  assert.equal(done.snapshot.chapters[1].stories[0].audio.length, 2);
  const pdf = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200);
  assert.equal(
    createHash("sha256").update(pdf.rawPayload).digest("hex"),
    done.pdf.sha256,
  );
  if (process.env.T20_ARTIFACT_DIR) {
    // Preserve the actual independently inspected render for the human visual pass; no assertion depends on this layout.
    await cp(
      join(config.books!.storageRoot, book.id, "1"),
      process.env.T20_ARTIFACT_DIR,
      { recursive: true, errorOnExist: true, force: false },
    );
  }
});

test("future questions preserve a frozen book while actual directory changes obsolete it and force a new exact snapshot", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}`,
    ctx = data(await request("GET", base + "/book", p.narrator.token), 200),
    book = data(
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  const plan = data(
    await request("GET", base + "/plan", p.narrator.token),
    200,
  );
  const chapters = structuredClone(plan.chapters);
  chapters[0].questions[0].text = "以后想聊聊哪一件小事？";
  data(
    await request("POST", base + "/plan", p.narrator.token, {
      expectedVersion: plan.revision,
      content: { chapters, starters: plan.starters },
    }),
  );
  const same = data(
    await request("GET", base + `/book/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(same.state, "queued");
  assert.equal(same.snapshotHash, book.snapshotHash);
  assert.equal(same.snapshot.plan.revision, 1);
  const changed = data(
    await request("POST", base + "/book/directory", p.narrator.token, {
      expectedVersion: ctx.directory.version,
      chapters: [
        { key: "my-days", title: "我的那些日子", storyRefs: [p.story.id] },
      ],
    }),
  );
  assert.equal(changed.current.state, "obsolete");
  assert.equal(
    (
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      })
    ).statusCode,
    409,
  );
  const next = data(
    await request("POST", base + "/book/versions", p.narrator.token, {
      expectedInputHash: changed.inputHash,
    }),
    202,
  );
  assert.equal(next.version, 2);
  assert.equal(next.snapshot.plan.revision, 2);
  assert.equal(next.snapshot.chapters[0].title, "我的那些日子");
  assert.equal(
    next.snapshot.chapters[0].stories[0].entry.id,
    book.snapshot.chapters[0].stories[0].entry.id,
  );
  assert.deepEqual(
    data(
      await request(
        "GET",
        base + `/book/versions/${book.id}`,
        p.narrator.token,
      ),
      200,
    ).snapshot,
    book.snapshot,
  );
});

test("cover renaming and a new unconfirmed story revision invalidate the old book without copying any confirmation", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}`,
    ctx = data(await request("GET", base + "/book", p.narrator.token), 200),
    book = data(
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  data(
    await request("POST", base + "/metadata", p.narrator.token, {
      expectedVersion: 0,
      bookTitle: "后来那些年",
    }),
  );
  assert.equal(
    data(
      await request(
        "GET",
        base + `/book/versions/${book.id}`,
        p.narrator.token,
      ),
      200,
    ).state,
    "obsolete",
  );
  const current = data(
      await request("GET", base + "/book", p.narrator.token),
      200,
    ),
    next = data(
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: current.inputHash,
      }),
      202,
    );
  assert.equal(next.snapshot.cover.title, "后来那些年");
  data(
    await request(
      "POST",
      base + `/stories/${p.story.id}/revisions`,
      p.narrator.token,
      {
        baseRevisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        title: p.story.revision.title,
        theme: p.story.revision.theme,
        paragraphs: [
          { ...p.story.revision.paragraphs[0], text: "我后来又想起了一件事。" },
        ],
        reviewResolutions: p.story.revision.reviewResolutions,
        notes: [],
      },
    ),
  );
  assert.equal(
    data(
      await request(
        "GET",
        base + `/book/versions/${next.id}`,
        p.narrator.token,
      ),
      200,
    ).state,
    "obsolete",
  );
  const unconfirmed = data(
    await request("GET", base + "/book", p.narrator.token),
    200,
  );
  assert.deepEqual(unconfirmed.eligibleStories, []);
  assert.equal(
    (
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: unconfirmed.inputHash,
      })
    ).statusCode,
    409,
  );
});

test("sharing revocation rejects an initiator's PDF and replay and fences the old pending book", async () => {
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}/book`,
    ctx = data(await request("GET", base, p.buyer.token), 200),
    key = randomUUID(),
    body = { expectedInputHash: ctx.inputHash },
    book = data(
      await request("POST", base + "/versions", p.buyer.token, body, key),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const pdf = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.buyer.token,
  );
  assert.equal(pdf.statusCode, 200);
  data((await choose(p, p.narrator.token, "sharing", false)).response);
  assert.equal(
    (await request("GET", base + `/versions/${book.id}/pdf`, p.buyer.token))
      .statusCode,
    403,
  );
  assert.equal(
    (await request("POST", base + "/versions", p.buyer.token, body, key))
      .statusCode,
    403,
  );
  const narrator = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(narrator.statusCode, 409);
  assert.equal(
    data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    ).state,
    "obsolete",
  );
});

test("the same durable render task resumes after API restart and Redis queue loss", async () => {
  // Earlier independent cases intentionally leave queued books. This recovery
  // proof owns a fresh disposable fixture, not a deadline for that backlog.
  await stopBookFixture();
  await startBookFixture();
  const p = await confirmedStory(),
    base = `/v1/projects/${p.projectId}/book`,
    ctx = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 }),
    queue = new Queue("tasks", {
      connection,
      prefix: `${config.redisKeyPrefix}:production`,
    });
  try {
    await queue.waitUntilReady();
    await queue.add("wake", { taskId: book.task.id }, { jobId: book.task.id });
    await app.get(ProductionTasks).delivered(book.task.id);
    assert.ok((await queue.getWaitingCount()) >= 1);
    await queue.obliterate({ force: true });
    assert.equal(await queue.getWaitingCount(), 0);
  } finally {
    await queue.close();
    connection.disconnect();
  }
  await restartBookApplication();
  const runtime = await startProductionWorker(app);
  try {
    const completed: string[] = [];
    const wake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void db.productionTask
          .findMany({
            where: { projectId: p.projectId },
            select: {
              id: true,
              state: true,
              kind: true,
              errorCode: true,
              nextRunAt: true,
              leaseUntil: true,
            },
          })
          .then(
            (tasks) =>
              reject(
                Error(
                  `render worker timeout: ${JSON.stringify({ completed, tasks })}`,
                ),
              ),
            (error) => reject(error),
          );
      }, 90000);
      runtime.worker.on("completed", (job) => {
        completed.push(job.data.taskId);
        if (job.data.taskId === book.task.id) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.equal(await runtime.recoverDue(), 1);
    await wake;
    const done = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
    assert.equal(done.id, book.id);
    assert.equal(done.state, "ready", JSON.stringify(done.task));
    assert.equal(done.snapshotHash, book.snapshotHash);
    await app.get(ProductionTasks).run(book.task.id);
    const replay = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
    assert.deepEqual(replay.pdf, done.pdf);
  } finally {
    await runtime.close();
  }
});

test("book routes remain disabled without explicit isolated admission and expose the frozen HTTP contract when enabled", async () => {
  const source = createOpenApiDocument(app);
  for (const route of [
    "/v1/projects/{id}/book",
    "/v1/projects/{id}/book/versions",
    "/v1/projects/{id}/book/versions/{versionId}/pdf",
  ])
    assert.ok(source.paths[route]);
  await assert.rejects(
    createApplication({ ...config, environment: "production" }),
  );
  await assert.rejects(
    createApplication({
      ...config,
      books: {
        ...config.books!,
        entryBaseUrl: "https://user:secret@example.invalid/timenook/audio/",
      },
    }),
  );
  const disabled = await createApplication({
    environment: "test",
    host: "127.0.0.1",
    port: 3431,
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
  });
  try {
    assert.equal(
      (
        await disabled.inject({
          method: "GET",
          url: `/v1/projects/${randomUUID()}/book`,
        })
      ).statusCode,
      404,
    );
  } finally {
    await disabled.close();
  }
});

test("book-PDF retention independently rejects the frozen file while other source retention remains active", async () => {
  const template = await db.packageVersion.findFirstOrThrow({
      where: { realm: "local", purpose: "local_preview" },
    }),
    snapshot = structuredClone(template.snapshot) as any;
  snapshot.admission.d03.retention.bookPdf.duration.value = 1;
  const draftId = randomUUID(),
    versionId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: versionId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成PDF期限套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await confirmedStory(await bound(versionId)),
    base = `/v1/projects/${p.projectId}/book`,
    ctx = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  assert.equal(
    (await request("GET", base + `/versions/${book.id}/pdf`, p.narrator.token))
      .statusCode,
    200,
  );
  // Controlled expired-delivery fixture only; not an actual fulfilment event.
  await db.projectServiceEvent.create({
    data: {
      projectId: p.projectId,
      eventId: `synthetic-delivery:${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt: new Date(Date.now() - 86400001),
    },
  });
  assert.equal(
    (await request("GET", base + `/versions/${book.id}/pdf`, p.narrator.token))
      .statusCode,
    403,
  );
  assert.equal((await request("GET", base, p.narrator.token)).statusCode, 403);
});

test("bounded preparation rejects aggregate print-image bytes before starting a PDF child", async () => {
  const previous = config.books!.maxPhotoBytes;
  config.books!.maxPhotoBytes = 1;
  try {
    const p = await confirmedStory(undefined, true),
      base = `/v1/projects/${p.projectId}/book`,
      ctx = data(await request("GET", base, p.narrator.token), 200),
      book = data(
        await request("POST", base + "/versions", p.narrator.token, {
          expectedInputHash: ctx.inputHash,
        }),
        202,
      );
    await app.get(ProductionTasks).run(book.task.id);
    const done = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
    assert.equal(done.state, "failed");
    assert.equal(done.task.errorCode, "BOOK_IMAGE_INPUT_LIMIT");
    assert.equal(done.pdf, null);
    assert.equal(
      (
        await request(
          "POST",
          `/v1/projects/${p.projectId}/tasks/${book.task.id}/retry`,
          p.narrator.token,
          { assistedSessionId: randomUUID() },
        )
      ).statusCode,
      403,
    );
    for (let i = 0; i < 2; i++) {
      data(
        await request(
          "POST",
          base + `/versions/${book.id}/retry`,
          p.narrator.token,
          {},
        ),
        202,
      );
      await app.get(ProductionTasks).run(book.task.id);
      assert.equal(
        data(
          await request("GET", base + `/versions/${book.id}`, p.narrator.token),
          200,
        ).state,
        "failed",
      );
    }
    assert.equal(
      (
        await request(
          "POST",
          base + `/versions/${book.id}/retry`,
          p.narrator.token,
          {},
        )
      ).statusCode,
      409,
    );
  } finally {
    if (previous === undefined) delete config.books!.maxPhotoBytes;
    else config.books!.maxPhotoBytes = previous;
  }
});

test("body mentions of page numbers and the page header remain complete in the rendered story", async () => {
  const p = await confirmedStory(
      undefined,
      false,
      false,
      "我在第1页写下门前的那条路。书稿预览 · 制作规格待核验，是我当时记下的话。",
    ),
    base = `/v1/projects/${p.projectId}/book`,
    ctx = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const done = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(done.state, "ready", JSON.stringify(done.task));
  assert.equal(
    (await request("GET", base + `/versions/${book.id}/pdf`, p.narrator.token))
      .statusCode,
    200,
  );
});

test("generation replay and render retry retain the same applicable material expiry as a fresh book read", async () => {
  const previous = config.books!.maxPhotoBytes;
  config.books!.maxPhotoBytes = 1;
  try {
    const p = await confirmedStory(undefined, true),
      base = `/v1/projects/${p.projectId}/book`,
      ctx = data(await request("GET", base, p.narrator.token), 200),
      key = randomUUID(),
      body = { expectedInputHash: ctx.inputHash },
      book = data(
        await request("POST", base + "/versions", p.narrator.token, body, key),
        202,
      );
    await app.get(ProductionTasks).run(book.task.id);
    // Controlled near-expiry fixture, independent of real delivery or commercial policy.
    const expiresAt = new Date(Date.now() + 60000),
      occurredAt = new Date(expiresAt.getTime() - 400 * 86400000);
    await db.projectServiceEvent.create({
      data: {
        projectId: p.projectId,
        eventId: `synthetic-delivery:${randomUUID()}`,
        kind: "delivery_completed",
        occurredAt,
      },
    });
    const read = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
    assert.equal(read.accessExpiresAt, expiresAt.toISOString());
    assert.equal(
      data(
        await request("POST", base + "/versions", p.narrator.token, body, key),
        202,
      ).accessExpiresAt,
      read.accessExpiresAt,
    );
    assert.equal(
      data(
        await request(
          "POST",
          base + `/versions/${book.id}/retry`,
          p.narrator.token,
          {},
        ),
        202,
      ).accessExpiresAt,
      read.accessExpiresAt,
    );
  } finally {
    if (previous === undefined) delete config.books!.maxPhotoBytes;
    else config.books!.maxPhotoBytes = previous;
  }
});

async function inspectDownloadedBook(bytes: Uint8Array) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/⻔/g, "门")
      .replace(/⻚/g, "页")
      .replace(/⻓/g, "长")
      .replace(/\s/g, "");
  const pages: { text: string; images: number }[] = [];
  try {
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number),
        content = await page.getTextContent(),
        operators = await page.getOperatorList();
      let text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("")
        .replace(/^书稿预览 · 制作规格待核验/, "")
        .replace(new RegExp(`第${number}[页⻚]$`), "");
      pages.push({
        text: normalize(text),
        images: operators.fnArray.filter((op) =>
          [
            OPS.paintImageXObject,
            OPS.paintInlineImageXObject,
            OPS.paintImageXObjectRepeat,
          ].includes(op),
        ).length,
      });
      page.cleanup();
    }
    return { pages, text: pages.map((p) => p.text).join(""), normalize };
  } finally {
    await document.destroy();
  }
}
async function preserveReviewBook(bookId: string, name: string) {
  if (process.env.T20_REVIEW_ARTIFACT_DIR)
    await cp(
      join(config.books!.storageRoot, bookId, "1"),
      join(process.env.T20_REVIEW_ARTIFACT_DIR, name),
      { recursive: true, errorOnExist: true, force: false },
    );
}
test("a valid portrait photograph and300-character caption flow across pages in the confirmed full book", async () => {
  const ending = "这就是照片说明的最后一句。",
    caption =
      (
        "这一张照片的说明开始。" +
        "这幅照片记录了我年轻时家门前的红墙和每天走过的那条路。".repeat(20)
      ).slice(0, 300 - ending.length) + ending,
    note = "这是紧随照片说明的本人补充。";
  const p = await confirmedStory(undefined, true, false, undefined, {
      caption,
      portrait: true,
      notes: [{ id: randomUUID(), text: note }],
    }),
    base = `/v1/projects/${p.projectId}/book`,
    context = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const current = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready", JSON.stringify(current.task));
  const pdf = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200);
  const inspected = await inspectDownloadedBook(pdf.rawPayload);
  assert.equal(inspected.pages.length, current.pageCount);
  assert.ok(inspected.text.includes(inspected.normalize(caption)));
  assert.ok(
    inspected.text.indexOf(inspected.normalize(caption)) <
      inspected.text.indexOf(inspected.normalize(note)),
  );
  const first = inspected.pages.findIndex((p) =>
      p.text.includes(inspected.normalize(caption.slice(0, 20))),
    ),
    last = inspected.pages.findIndex((p) =>
      p.text.includes(inspected.normalize(caption.slice(-20))),
    );
  assert.ok(last > first);
  assert.ok(
    inspected.pages.slice(0, first + 1).reduce((n, p) => n + p.images, 0) >= 2,
  );
  await preserveReviewBook(book.id, "portrait-caption");
});
test("a valid4500-character participant note is complete across actual PDF pages", async () => {
  const note =
    "那一年我把这些日子一件件记下，想把大家笑着说话的样子也留在书里。"
      .repeat(200)
      .slice(0, 4500);
  const p = await confirmedStory(undefined, false, false, undefined, {
      notes: [{ id: randomUUID(), text: note }],
    }),
    base = `/v1/projects/${p.projectId}/book`,
    context = data(await request("GET", base, p.narrator.token), 200),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const current = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready", JSON.stringify(current.task));
  const pdf = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200);
  const inspected = await inspectDownloadedBook(pdf.rawPayload);
  assert.equal(inspected.pages.length, current.pageCount);
  assert.ok(inspected.text.includes(inspected.normalize(note)));
  assert.ok(current.pageCount > 7);
  await preserveReviewBook(book.id, "participant-note");
});

test("cover settings freeze an allowed salutation and photo and invalidate an earlier book on optimistic change", async () => {
  const p = await confirmedStory(undefined, true, false, undefined, {
      portrait: true,
    }),
    base = `/v1/projects/${p.projectId}/book`,
    context = data(await request("GET", base, p.narrator.token), 200);
  assert.deepEqual(context.cover, {
    version: 0,
    salutation: "",
    photoAssetId: null,
  });
  assert.equal(context.coverPhotoOptions.length, 1);
  const photo = context.coverPhotoOptions[0];
  assert.equal(photo.interviewId, p.interviewId);
  assert.ok(photo.bytes > 0);
  const before = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: context.inputHash,
      }),
      202,
    ),
    body = {
      expectedVersion: 0,
      salutation: "献给我亲爱的家人",
      photoAssetId: photo.assetId,
    },
    key = randomUUID();
  const [a, b] = await Promise.all([
    request("POST", base + "/cover", p.narrator.token, body, key),
    request("POST", base + "/cover", p.narrator.token, body, key),
  ]);
  const saved = data(a);
  assert.deepEqual(data(b).cover, saved.cover);
  assert.equal(saved.cover.version, 1);
  assert.equal(saved.current.state, "obsolete");
  assert.equal(
    (await request("POST", base + "/cover", p.narrator.token, body)).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", base + "/cover", p.narrator.token, {
        ...body,
        expectedVersion: 1,
        photoAssetId: randomUUID(),
      })
    ).statusCode,
    400,
  );
  const next = data(
    await request("POST", base + "/versions", p.narrator.token, {
      expectedInputHash: saved.inputHash,
    }),
    202,
  );
  assert.equal(next.version, before.version + 1);
  assert.equal(next.snapshot.cover.salutation, body.salutation);
  assert.deepEqual(next.snapshot.cover.photo, photo);
  await app.get(ProductionTasks).run(next.task.id);
  const current = data(
    await request("GET", base + `/versions/${next.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready", JSON.stringify(current.task));
  const pdf = await request(
    "GET",
    base + `/versions/${next.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200);
  const inspected = await inspectDownloadedBook(pdf.rawPayload);
  assert.ok(
    inspected.pages[0].text.includes(inspected.normalize(body.salutation)),
  );
  assert.equal(inspected.pages[0].images, 1);
  assert.equal(
    inspected.pages.reduce((n, p) => n + p.images, 0),
    3,
  );
  const cleared = data(
    await request("POST", base + "/cover", p.buyer.token, {
      expectedVersion: 1,
      salutation: "另一份称呼",
      photoAssetId: null,
    }),
  );
  assert.equal(cleared.current.state, "obsolete");
  assert.equal(cleared.cover.version, 2);
  assert.deepEqual(
    data(
      await request("GET", base + `/versions/${next.id}`, p.narrator.token),
      200,
    ).snapshot,
    next.snapshot,
  );
  await preserveReviewBook(next.id, "cover-photo");
});

test("the fixed cover keeps a full120-character title and salutation with a portrait on the cover page", async () => {
  const p = await confirmedStory(undefined, true, false, undefined, {
      portrait: true,
    }),
    project = `/v1/projects/${p.projectId}`,
    base = project + "/book",
    title = "岁月中的那些人与事和家的故事".repeat(12).slice(0, 120),
    salutation = "献给这些年一起走过的家人和朋友".repeat(12).slice(0, 120);
  data(
    await request("POST", project + "/metadata", p.narrator.token, {
      expectedVersion: 0,
      bookTitle: title,
    }),
  );
  const context = data(await request("GET", base, p.narrator.token), 200),
    saved = data(
      await request("POST", base + "/cover", p.narrator.token, {
        expectedVersion: 0,
        salutation,
        photoAssetId: context.coverPhotoOptions[0].assetId,
      }),
    ),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: saved.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const current = data(
    await request("GET", base + `/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.equal(current.state, "ready", JSON.stringify(current.task));
  const pdf = await request(
    "GET",
    base + `/versions/${book.id}/pdf`,
    p.narrator.token,
  );
  assert.equal(pdf.statusCode, 200);
  const inspected = await inspectDownloadedBook(pdf.rawPayload);
  assert.ok(inspected.pages[0].text.includes(inspected.normalize(title)));
  assert.ok(inspected.pages[0].text.includes(inspected.normalize(salutation)));
  assert.equal(inspected.pages[0].images, 1);
  data(
    await request(
      "POST",
      project + `/stories/${p.story.id}/decisions`,
      p.narrator.token,
      {
        revisionId: p.story.revision.id,
        expectedVersion: p.story.version,
        contentHash: p.story.revision.contentHash,
        confirmed: true,
        allowInBook: false,
        noticeVersion: "synthetic-d08-v1",
        evidenceRef: `synthetic:本人取消入书-${randomUUID()}`,
      },
    ),
  );
  const noLongerAllowed = data(
    await request("GET", base, p.narrator.token),
    200,
  );
  assert.deepEqual(noLongerAllowed.coverPhotoOptions, []);
  assert.equal(noLongerAllowed.current.state, "obsolete");
  assert.equal(
    (
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: noLongerAllowed.inputHash,
      })
    ).statusCode,
    409,
  );
  await preserveReviewBook(book.id, "cover-max-text");
});

test("a ready PDF remains readable when its raw derived cover expires and reports separate preview access", async (t) => {
  const template = await db.packageVersion.findFirstOrThrow({
      where: { realm: "local", purpose: "local_preview" },
    }),
    snapshot = structuredClone(template.snapshot) as any;
  snapshot.admission.d03.retention.derivedPhotos.duration.value = 1;
  const draftId = randomUUID(),
    versionId = randomUUID();
  await db.packageDraft.create({
    data: { id: draftId, realm: "local", ...snapshot },
  });
  await db.packageVersion.create({
    data: {
      id: versionId,
      realm: "local",
      purpose: "local_preview",
      draftId,
      draftRevision: 1,
      snapshot,
      publicOffer: {
        title: "合成独立照片期限套餐",
        price: { value: 99900, unit: "fen", currency: "CNY" },
      },
    },
  });
  const p = await confirmedStory(await bound(versionId), true),
    base = `/v1/projects/${p.projectId}/book`,
    context = data(await request("GET", base, p.narrator.token), 200),
    photo = context.coverPhotoOptions[0],
    saved = data(
      await request("POST", base + "/cover", p.narrator.token, {
        expectedVersion: 0,
        salutation: "献给家人",
        photoAssetId: photo.assetId,
      }),
    ),
    book = data(
      await request("POST", base + "/versions", p.narrator.token, {
        expectedInputHash: saved.inputHash,
      }),
      202,
    );
  await app.get(ProductionTasks).run(book.task.id);
  const expiresAt = new Date(Date.now() + 60000),
    occurredAt = new Date(expiresAt.getTime() - 86400000);
  // One controlled delivery fact; only JS Date advances past the declared raw-photo expiry.
  await db.projectServiceEvent.create({
    data: {
      projectId: p.projectId,
      eventId: `synthetic-delivery:${randomUUID()}`,
      kind: "delivery_completed",
      occurredAt,
    },
  });
  const image = `/v1/projects/${p.projectId}/interviews/${photo.interviewId}/photos/${photo.id}/assets/${photo.assetId}/content`,
    before = data(
      await request("GET", base + `/versions/${book.id}`, p.narrator.token),
      200,
    );
  assert.equal((await request("GET", image, p.narrator.token)).statusCode, 200);
  t.mock.timers.enable({ apis: ["Date"], now: expiresAt.getTime() + 1 });
  try {
    assert.equal(
      (await request("GET", image, p.narrator.token)).statusCode,
      403,
    );
    const after = data(
        await request("GET", base + `/versions/${book.id}`, p.narrator.token),
        200,
      ),
      current = data(await request("GET", base, p.narrator.token), 200).current,
      pdf = await request(
        "GET",
        base + `/versions/${book.id}/pdf`,
        p.narrator.token,
      );
    assert.equal(after.state, "ready");
    assert.equal(current.snapshotHash, before.snapshotHash);
    assert.equal(after.inputHash, before.inputHash);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(pdf.statusCode, 200);
    assert.equal(
      createHash("sha256").update(pdf.rawPayload).digest("hex"),
      before.pdf.sha256,
    );
    assert.deepEqual(after.coverPhotoAccess, {
      allowed: false,
      expiresAt: null,
    });
    assert.deepEqual(current.coverPhotoAccess, after.coverPhotoAccess);
    assert.deepEqual(before.coverPhotoAccess, {
      allowed: true,
      expiresAt: expiresAt.toISOString(),
    });
    assert.ok(Date.parse(before.accessExpiresAt) > expiresAt.getTime());
  } finally {
    t.mock.timers.reset();
  }
});
