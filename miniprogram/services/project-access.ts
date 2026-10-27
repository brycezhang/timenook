import type { ParticipationState } from "../../packages/contracts/src";
import { sessionClient } from "./session";
/** The current view chooses its authorization boundary; stopping cannot clear a newer view. */
export function watchPermission(
  current: () => boolean,
  permitted: () => Promise<boolean>,
  revoked: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (stopped || !current()) return;
      try {
        const allowed = await permitted();
        if (stopped || !current()) return;
        if (!allowed) throw Error("Access changed");
        schedule();
      } catch {
        if (!stopped && current()) revoked();
      }
    }, 1000);
    const unref = Reflect.get(Object(timer), "unref");
    if (typeof unref === "function") unref.call(timer);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
/** Read views need current content access and the same project epoch. */
export function watchProjectAccess(
  projectId: string,
  current: () => boolean,
  revoked: () => void,
  expectedEpoch = -1,
): () => void {
  let epoch = expectedEpoch;
  return watchPermission(
    current,
    async () => {
      const permission = await sessionClient.request<ParticipationState>(
        `/projects/${projectId}/participation`,
      );
      if (
        permission?.canRead !== true ||
        !Number.isSafeInteger(permission.accessEpoch) ||
        (epoch >= 0 && permission.accessEpoch !== epoch)
      )
        return false;
      epoch = permission.accessEpoch;
      return true;
    },
    revoked,
  );
}
