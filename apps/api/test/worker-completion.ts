type Job = { id?: string };
export interface WorkerCompletionEvents {
  on(event: "completed", listener: (job: Job) => void): unknown;
  on(
    event: "failed",
    listener: (job: Job | undefined, error: Error) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "completed", listener: (job: Job) => void): unknown;
  off(
    event: "failed",
    listener: (job: Job | undefined, error: Error) => void,
  ): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** Wait for a finite real scheduling frontier, failing on stalled or failed work. */
export async function waitForWorkerJobs(
  worker: WorkerCompletionEvents,
  wake: () => Promise<readonly string[]>,
  idleMs = 5000,
) {
  const completed = new Set<string>();
  let pending: Set<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  let rejectStopped!: (error: Error) => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      rejectStopped(
        new Error(
          `Worker made no progress: ${pending ? [...pending].join(",") : "scheduling"}`,
        ),
      );
    }, idleMs);
  }
  function onCompleted(job: Job) {
    if (!job.id) return;
    completed.add(job.id);
    if (pending?.delete(job.id)) {
      if (pending.size === 0) resolveDone();
      else arm();
    }
  }
  function onFailed(job: Job | undefined, error: Error) {
    rejectStopped(
      new Error(`Worker job failed: ${job?.id ?? "unknown"}`, { cause: error }),
    );
  }
  function onError(error: Error) {
    rejectStopped(error);
  }
  worker.on("completed", onCompleted);
  worker.on("failed", onFailed);
  worker.on("error", onError);
  arm();
  try {
    const expected = await Promise.race([wake(), stopped]);
    if (expected.some((id) => !id))
      throw new Error("Expected task IDs must be non-empty");
    pending = new Set(expected.filter((id) => !completed.has(id)));
    if (!pending.size) return;
    arm();
    await Promise.race([done, stopped]);
  } finally {
    clearTimeout(timer);
    worker.off("completed", onCompleted);
    worker.off("failed", onFailed);
    worker.off("error", onError);
  }
}
