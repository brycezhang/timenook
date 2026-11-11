import type {
  FamilyQuestion,
  FamilyQuestions,
  ProjectMemberProfile,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
import { recordingId } from "./local-audio-recorder";
import { interviewRecordingClient } from "./interview-recording";
import { go } from "./store";
export const familyQuestionClient = {
  list(projectId: string) {
    return sessionClient.request<FamilyQuestions>(
      `/projects/${projectId}/family-questions`,
    );
  },
  read(projectId: string, id: string) {
    return sessionClient.request<FamilyQuestion>(
      `/projects/${projectId}/family-questions/${id}`,
    );
  },
  profile(projectId: string) {
    return sessionClient.request<ProjectMemberProfile>(
      `/projects/${projectId}/member-profile`,
    );
  },
  relationship(projectId: string, relationship: string) {
    return sessionClient.request<ProjectMemberProfile>(
      `/projects/${projectId}/member-profile`,
      { key: paymentKey(), data: { relationship } },
    );
  },
  create(
    projectId: string,
    clientQuestionId: string,
    text: string,
    chapterKey: string | null,
  ) {
    return sessionClient.request<FamilyQuestion>(
      `/projects/${projectId}/family-questions`,
      { key: paymentKey(), data: { clientQuestionId, text, chapterKey } },
    );
  },
  edit(question: FamilyQuestion, text: string, chapterKey: string | null) {
    return sessionClient.request<FamilyQuestion>(
      `/projects/${question.projectId}/family-questions/${question.id}`,
      {
        key: paymentKey(),
        data: { expectedVersion: question.version, text, chapterKey },
      },
    );
  },
  state(question: FamilyQuestion, state: FamilyQuestion["state"]) {
    return sessionClient.request<FamilyQuestion>(
      `/projects/${question.projectId}/family-questions/${question.id}/state`,
      { key: paymentKey(), data: { expectedVersion: question.version, state } },
    );
  },
  remove(question: FamilyQuestion) {
    return sessionClient.request<{ removed: true }>(
      `/projects/${question.projectId}/family-questions/${question.id}/remove`,
      { key: paymentKey(), data: { expectedVersion: question.version } },
    );
  },
};
export function familyQuestionSource(
  question: Pick<FamilyQuestion, "authorNickname" | "authorRelationship">,
) {
  return `${question.authorRelationship} · ${question.authorNickname}的提问`;
}
export function familyQuestionState(question: FamilyQuestion) {
  return question.story
    ? "已回答"
    : { ready: "待回答", later: "稍后回答", skipped: "已跳过" }[question.state];
}
export async function startFamilyAnswer(
  projectId: string,
  revision: number,
  familyQuestionId: string,
) {
  const interview = await interviewRecordingClient.start(
    projectId,
    {
      clientInterviewId: recordingId(),
      expectedPlanRevision: revision,
      familyQuestionId,
    },
    paymentKey(),
  );
  go(
    "interview",
    `projectId=${projectId}&interviewId=${interview.id}&prepare=1`,
  );
}
