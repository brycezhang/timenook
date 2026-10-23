import type {
  PersonalPlan,
  PlanContent,
  PlanQuestionState,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";

function validate(plan: PersonalPlan, projectId: string): PersonalPlan {
  if (
    !plan ||
    plan.projectId !== projectId ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    !Array.isArray(plan.chapters) ||
    !plan.chapters.every(
      (c) =>
        typeof c.key === "string" &&
        typeof c.title === "string" &&
        Array.isArray(c.questions) &&
        c.questions.every(
          (q) => typeof q.key === "string" && typeof q.text === "string",
        ),
    ) ||
    !Array.isArray(plan.starters) ||
    !plan.preferences ||
    !Number.isSafeInteger(plan.preferences.version) ||
    !Array.isArray(plan.preferences.blockedTopics) ||
    !Array.isArray(plan.questionStates) ||
    !Array.isArray(plan.actualQuestions) ||
    !["self", "assisted", null].includes(plan.subjectDecision) ||
    (plan.accessExpiresAt !== null &&
      !Number.isFinite(Date.parse(plan.accessExpiresAt)))
  )
    throw new Error("计划数据无效，请重新查询");
  return plan;
}
export const personalPlanClient = {
  async read(projectId: string) {
    if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error("项目编号无效");
    return validate(
      await sessionClient.request<PersonalPlan>(`/projects/${projectId}/plan`),
      projectId,
    );
  },
  async revise(plan: PersonalPlan, content: PlanContent) {
    return validate(
      await sessionClient.request<PersonalPlan>(
        `/projects/${plan.projectId}/plan`,
        {
          key: paymentKey(),
          data: { expectedVersion: plan.revision, content },
        },
      ),
      plan.projectId,
    );
  },
  async decide(
    plan: PersonalPlan,
    questionStates: PlanQuestionState[],
    blockedTopics: string[],
  ) {
    return validate(
      await sessionClient.request<PersonalPlan>(
        `/projects/${plan.projectId}/plan/preferences`,
        {
          key: paymentKey(),
          data: {
            expectedVersion: plan.preferences.version,
            questionStates,
            blockedTopics,
            ...(plan.subjectDecision === "assisted"
              ? { assistedSessionId: plan.decisionSessionId }
              : {}),
          },
        },
      ),
      plan.projectId,
    );
  },
};
