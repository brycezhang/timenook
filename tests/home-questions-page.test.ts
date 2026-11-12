import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harness,
  base,
  projectId,
  login,
  overview,
  context,
  tick,
} from "./helpers/senior-page";
import { offer } from "./purchase-fixture";
const questionId = "77777777-7777-4777-8777-777777777777";
const membership = {
  projectId,
  bookTitle: "合成回忆",
  state: "active",
  categories: ["sent"],
  isSelfGift: false,
  giverNickname: "小陈",
  giftRelationship: "妈妈",
  storyCount: 0,
};
const plan = (id = projectId) => ({
  projectId: id,
  revision: 3,
  chapters: [
    {
      key: "childhood",
      title: "童年与家",
      storyRefs: [],
      questions: [
        { key: "q1", text: "童年的家是什么样的？", sensitivityTags: [] },
      ],
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
const question = (id = projectId) => ({
  id: questionId,
  projectId: id,
  version: 1,
  text: "小时候在哪里玩？",
  chapterKey: null,
  authorId: "original-author",
  authorNickname: "小陈",
  authorRelationship: "女儿",
  state: "ready",
  story: null,
});

test("home displays real totals, starts the displayed family question and keeps zero-count entries available", async () => {
  const h = harness("home");
  h.page.onLoad();
  const show = h.page.onShow();
  h.respond(0, login.user);
  await tick();
  h.respond(1, { projects: [membership] });
  await tick();
  h.respond(2, {
    ...overview(),
    canRecord: true,
    summary: {
      confirmed: 0,
      pending: 2,
      included: 0,
      photos: 0,
      audioMinutes: 12,
    },
  });
  h.respond(3, plan());
  h.respond(4, { projectId, questions: [question()] });
  await show;
  h.respond(5, context(null));
  await tick();
  assert.equal(h.page.data.overview.summary.confirmed, 0);
  assert.equal(h.page.data.overview.summary.photos, 0);
  assert.equal(h.page.data.overview.summary.audioMinutes, 12);
  assert.equal(h.page.data.question.source, "女儿 · 小陈的提问");
  assert.equal(h.page.data.familyPending, 1);
  assert.equal(h.page.data.giftCaption, "小陈送给妈妈的时光故事书");
  h.page.stories();
  h.page.photos();
  h.page.book();
  h.page.family();
  assert.deepEqual(
    h.routes.map((r: string) => r.split("?")[0]),
    [
      "/pages/stories/index",
      "/pages/photos/index",
      "/pages/book/index",
      "/pages/family-questions/index",
    ],
  );
  const record = h.page.record();
  assert.equal(h.requests[6].data.familyQuestionId, questionId);
  h.respond(6, { id: "actual-interview" });
  await record;
  assert.match(h.routes[4], /interviewId=actual-interview&prepare=1/);
  h.page.nextQuestion();
  assert.equal(h.page.data.question.kind, "outline");
});

test("switching projects replaces the recommendation and author source", async () => {
  const h = harness("home");
  h.page.onLoad();
  const second = "88888888-8888-4888-8888-888888888888";
  const show = h.page.onShow();
  h.respond(0, login.user);
  await tick();
  h.respond(1, {
    projects: [membership, { ...membership, projectId: second }],
  });
  await tick();
  h.respond(2, overview());
  h.respond(3, plan());
  h.respond(4, { projectId, questions: [question()] });
  await show;
  h.respond(5, context(null));
  await tick();
  h.storage.set(
    `timenook.live-project.v1:${login.user.id}:${login.session.id}`,
    second,
  );
  const again = h.page.onShow();
  h.respond(6, login.user);
  await tick();
  h.respond(7, {
    projects: [membership, { ...membership, projectId: second }],
  });
  await tick();
  h.respond(8, { ...overview(), projectId: second });
  h.respond(9, plan(second));
  h.respond(10, {
    projectId: second,
    questions: [
      {
        ...question(second),
        id: "another",
        authorNickname: "小李",
        authorRelationship: "孙子",
      },
    ],
  });
  await again;
  assert.equal(h.page.data.question.key, "another");
  assert.equal(h.page.data.question.source, "孙子 · 小李的提问");
});

test("public home uses the current checkout amount and disables unavailable offers", async () => {
  const h = harness("home");
  h.storage.delete(`timenook.session.v1:${base}`);
  h.page.onLoad();
  const show = h.page.onShow();
  await tick();
  h.respond(0, {
    ...offer,
    reason: "E2E_ONLY",
    checkout: { ...offer.checkout, amount: 1, isE2e: true },
    version: { ...offer.version, purpose: "e2e" },
  });
  await show;
  assert.equal(h.page.data.price, "0.01");
  h.page.purchase();
  assert.equal(h.page.data.loginVisible, true);
  h.page.closeLogin();
  const refresh = h.page.loadOffer();
  h.respond(1, {
    purchasable: false,
    reason: "PACKAGE_PREPARING",
    version: null,
  });
  await refresh;
  assert.equal(h.page.data.price, "");
  h.page.purchase();
  assert.equal(h.page.data.loginVisible, false);
  assert.deepEqual(h.routes, []);
});
