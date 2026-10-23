import { sessionClient } from "./session";
import { paymentKey } from "./payments";
import type {
  OptionalFollowupView,
  RecordingInterview,
} from "../../packages/contracts/src";
const base = (projectId: string, interviewId: string) =>
  `/projects/${projectId}/interviews/${interviewId}`;
export const optionalFollowupClient = {
  request(
    projectId: string,
    interviewId: string,
    data: Record<string, unknown>,
    key: string,
  ) {
    return sessionClient.request<OptionalFollowupView>(
      `${base(projectId, interviewId)}/follow-up`,
      { key, data },
    );
  },
  status(projectId: string, interviewId: string, assistedSessionId?: string) {
    return sessionClient.request<OptionalFollowupView>(
      `${base(projectId, interviewId)}/follow-up/status`,
      {
        key: paymentKey(),
        data: assistedSessionId ? { assistedSessionId } : {},
      },
    );
  },
  display(
    projectId: string,
    interviewId: string,
    data: Record<string, unknown>,
    key: string,
  ) {
    return sessionClient.request<RecordingInterview>(
      `${base(projectId, interviewId)}/actual-question`,
      { key, data },
    );
  },
  finish(
    projectId: string,
    interviewId: string,
    data: Record<string, unknown>,
    key: string,
  ) {
    return sessionClient.request<OptionalFollowupView>(
      `${base(projectId, interviewId)}/follow-up/finish`,
      { key, data },
    );
  },
};
