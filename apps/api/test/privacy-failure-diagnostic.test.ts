import assert from "node:assert/strict";
import { test } from "node:test";
import { PrivacyRights } from "../src/care/privacy-rights";
import { PrivacyJournalError } from "../src/privacy-journal/privacy-journal";
import { installPrivacyFailureDiagnostic } from "./privacy-failure-diagnostic";

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const order of ["source-then-db", "db-then-source"] as const) {
  test(`overlapping ${order} failures retain both diagnostic candidates without assigning latch ownership`, async (t) => {
    const enabled = process.env.TIMENOOK_TEST_PRIVACY_DIAGNOSTIC;
    process.env.TIMENOOK_TEST_PRIVACY_DIAGNOSTIC = "1";
    installPrivacyFailureDiagnostic();
    const output: string[] = [],
      write = process.stderr.write;
    t.mock.method(
      process.stderr,
      "write",
      (...args: Parameters<typeof process.stderr.write>) => {
        const text = String(args[0]);
        if (text.startsWith("[T26_PRIVACY_GATE_")) {
          output.push(text);
          return true;
        }
        return Reflect.apply(write, process.stderr, args);
      },
    );
    // Observer scheduling model only: native Rights methods, deferred Promise
    // DB/source boundaries, no PostgreSQL/filesystem I/O or CI-cause claim.
    const rights: PrivacyRights = Object.create(PrivacyRights.prototype),
      db = deferred(),
      source = deferred(),
      enteredDb = deferred(),
      dbError = Object.assign(new Error("controlled non-latching DB failure"), {
        name: "PrismaClientKnownRequestError",
        code: "P2028",
      }),
      sourceError = new PrivacyJournalError("source authentication failed");
    Reflect.set(rights, "failed", false);
    Reflect.set(rights, "journal", {
      snapshot: async () => ({
        sourceId: "00000000-0000-4000-8000-000000000001",
        generation: 0,
        events: [],
      }),
      assertHealthy: () => source.promise,
    });
    Reflect.set(rights, "db", {
      $queryRaw: () => {
        enteredDb.resolve();
        return db.promise;
      },
    });
    try {
      const a = rights.assertReplayed().catch((error) => error);
      await enteredDb.promise;
      const b = rights.assertHealthy().catch((error) => error);
      // Only B's native catch writes failed. Both callers began with false;
      // A's outer catch may observe B's write before B's own outer catch runs.
      if (order === "db-then-source") {
        db.reject(dbError);
        source.reject(sourceError);
      } else {
        source.reject(sourceError);
        db.reject(dbError);
      }
      const [aError, bError] = await Promise.all([a, b]);
      assert.equal(aError, dbError, "the original non-latching error survives");
      assert.equal(bError.getStatus(), 503);
      assert.equal(Reflect.get(rights, "failed"), true);
      const records = output.map((text) =>
        JSON.parse(text.slice(text.indexOf("{"))),
      );
      assert.equal(
        records.length,
        2,
        "neither concurrent candidate is discarded",
      );
      assert.deepEqual(records.map((record) => record.phase).sort(), [
        "assertHealthy",
        "assertReplayed",
      ]);
      for (const record of records) assert.equal(record.ownership, "unknown");
      assert.equal(
        records.find((record) => record.phase === "assertReplayed").error.code,
        "P2028",
      );
      assert.equal(
        records.find((record) => record.phase === "assertHealthy").error.type,
        "ServiceUnavailableException",
      );
      assert.equal(
        records[0].instance,
        records[1].instance,
        "both candidates belong to the same Rights instance",
      );
      await assert.rejects(rights.assertHealthy());
      await assert.rejects(rights.assertReplayed());
      assert.equal(output.length, 2, "calls starting failed remain silent");
    } finally {
      if (enabled === undefined)
        delete process.env.TIMENOOK_TEST_PRIVACY_DIAGNOSTIC;
      else process.env.TIMENOOK_TEST_PRIVACY_DIAGNOSTIC = enabled;
    }
  });
}
