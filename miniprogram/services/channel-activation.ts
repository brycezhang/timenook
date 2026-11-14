import type {
  ActivateChannelGiftCommand,
  ActivatedChannelGift,
  ChannelGiftReminders,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
import { go } from "./navigation";
export const channelActivationClient = {
  activate(id: string, body: ActivateChannelGiftCommand) {
    return sessionClient.request<ActivatedChannelGift>(
      `/channel-gifts/${id}/activate`,
      { data: { ...body }, key: paymentKey() },
    );
  },
  reminders() {
    return sessionClient.request<ChannelGiftReminders>(
      "/channel-gifts/reminders",
    );
  },
  handle(ids: string[]) {
    return sessionClient.request<ChannelGiftReminders>(
      "/channel-gifts/reminders/handle",
      { data: { ids }, key: paymentKey() },
    );
  },
};
let showing = false;
/** Called only on idle home/account pages, never during invitation, claim or recording. */
export async function checkChannelReminders(
  current: () => boolean,
  counts?: (count: number) => void,
) {
  const owner = sessionClient.context();
  if (!owner) return;
  const valid = () => owner === sessionClient.context() && current();
  const summary = await channelActivationClient.reminders();
  if (!valid()) return;
  counts?.(summary.pendingCount);
  if (!summary.newCount || showing) return;
  showing = true;
  try {
    const action = await wx.showModal({
      title: `你有 ${summary.newCount} 份新礼物待送出`,
      content: "可在「我的礼物」中查看。",
      confirmText: "查看",
      cancelText: "稍后",
    });
    if (!valid()) return;
    if (!action.confirm && !action.cancel) return;
    const result = await channelActivationClient.handle(summary.newGiftIds);
    if (!valid()) return;
    counts?.(result.pendingCount);
    if (action.confirm) go("projects", "category=sent");
  } finally {
    showing = false;
  }
}
