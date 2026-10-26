import { participationClient } from "./participation";
/** Visible private views fail closed when the server can no longer verify their access. */
export function watchProjectAccess(
  projectId: string,
  current: () => boolean,
  revoked: () => void,
  expectedEpoch = -1,
): () => void {
  let stopped = false,
    epoch = expectedEpoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      if (stopped || !current()) return;
      try {
        const permission = await participationClient.state(projectId);
        if (stopped || !current()) return;
        if (
          !permission.canRead ||
          (epoch >= 0 && permission.accessEpoch !== epoch)
        )
          throw Error("Access changed");
        epoch = permission.accessEpoch;
        schedule();
      } catch {
        if (!stopped && current()) revoked();
      }
    }, 1000);
    // Node's public timer has unref; WeChat's timer is a number.
    const unref = Reflect.get(Object(timer), "unref");
    if (typeof unref === "function") unref.call(timer);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
