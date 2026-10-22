import type { PlanContent, TemplateReference } from "@timenook/contracts";

export interface BuiltinTemplate {
  id: string;
  version: number;
  reviewStatus: TemplateReference["reviewStatus"];
  content: PlanContent;
}

// Original synthetic copy for engineering verification only. D09 editorial and
// user trials have not been completed; this is not an approved sales default.
export const BUILTIN_TEMPLATE: BuiltinTemplate = {
  id: "timenook-default",
  version: 1,
  reviewStatus: "unreviewed-test-only",
  content: {
    chapters: [
      {
        key: "places",
        title: "记得的地方",
        questions: [
          {
            key: "remembered-place",
            text: "有没有一个地方，你现在还想说说它的样子？",
            intent: "从本人选择的地点回忆一个具体场景",
            optionalContext: [],
            sensitivityTags: [],
            followupCandidates: [],
            locale: "zh-CN",
          },
        ],
      },
      {
        key: "everyday-moments",
        title: "生活里的片段",
        questions: [
          {
            key: "small-moment",
            text: "最近想到的一件小事，你愿意从哪里讲起？",
            intent: "由本人选择一段生活片段作为讲述起点",
            optionalContext: [],
            sensitivityTags: [],
            followupCandidates: [],
            locale: "zh-CN",
          },
        ],
      },
      {
        key: "words-to-keep",
        title: "想留下的话",
        questions: [
          {
            key: "words-for-today",
            text: "如果留下一段话，此刻你想说些什么？",
            intent: "保留本人愿意表达的想法，不指定对象或经历",
            optionalContext: [],
            sensitivityTags: [],
            followupCandidates: [],
            locale: "zh-CN",
          },
        ],
      },
    ],
    starters: [
      {
        kind: "photo",
        text: "选一张你愿意聊聊的照片，从你记得的地方说起。",
        intent: "以本人选择的照片引出回忆，不推断照片中的事实",
      },
      {
        kind: "free-narration",
        text: "不选问题也可以，从你现在想说的事情开始。",
        intent: "由本人自由决定讲述主题",
      },
    ],
  },
};
