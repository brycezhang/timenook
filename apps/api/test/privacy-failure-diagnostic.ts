import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { constants } from "node:os";
import { PrivacyRights } from "../src/care/privacy-rights";
import { ProjectStreams } from "../src/media/project-streams";
import {
  PrivacyJournal,
  PrivacyJournalError,
} from "../src/privacy-journal/privacy-journal";

type Cause = {
  phase: string;
  elapsedMs: number;
  type?: string;
  code?: string;
  sqlState?: string;
  reason?: string;
};
// null: guard has not returned a Readable yet; absent context is "unknown".
type Stream = { id: number; closed: boolean | null };
const gate = new AsyncLocalStorage<{ cause?: Cause }>();
const stream = new AsyncLocalStorage<Stream>();
const generations = new WeakMap<object, number>();
const instances = new WeakMap<object, number>();
let installed = false,
  instanceSequence = 0,
  streamSequence = 0;
const field = (value: unknown, name: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, name) : undefined;
const types = new Set([
  "Error",
  "PrivacyJournalError",
  "ServiceUnavailableException",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError",
  "PrismaClientRustPanicError",
  "PrismaClientValidationError",
]);
const systemCodes = new Set(Object.keys(constants.errno));
const code = (value: unknown) =>
  typeof value === "string" &&
  (/^P[0-9]{4}$/.test(value) || systemCodes.has(value))
    ? value
    : undefined;
const journalReasons = new Set([
  "unsupported JSON value",
  "invalid event envelope",
  "event exceeds 16 MiB capacity; no targets published",
  "source directory is not private",
  "invalid source file",
  "source root must be absolute",
  "key must be canonical 32-byte base64",
  "invalid expected authority",
  "invalid lock timeout",
  "fault injection requires test environment",
  "invalid database identity",
  "invalid promotion identity",
  "promotion authority conflict",
  "recovery checkpoint is not caught up",
  "recovery database must have a new installation identity",
  "authority generation exhausted",
  "eventId payload conflict",
  "event sequence exhausted",
  "active database authority mismatch",
  "source JSON is truncated or invalid",
  "unknown source format",
  "source authentication failed",
  "unknown source entry",
  "unknown head format",
  "unknown event format",
  "missing events or publication fork",
  "event chain missing, forked or unknown",
  "duplicate eventId in source",
  "event filename authentication failed",
  "authenticated head does not match event tail",
  "invalid empty head",
  "lock timeout",
  "fixed lock inode changed",
  "source unavailable (I/O)",
]);
function cause(error: unknown, phase: string, started: number): Cause {
  const message = error instanceof Error ? error.message : "",
    type = field(error, "name"),
    sqlState = field(field(error, "meta"), "code"),
    journalReason =
      error instanceof PrivacyJournalError
        ? message.slice("Privacy journal: ".length)
        : "",
    ioCode = /^source unavailable \(([A-Z0-9_]+)\)$/.exec(journalReason)?.[1];
  return {
    phase,
    elapsedMs: Math.round(performance.now() - started),
    type: typeof type === "string" && types.has(type) ? type : "unknown",
    code: code(field(error, "code") ?? field(error, "errorCode") ?? ioCode),
    sqlState:
      typeof sqlState === "string" && /^[A-Z0-9]{5}$/.test(sqlState)
        ? sqlState
        : undefined,
    // Only literal reasons or a validated code survive. Unknown Prisma errors
    // have no inferred SQLSTATE; never parse SQL, stacks or request arguments.
    reason: journalReasons.has(journalReason)
      ? journalReason
      : ioCode && systemCodes.has(ioCode)
        ? "source unavailable"
        : [
              "Privacy recovery installation is missing",
              "Independent source identity changed",
              "Invalid privacy checkpoint",
              "Independent source is behind durable checkpoint",
              "Independent source disagrees with durable checkpoint",
              "Privacy receipt conflicts with source",
              "Independent source checkpoint conflicts",
              "Independent source receipt conflicts",
            ].includes(message)
          ? message
          : undefined,
  };
}
function wrap(
  prototype: object,
  method: string,
  observe: (target: object, call: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = Reflect.get(prototype, method);
  if (typeof original !== "function") throw Error("Diagnostic method missing");
  Object.defineProperty(prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: object, ...args: unknown[]) {
      return observe(this, () => original.apply(this, args));
    },
  });
}
function noteFailure(error: unknown, phase: string, started: number) {
  try {
    const current = gate.getStore();
    if (current) current.cause ??= cause(error, phase, started);
  } catch {
    // A diagnostic cannot replace the original error object.
  }
}

/** CI-only observation of the original calls; no additional source/DB reads,
 * altered errors, retry, delay, gate reset or private request/body logging. */
export function installPrivacyFailureDiagnostic() {
  if (
    installed ||
    (process.env.CI !== "true" &&
      process.env.TIMENOOK_TEST_PRIVACY_DIAGNOSTIC !== "1")
  )
    return;
  installed = true;
  for (const method of ["snapshot", "append", "assertHealthy"]) {
    wrap(PrivacyJournal.prototype, method, async (target, call) => {
      const started = performance.now();
      try {
        const result = await call();
        try {
          const generation = field(result, "generation");
          if (method === "snapshot" && typeof generation === "number")
            generations.set(target, generation);
        } catch {
          // Observation cannot turn a successful source call into a failure.
        }
        return result;
      } catch (error) {
        noteFailure(error, `journal.${method}`, started);
        throw error;
      }
    });
  }
  wrap(PrivacyRights.prototype, "synchronize", async (_target, call) => {
    const started = performance.now();
    try {
      return await call();
    } catch (error) {
      noteFailure(error, "replay", started);
      throw error;
    }
  });
  for (const method of ["assertHealthy", "assertReplayed"]) {
    wrap(PrivacyRights.prototype, method, (target, call) =>
      gate.run({}, async () => {
        const started = performance.now(),
          wasFailed = Reflect.get(target, "failed");
        try {
          return await call();
        } catch (error) {
          // This interval can overlap another invocation's write to failed.
          // Preserve every in-flight error; none claims transition ownership.
          if (!wasFailed && Reflect.get(target, "failed")) {
            if (!instances.has(target))
              instances.set(target, ++instanceSequence);
            const journal = Reflect.get(target, "journal");
            try {
              process.stderr.write(
                `[T26_PRIVACY_GATE_FAILURE_CANDIDATE] ${JSON.stringify({
                  pid: process.pid,
                  instance: instances.get(target),
                  ownership: "unknown",
                  phase: method,
                  monotonicMs: Math.round(performance.now()),
                  elapsedMs: Math.round(performance.now() - started),
                  lastVerifiedGeneration: journal && generations.get(journal),
                  stream: stream.getStore() ?? "unknown",
                  error:
                    gate.getStore()?.cause ?? cause(error, method, started),
                })}\n`,
              );
            } catch {
              // Observation must never replace the actual failure.
            }
          }
          throw error;
        }
      }),
    );
  }
  wrap(ProjectStreams.prototype, "guard", (_target, call) => {
    const current: Stream = { id: ++streamSequence, closed: null };
    return stream.run(current, async () => {
      const result = await call();
      if (result instanceof Readable) {
        current.closed = false;
        result.once("close", () => {
          current.closed = true;
        });
      }
      return result;
    });
  });
}
