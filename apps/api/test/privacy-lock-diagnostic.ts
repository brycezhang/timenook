import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import native from "fs-ext";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";

type Phase =
  | "preparation"
  | "realpath"
  | "local_queue"
  | "lock_file"
  | "native_acquisition"
  | "fixed_inode"
  | "authenticated_work"
  | "work_complete"
  | "native_unlock"
  | "lock_close";
type Metric = { count: number; totalMs: number; maxMs: number };
type Context = {
  consumer?: string;
  stream?: { id: number; closed: boolean | null };
  generation?: number;
};
type Operation = {
  id: number;
  instance: number;
  method: string;
  root: string;
  start: number;
  phase: Phase;
  phaseAt: number;
  phases: Partial<Record<Phase, number>>;
  io: Record<string, Metric>;
  pending: Map<number, { phase: string; start: number }>;
  nativeAcquired: boolean;
  nativeReleased: boolean;
  budgetMs: number;
  context: Context;
  scope?: Scope;
};
type Scope = {
  key: string;
  id: number;
  operations: Set<Operation>;
  owner?: Operation;
};
const operation = new AsyncLocalStorage<Operation>();
const method = new AsyncLocalStorage<string>();
const scopes = new Map<string, Scope>();
const active = new Set<Operation>();
const instances = new WeakMap<object, number>();
const failures = new WeakMap<object, ReturnType<typeof failure>>();
const handles = new WeakSet<object>();
const recent: ReturnType<typeof summary>[] = [];
let installed = false,
  sequence = 0,
  instanceSequence = 0,
  scopeSequence = 0,
  ioSequence = 0;
type ReadContext = (journal: object) => Context;
function observe(action: () => void) {
  try {
    action();
  } catch {
    /* Observation cannot change I/O results. */
  }
}
const rounded = (value: number) => Math.max(0, Math.round(value));
function phase(o: Operation, next: Phase) {
  const now = performance.now();
  o.phases[o.phase] = (o.phases[o.phase] ?? 0) + now - o.phaseAt;
  o.phase = next;
  o.phaseAt = now;
}
function summary(o: Operation) {
  return {
    id: o.id,
    instance: o.instance,
    scope: o.scope?.id,
    method: o.method,
    consumer: ["assertHealthy", "assertReplayed"].includes(
      o.context.consumer ?? "",
    )
      ? o.context.consumer
      : "unknown",
    stream: o.context.stream
      ? { id: o.context.stream.id, closed: o.context.stream.closed }
      : "unknown",
    generation: o.context.generation,
    lastObservedPhase: o.phase,
    elapsedMs: rounded(performance.now() - o.start),
    budgetMs: o.budgetMs,
    phasesMs: Object.fromEntries(
      Object.entries(o.phases).map(([key, value]) => [key, rounded(value)]),
    ),
  };
}
function details(o: Operation) {
  const view = summary(o);
  view.phasesMs[o.phase] = rounded(
    (o.phases[o.phase] ?? 0) + performance.now() - o.phaseAt,
  );
  return {
    ...view,
    nativeAcquisitionCallbackSucceeded: o.nativeAcquired,
    nativeUnlockCallbackSucceeded: o.nativeReleased,
    nativeHeldCallbackObserved: o.nativeAcquired && !o.nativeReleased,
    io: Object.fromEntries(
      Object.entries(o.io).map(([key, value]) => [
        key,
        {
          count: value.count,
          totalMs: rounded(value.totalMs),
          maxMs: rounded(value.maxMs),
        },
      ]),
    ),
    pendingIo: [...o.pending.values()].slice(0, 4).map((item) => ({
      phase: item.phase,
      elapsedMs: rounded(performance.now() - item.start),
    })),
  };
}
function failure(o: Operation) {
  return {
    operation: details(o),
    localOwnerWhenReported: o.scope?.owner
      ? details(o.scope.owner)
      : ("unknown" as const),
    activeOperations: active.size,
    scopeOperations: o.scope?.operations.size,
    recent: recent.slice(-4),
    availableParallelism: availableParallelism(),
    uid: process.getuid?.(),
  };
}
export function privacyLockFailure(error: unknown) {
  return error && typeof error === "object" ? failures.get(error) : undefined;
}
/** Bounded state inspection for the observer's own tests, never source access. */
export function privacyLockDiagnosticState() {
  return { active: active.size, scopes: scopes.size, recent: recent.length };
}
function beginIo(o: Operation, name: string) {
  const id = ++ioSequence,
    start = performance.now();
  o.pending.set(id, { phase: name, start });
  return () => {
    o.pending.delete(id);
    const ms = performance.now() - start,
      metric = (o.io[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    metric.count++;
    metric.totalMs += ms;
    metric.maxMs = Math.max(metric.maxMs, ms);
  };
}
function isLock(o: Operation, path: unknown) {
  return path === join(o.root, "lock");
}
function observePromise<T>(
  o: Operation,
  name: string,
  call: () => Promise<T>,
  after?: (value: T) => void,
): Promise<T> {
  const finish = beginIo(o, name);
  let promise: Promise<T>;
  try {
    promise = call();
  } catch (error) {
    observe(finish);
    throw error;
  }
  return promise.then(
    (value) => {
      observe(finish);
      observe(() => after?.(value));
      return value;
    },
    (error) => {
      observe(finish);
      throw error;
    },
  );
}
function instrumentHandle(handle: fs.FileHandle, lock: boolean) {
  if (handles.has(handle)) return;
  handles.add(handle);
  for (const name of [
    "readFile",
    "writeFile",
    "stat",
    "sync",
    "close",
  ] as const) {
    const original = handle[name];
    Reflect.set(
      handle,
      name,
      function (this: fs.FileHandle, ...args: unknown[]) {
        const o = operation.getStore();
        if (o && lock && name === "close") phase(o, "lock_close");
        return o
          ? observePromise(o, `${lock ? "lock" : "source"}.${name}`, () =>
              Reflect.apply(original, this, args),
            )
          : Reflect.apply(original, this, args);
      },
    );
  }
}
/** Test-only observation: original filesystem/native calls, values, errors and
 * callback arguments pass through. It never reads an additional source file,
 * retries, resets a deadline/failed latch, or publishes success logs. */
export function installPrivacyLockDiagnostic(
  readContext: ReadContext = () => ({}),
) {
  if (installed) return;
  installed = true;
  for (const name of [
    "open",
    "lstat",
    "realpath",
    "readdir",
    "link",
    "unlink",
    "rename",
  ] as const) {
    const original = fs[name];
    Reflect.set(fs, name, function (this: unknown, ...args: unknown[]) {
      const o = operation.getStore();
      if (!o) return Reflect.apply(original, this, args);
      const lock = isLock(o, args[0]);
      if (name === "realpath" && args[0] === o.root) phase(o, "realpath");
      if (name === "open" && lock) {
        phase(o, "lock_file");
        if (o.scope) o.scope.owner = o;
      }
      return observePromise(
        o,
        lock ? `lock.${name}` : name,
        () => Reflect.apply(original, this, args),
        (value: unknown) => {
          if (
            name === "realpath" &&
            args[0] === o.root &&
            typeof value === "string"
          ) {
            let scope = scopes.get(value);
            if (!scope) {
              scope = {
                key: value,
                id: ++scopeSequence,
                operations: new Set(),
              };
              scopes.set(value, scope);
            }
            scope.operations.add(o);
            o.scope = scope;
            phase(o, "local_queue");
          }
          if (name === "open") instrumentHandle(value as fs.FileHandle, lock);
        },
      );
    });
  }
  const flock = native.flock;
  Reflect.set(native, "flock", function (this: unknown, ...args: unknown[]) {
    const o = operation.getStore();
    const [fd, action, callback] = args;
    if (
      !o ||
      !["exnb", "un"].includes(String(action)) ||
      typeof callback !== "function"
    )
      return Reflect.apply(flock, this, args);
    phase(o, action === "un" ? "native_unlock" : "native_acquisition");
    const finish = beginIo(o, action === "un" ? "flock.unlock" : "flock.exnb");
    return Reflect.apply(flock, this, [
      fd,
      action,
      function (this: unknown, ...values: unknown[]) {
        observe(finish);
        // Submitting a native call is not evidence of acquiring/releasing it.
        if (!values[0] && action === "exnb")
          observe(() => {
            o.nativeAcquired = true;
            phase(o, "fixed_inode");
          });
        if (!values[0] && action === "un")
          observe(() => {
            o.nativeReleased = true;
          });
        return Reflect.apply(callback, this, values);
      },
    ]);
  });
  for (const name of ["snapshot", "append"] as const) {
    const original = PrivacyJournal.prototype[name];
    Reflect.set(
      PrivacyJournal.prototype,
      name,
      function (this: PrivacyJournal, ...args: unknown[]) {
        return method.run(name, () => Reflect.apply(original, this, args));
      },
    );
  }
  const exclusive = Reflect.get(PrivacyJournal.prototype, "exclusive");
  Reflect.set(
    PrivacyJournal.prototype,
    "exclusive",
    function (this: PrivacyJournal, work: () => Promise<unknown>) {
      if (!instances.has(this)) instances.set(this, ++instanceSequence);
      const started = performance.now(),
        utilization = performance.eventLoopUtilization();
      let captured: Context = {};
      observe(() => {
        captured = readContext(this);
      });
      const o: Operation = {
        id: ++sequence,
        instance: instances.get(this)!,
        method: method.getStore() ?? "source",
        root: Reflect.get(this, "root"),
        start: started,
        phase: "preparation",
        phaseAt: started,
        phases: {},
        io: {},
        pending: new Map(),
        nativeAcquired: false,
        nativeReleased: false,
        budgetMs: Reflect.get(this, "timeout"),
        context: captured,
      };
      active.add(o);
      return operation.run(o, async () => {
        try {
          return await exclusive.call(this, async () => {
            phase(o, "authenticated_work");
            const value = await work();
            phase(o, "work_complete");
            return value;
          });
        } catch (error) {
          if (error && typeof error === "object") {
            observe(() => {
              const record = failure(o),
                elapsed = performance.eventLoopUtilization(utilization);
              Object.assign(record, {
                eventLoopActiveMs: rounded(elapsed.active),
                eventLoopIdleMs: rounded(elapsed.idle),
              });
              failures.set(error, record);
            });
          }
          throw error;
        } finally {
          observe(() => {
            phase(o, o.phase);
            recent.push(summary(o));
            if (recent.length > 4) recent.shift();
          });
          active.delete(o);
          o.pending.clear();
          if (o.scope) {
            o.scope.operations.delete(o);
            if (o.scope.owner === o) o.scope.owner = undefined;
            if (!o.scope.operations.size) scopes.delete(o.scope.key);
          }
        }
      });
    },
  );
}
