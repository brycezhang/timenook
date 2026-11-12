import type { FirstCopyBinding } from "../../packages/contracts/src";
import { API_BASE_URL } from "../config";
import { sessionClient } from "./session";

export interface PrintIntent {
  binding: FirstCopyBinding;
  key: string;
  title: string;
  version: number;
}
const storageKey = (projectId: string, owner = sessionClient.context()) =>
  `timenook.print-intent.v1:${API_BASE_URL}:${owner}:${projectId}`;
export const printIntent = {
  read(projectId: string): PrintIntent | null {
    return wx.getStorageSync(storageKey(projectId)) || null;
  },
  save(projectId: string, intent: PrintIntent) {
    wx.setStorageSync(storageKey(projectId), intent);
  },
  clear(projectId: string, owner = sessionClient.context()) {
    wx.removeStorageSync(storageKey(projectId, owner));
  },
};
