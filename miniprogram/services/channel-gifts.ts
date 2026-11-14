import type { ChannelGiftView } from "../../packages/contracts/src";
import { sessionClient } from "./session";
export const channelGiftClient = {
  list() {
    return sessionClient.request<ChannelGiftView[]>("/channel-gifts");
  },
};
