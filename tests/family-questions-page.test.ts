import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harness,
  projectId,
  storyId,
  overview,
  tick,
  login,
} from "./helpers/senior-page";
const questionId = "77777777-7777-4777-8777-777777777777";
const question = (patch = {}) => ({
  id: questionId,
  projectId,
  text: "小时候最喜欢在哪里玩？",
  version: 1,
  chapterKey: null,
  authorId: "family-author",
  authorNickname: "小陈",
  authorRelationship: "女儿",
  state: "ready",
  story: null,
  createdAt: "2026-11-11",
  ...patch,
});
const plan = () => ({
  projectId,
  revision: 3,
  chapters: [
    {
      key: "childhood",
      title: "童年与家",
      storyRefs: [],
      questions: Array.from({ length: 10 }, (_, n) => ({
        key: `q${n}`,
        text: `童年问题${n}`,
        sensitivityTags: [],
      })),
    },
  ],
  starters: [],
  preferences: { version: 1, blockedTopics: [] },
  questionStates: [],
  actualQuestions: [],
  answers: [],
  subjectDecision: "member",
  accessExpiresAt: null,
});
const profile = {
  projectId,
  userId: login.user.id,
  nickname: "小陈",
  relationship: null,
  isNarrator: false,
};

test("family form fills the purchaser's relationship and saves text without a chapter", async () => {
  const h = harness("family-question-edit");
  h.page.onLoad({ projectId, chapter: "childhood" });
  const show = h.page.onShow();
  h.respond(0, plan());
  h.respond(1, overview());
  h.respond(2, profile);
  await show;
  assert.equal(h.page.data.needsRelationship, true);
  assert.equal(h.page.data.chapterIndex, 1);
  h.page.chapter({ detail: { value: "0" } });
  h.page.input({
    currentTarget: { dataset: { field: "text" } },
    detail: { value: question().text },
  });
  h.page.relationship({ currentTarget: { dataset: { value: "女儿" } } });
  const save = h.page.save();
  assert.match(h.requests[3].url, /member-profile$/);
  assert.equal(h.requests[3].data.relationship, "女儿");
  h.respond(3, { ...profile, relationship: "女儿" });
  await tick();
  assert.match(h.requests[4].url, /family-questions$/);
  assert.equal(h.requests[4].data.chapterKey, null);
  assert.equal(h.requests[4].data.text, question().text);
  assert.equal(h.requests[4].data.authorId, undefined);
  h.respond(4, question());
  await save;
  assert.match(h.routes[0], /family-question\/index.*id=77777777/);
});
test("editing someone else's question displays its original source and never rewrites author fields", async () => {
  const h = harness("family-question-edit");
  h.page.onLoad({ projectId, id: questionId });
  const show = h.page.onShow();
  h.respond(0, plan());
  h.respond(1, overview());
  h.respond(2, { ...profile, relationship: "孙子" });
  h.respond(3, question());
  await show;
  assert.equal(h.page.data.source, "女儿 · 小陈的提问");
  assert.equal(h.page.data.needsRelationship, false);
  h.page.input({
    currentTarget: { dataset: { field: "text" } },
    detail: { value: "童年的朋友都有谁？" },
  });
  const save = h.page.save();
  assert.deepEqual(Object.keys(h.requests[4].data).sort(), [
    "chapterKey",
    "expectedVersion",
    "text",
  ]);
  h.respond(4, question({ version: 2, text: "童年的朋友都有谁？" }));
  await save;
  assert.equal(h.routes[0], "back");
});
test("family list filters answers and opens the real associated story from answered detail", async () => {
  const h = harness("family-questions");
  h.page.onLoad({ projectId });
  const show = h.page.onShow();
  h.respond(0, {
    projectId,
    questions: [
      question(),
      question({ id: "answered", story: { id: storyId, title: "门前的老树" } }),
      question({ id: "later", state: "later" }),
      question({ id: "skipped", state: "skipped" }),
    ],
  });
  h.respond(1, plan());
  await show;
  assert.equal(h.page.data.questions.length, 2);
  h.page.tab({ currentTarget: { dataset: { tab: "answered" } } });
  assert.equal(h.page.data.questions[0].story.id, storyId);
  const detail = harness("family-question");
  detail.page.onLoad({ projectId, id: questionId });
  const loaded = detail.page.onShow();
  detail.respond(0, question({ story: { id: storyId, title: "门前的老树" } }));
  detail.respond(1, plan());
  await loaded;
  detail.page.story();
  assert.equal(
    detail.routes[0],
    `/pages/story/index?projectId=${projectId}&storyId=${storyId}`,
  );
});
test("family detail creates an interview for the selected question before entering recording preparation", async () => {
  const h = harness("family-question");
  h.page.onLoad({ projectId, id: questionId });
  const show = h.page.onShow();
  h.respond(0, question());
  h.respond(1, plan());
  await show;
  const answer = h.page.answer();
  assert.equal(h.requests[2].data.familyQuestionId, questionId);
  assert.equal(h.requests[2].data.expectedPlanRevision, 3);
  assert.equal(h.requests[2].data.starterKind, undefined);
  h.respond(2, { id: "interview" });
  await answer;
  assert.equal(
    h.routes[0],
    `/pages/interview/index?projectId=${projectId}&interviewId=interview&prepare=1`,
  );
});
test("chapter includes ten outline questions and one family question and carries its optional chapter into asking", async () => {
  const h = harness("chapter-outline");
  h.page.onLoad({ projectId, chapter: "childhood" });
  const show = h.page.onShow();
  h.respond(0, plan());
  h.respond(1, overview());
  h.respond(2, {
    projectId,
    questions: [question({ chapterKey: "childhood" })],
  });
  await show;
  assert.equal(h.page.data.questions.length, 11);
  assert.equal(h.page.data.outlineQuestions.length, 10);
  assert.equal(h.page.data.questions[10].source, "女儿 · 小陈的提问");
  h.page.question({
    currentTarget: { dataset: { id: questionId, kind: "family" } },
  });
  assert.match(h.routes[0], /family-question\/index/);
  h.page.askFamily();
  assert.match(h.routes[1], /family-question-edit\/index.*chapter=childhood/);
});
