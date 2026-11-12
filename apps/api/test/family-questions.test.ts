import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import * as f from "./book-fixture";
before(f.startBookFixture);
after(f.stopBookFixture);

test("a family answer becomes a saved unassigned story, follows chapter moves, and survives deleting its question", async () => {
  const p = await f.joinedProject();
  const base = `/v1/projects/${p.projectId}`;
  const questions = `${base}/family-questions`;
  let question = f.data(
    await f.request("POST", questions, p.narrator.token, {
      clientQuestionId: randomUUID(),
      text: "小时候有哪些难忘的事情？",
      chapterKey: null,
    }),
  );
  const saved = await f.readyStory(p, { familyQuestionId: question.id });
  assert.equal(saved.story.chapter, null);
  await f.projectPhoto(p);
  const overview = f.data(
    await f.request("GET", `${base}/overview`, p.narrator.token),
    200,
  );
  assert.equal(overview.summary.confirmed, 1);
  assert.equal(overview.summary.photos, 1);
  assert.equal(overview.summary.audioMinutes, 0);
  question = f.data(
    await f.request("GET", `${questions}/${question.id}`, p.buyer.token),
    200,
  );
  assert.equal(question.story.id, saved.story.id);
  assert.equal(question.chapterKey, null);
  question = f.data(
    await f.request("POST", `${questions}/${question.id}`, p.buyer.token, {
      expectedVersion: question.version,
      text: "记忆里有哪些难忘的事情？",
      chapterKey: "childhood",
    }),
  );
  assert.equal(question.chapterKey, "childhood");
  assert.equal(
    f.data(
      await f.request(
        "GET",
        `${base}/stories/${saved.story.id}`,
        p.narrator.token,
      ),
      200,
    ).chapter.key,
    "childhood",
  );
  const plan = f.data(
    await f.request("GET", `${base}/plan`, p.narrator.token),
    200,
  );
  f.data(
    await f.request("POST", `${base}/plan`, p.narrator.token, {
      expectedVersion: plan.revision,
      content: {
        starters: plan.starters,
        chapters: plan.chapters.map((ch: any) => ({
          ...ch,
          storyRefs: ch.key === "learning" ? [saved.story.id] : [],
        })),
      },
    }),
  );
  question = f.data(
    await f.request("GET", `${questions}/${question.id}`, p.narrator.token),
    200,
  );
  assert.equal(question.chapterKey, "learning");
  f.data(
    await f.request(
      "POST",
      `${questions}/${question.id}/remove`,
      p.buyer.token,
      { expectedVersion: question.version },
    ),
  );
  const story = f.data(
    await f.request(
      "GET",
      `${base}/stories/${saved.story.id}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(story.revision.id, saved.story.revision.id);
  assert.equal(story.chapter.key, "learning");
  const interview = f.data(
    await f.request(
      "GET",
      `${base}/interviews/${saved.interviewId}`,
      p.narrator.token,
    ),
    200,
  );
  assert.equal(interview.actualQuestion.source.familyQuestionId, question.id);
  assert.equal(
    interview.actualQuestion.snapshot.text,
    "小时候有哪些难忘的事情？",
  );
});

test("all family question responses provide the envelope required by native clients", async () => {
  const p = await f.joinedProject();
  const path = `/v1/projects/${p.projectId}/family-questions`;
  async function request(
    method: "GET" | "POST",
    url: string,
    body?: Record<string, unknown>,
  ) {
    const response = await f.request(method, url, p.narrator.token, body);
    const result = f.data(response, method === "GET" ? 200 : 201);
    assert.equal(typeof response.json().meta?.requestId, "string");
    assert.ok(response.json().meta.requestId.length > 0);
    return result;
  }
  await request("GET", path);
  let question = await request("POST", path, {
    clientQuestionId: randomUUID(),
    text: "哪段时光最难忘？",
  });
  question = await request("GET", `${path}/${question.id}`);
  question = await request("POST", `${path}/${question.id}`, {
    expectedVersion: question.version,
    text: "哪段童年时光最难忘？",
  });
  question = await request("POST", `${path}/${question.id}/state`, {
    expectedVersion: question.version,
    state: "later",
  });
  await request("POST", `${path}/${question.id}/remove`, {
    expectedVersion: question.version,
  });
});
