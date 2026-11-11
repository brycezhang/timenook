import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  startBookFixture,
  stopBookFixture,
  joinedProject,
  readyStory,
  request,
  data,
} from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);

test("one chapter identity links questions, saved stories and PDF; moves and deletion preserve actual recordings", async () => {
  const p = await readyStory(),
    base = `/v1/projects/${p.projectId}`;
  const read = async () =>
    data(await request("GET", base + "/plan", p.narrator.token), 200);
  const save = async (plan: any) =>
    data(
      await request("POST", base + "/plan", p.narrator.token, {
        expectedVersion: plan.revision,
        content: { chapters: plan.chapters, starters: plan.starters },
      }),
    );
  let plan = await read();
  assert.deepEqual(plan.chapters[0].storyRefs, [p.story.id]);
  assert.equal(p.story.chapter.key, "childhood");
  assert.equal(plan.answers[0].storyId, p.story.id);
  const captured = structuredClone(plan.actualQuestions);
  const question = plan.chapters[0].questions.shift();
  plan.chapters[1].questions.push(question);
  plan = await save(plan);
  assert.deepEqual(plan.chapters[0].storyRefs, []);
  assert.deepEqual(plan.chapters[1].storyRefs, [p.story.id]);
  assert.equal(
    data(
      await request("GET", base + `/stories/${p.story.id}`, p.narrator.token),
      200,
    ).chapter.key,
    "learning",
  );
  plan.chapters[1].storyRefs = [];
  plan.chapters[2].storyRefs = [p.story.id];
  plan = await save(plan);
  assert.ok(
    plan.chapters[2].questions.some((q: any) => q.key === "childhood-01"),
  );
  assert.ok(
    !plan.chapters[1].questions.some((q: any) => q.key === "childhood-01"),
  );
  assert.equal(plan.answers[0].chapterKey, "society");
  const ctx = data(await request("GET", base + "/book", p.narrator.token), 200);
  const book = data(
    await request("POST", base + "/book/versions", p.narrator.token, {
      expectedInputHash: ctx.inputHash,
    }),
    202,
  );
  assert.equal(book.snapshot.chapters.length, 1);
  assert.equal(book.snapshot.chapters[0].key, "society");
  plan.chapters = plan.chapters.filter((c: any) => c.key !== "society");
  plan = await save(plan);
  assert.deepEqual(plan.actualQuestions, captured);
  const preserved = data(
    await request("GET", base + `/stories/${p.story.id}`, p.narrator.token),
    200,
  );
  assert.equal(preserved.chapter, null);
  assert.equal(preserved.revision.id, p.story.revision.id);
  assert.equal(preserved.revision.sourceManifest.length, 2);
  assert.equal(plan.answers[0].chapterKey, null);
  const frozen = data(
    await request("GET", base + `/book/versions/${book.id}`, p.narrator.token),
    200,
  );
  assert.deepEqual(frozen.snapshot, book.snapshot);
});

test("free narration remains unassigned, exclusion is separate, and an empty directory never collects all stories", async () => {
  const project = await joinedProject(),
    p = await readyStory(project, { starterKind: "free-narration" });
  const base = `/v1/projects/${p.projectId}`;
  assert.equal(p.story.chapter, null);
  assert.equal(p.story.included, true);
  let ctx = data(await request("GET", base + "/book", p.narrator.token), 200);
  assert.ok(ctx.directory.chapters.every((c: any) => c.storyRefs.length === 0));
  assert.equal(
    (
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      })
    ).statusCode,
    409,
  );
  let plan = data(await request("GET", base + "/plan", p.narrator.token), 200);
  plan = data(
    await request("POST", base + "/plan", p.narrator.token, {
      expectedVersion: plan.revision,
      content: { chapters: [], starters: plan.starters },
    }),
  );
  ctx = data(await request("GET", base + "/book", p.narrator.token), 200);
  assert.deepEqual(ctx.directory.chapters, []);
  assert.equal(
    (
      await request("POST", base + "/book/versions", p.narrator.token, {
        expectedInputHash: ctx.inputHash,
      })
    ).statusCode,
    409,
  );
  const excluded = data(
    await request(
      "POST",
      base + `/stories/${p.story.id}/inclusion`,
      p.narrator.token,
      { expectedVersion: p.story.version, included: false },
    ),
  );
  assert.equal(excluded.included, false);
  assert.equal(excluded.chapter, null);
  const restored = data(
    await request(
      "POST",
      base + `/stories/${p.story.id}/inclusion`,
      p.narrator.token,
      { expectedVersion: excluded.version, included: true },
    ),
  );
  assert.equal(restored.included, true);
  assert.equal(restored.chapter, null);
});
