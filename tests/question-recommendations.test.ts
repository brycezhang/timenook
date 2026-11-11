import assert from "node:assert/strict";
import { test } from "node:test";
import type { FamilyQuestion, PersonalPlan } from "../packages/contracts/src";
import { QuestionRecommendations } from "../miniprogram/services/question-recommendations";
const family = (
  id: string,
  state: FamilyQuestion["state"] = "ready",
  story: FamilyQuestion["story"] = null,
): FamilyQuestion => ({
  id,
  projectId: "p",
  version: 1,
  text: id,
  chapterKey: null,
  authorId: "a",
  authorNickname: "小陈",
  authorRelationship: "女儿",
  state,
  createdAt: "2026-11-11",
  story,
});
const plan = {
  chapters: [
    {
      key: "c",
      title: "童年",
      storyRefs: [],
      questions: ["o1", "o2"].map((key) => ({
        key,
        text: key,
        sensitivityTags: [],
      })),
    },
  ],
  preferences: { blockedTopics: [] },
  answers: [],
  questionStates: [],
} as unknown as PersonalPlan;
test("recommendation entry starts with family, mixes two to one, and never repeats within a round", () => {
  const session = new QuestionRecommendations(() => 0);
  const first = session.update(plan, [
    family("f1"),
    family("f2"),
    family("f3"),
    family("f4"),
  ]);
  const shown = [first, ...Array.from({ length: 5 }, () => session.next())];
  assert.deepEqual(
    shown.map((q) => q!.kind),
    ["family", "family", "outline", "family", "family", "outline"],
  );
  assert.equal(new Set(shown.map((q) => q!.id)).size, 6);
  assert.equal(first!.source, "女儿 · 小陈的提问");
  assert.equal(session.next()!.kind, "family");
});
test("later stays excluded across rounds until a new entry, while answered and skipped never enter", () => {
  const session = new QuestionRecommendations(() => 0);
  const questions = [
    family("later", "later"),
    family("answered", "ready", { id: "story", title: "故事" }),
    family("skip", "skipped"),
  ];
  assert.equal(session.update(plan, questions)!.key, "later");
  session.defer("family:later");
  session.restore("family:later");
  for (let n = 0; n < 8; n++) assert.equal(session.next()!.kind, "outline");
  assert.equal(
    new QuestionRecommendations(() => 0).update(plan, questions)!.key,
    "later",
  );
  session.update(
    {
      ...plan,
      answers: [
        { questionKey: "o1", storyId: "s1", chapterKey: "c" },
        { questionKey: "o2", storyId: "s2", chapterKey: "c" },
      ],
    },
    questions,
  );
  assert.equal(session.next(), null);
});
