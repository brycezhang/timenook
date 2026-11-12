import type { FamilyQuestion } from "../../packages/contracts/src";

export function familyQuestionSource(
  question: Pick<FamilyQuestion, "authorNickname" | "authorRelationship">,
) {
  return `${question.authorRelationship} · ${question.authorNickname}的提问`;
}
