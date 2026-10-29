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
  wake: (declareExpected: (ids: readonly string[]) => void) => Promise<unknown>,
  idleMs = 5000,
) {
  const completed = new Set<string>();
  let pending: Set<string> | undefined;
  let closed = false;
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
          `Worker made no progress: ${pending ? (pending.size ? [...pending].join(",") : "dispatch") : "scheduling"}`,
        ),
      );
    }, idleMs);
  }
  function declareExpected(ids: readonly string[]) {
    if (closed) throw new Error("Worker wait has stopped");
    if (pending) throw new Error("Worker frontier is already declared");
    if (ids.some((id) => !id))
      throw new Error("Expected task IDs must be non-empty");
    pending = new Set(ids.filter((id) => !completed.has(id)));
    arm();
    if (!pending.size) resolveDone();
  }
  function onCompleted(job: Job) {
    if (!job.id) return;
    completed.add(job.id);
    if (pending?.delete(job.id)) {
      arm();
      if (pending.size === 0) resolveDone();
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
    await Promise.race([wake(declareExpected), stopped]);
    if (!pending)
      throw new Error("Worker scheduling did not declare expected tasks");
    if (!pending.size) return;
    await Promise.race([done, stopped]);
  } finally {
    closed = true;
    clearTimeout(timer);
    worker.off("completed", onCompleted);
    worker.off("failed", onFailed);
    worker.off("error", onError);
  }
}
