import type {
  GiftPreview,
  GiftSetup,
  GiftVerification,
  OwnedGift,
} from "../../packages/contracts/src";
import { USER_TERMS_VERSION } from "../../packages/contracts/src";
import { ApiFailure, sessionClient } from "./session";
import { paymentKey } from "./payments";

function cardToken(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiFailure("INVALID_GIFT", 404);
  return token;
}
export const giftClient = {
  current(projectId: string) {
    return sessionClient.request<GiftSetup>(`/projects/${projectId}/gift`);
  },
  issue(projectId: string, recipientName: string, recipientPhone: string) {
    return sessionClient.request<OwnedGift>(`/projects/${projectId}/gift`, {
      data: { recipientName, recipientPhone },
      key: paymentKey(),
    });
  },
  preview(token: string) {
    return sessionClient.publicRequest<GiftPreview>(
      `/gifts/${cardToken(token)}`,
    );
  },
  verify(token: string) {
    return sessionClient.request<GiftVerification>(
      `/gifts/${cardToken(token)}/verification`,
    );
  },
  claim(token: string) {
    return sessionClient.request<{ projectId: string; state: "claimed" }>(
      `/gifts/${cardToken(token)}/claim`,
      {
        data: { termsVersion: USER_TERMS_VERSION },
        key: paymentKey(),
      },
    );
  },
};
