import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { exportZip, hashBytes } from "../src/care/export-zip";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";

async function largeAudioFiles() {
  const padding = 1800000,
    header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) header[6 + i] = (padding >> (7 * (3 - i))) & 0x7f;
  const audio = Buffer.concat([
    header,
    Buffer.alloc(padding),
    await fs.readFile(join(__dirname, "../../test/fixtures/synthetic-1s.mp3")),
  ]);
  return Array.from({ length: 4 }, (_, i) => ({
    path: `audio/${i}.mp3`,
    bytes: Buffer.from(audio),
    provenance: "originalAudio",
    source: { id: `fixture-${i}` },
  }));
}
const metadata = {
  projectId: "00000000-0000-4000-8000-000000000001",
  scope: "candidate-benchmark",
};

test("ZIP headers retain the standard CRC-32 values for empty and text entries", () => {
  const result = exportZip(
    [
      {
        path: "empty",
        bytes: Buffer.alloc(0),
        provenance: "fixture",
        source: {},
      },
      {
        path: "text",
        bytes: Buffer.from("123456789"),
        provenance: "fixture",
        source: {},
      },
    ],
    {},
  );
  assert.equal(result.bytes.readUInt32LE(14), 0);
  assert.equal(result.bytes.readUInt32LE(30 + 5 + 14), 0xcbf43926);
});

test("complete ZIP retains the original bytes for four full-size audio sources", async () => {
  const files = await largeAudioFiles(),
    result = exportZip(files, metadata);
  assert.equal(
    files.reduce((n, file) => n + file.bytes.length, 0),
    7225960,
  );
  assert.equal(result.bytes.length, 7227584);
  // Captured from the original per-bit CRC implementation, including manifest
  // hashes, UTF-8 ZIP headers, central directory, entry order and stored bytes.
  assert.equal(
    hashBytes(result.bytes),
    "3ff42565bbeea587e176d7f066587246647ea2e7c945f188fce1fb6df9c3f2df",
  );
});

test(
  "real full-size ZIP work does not starve three complete source readers",
  { timeout: 30000 },
  async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), "timenook-zip-source-")),
      config = {
        root: join(directory, "source"),
        key: randomBytes(32).toString("base64"),
      },
      pending: Promise<unknown>[] = [];
    let release: () => void = () => {},
      opened: () => void = () => {};
    const delivery = new Promise<void>((resolve) => (release = resolve)),
      originalOpenObserved = new Promise<void>((resolve) => (opened = resolve));
    try {
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
          databaseId: randomUUID(),
        }),
        journal = new PrivacyJournal({ ...config, expectedAuthority });
      for (let i = 0; i < 86; i++)
        await journal.append({
          eventId: randomUUID(),
          projectId: randomUUID(),
          kind: "revocation",
          occurredAt: "2026-10-28T00:00:00.000Z",
          payload: { purpose: "collection", accessEpoch: i },
        });
      const baseline = await journal.snapshot(),
        files = await largeAudioFiles(),
        open = fs.open;
      let selected = false,
        eventOpens = 0,
        eventCloses = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await Reflect.apply(open, fs, args);
        if (
          typeof args[0] === "string" &&
          dirname(args[0]) === join(config.root, "events")
        ) {
          eventOpens++;
          const close = file.close;
          Reflect.set(file, "close", async () => {
            const result = await close.call(file);
            eventCloses++;
            return result;
          });
          if (!selected) {
            selected = true;
            // The real event FD is already open under EX. Deliver its unchanged
            // result after the first actual ZIP build, then let all I/O run freely.
            opened();
            await delivery;
          }
        }
        return file;
      });
      const readers = [
        journal.snapshot(),
        journal.snapshot(),
        journal.snapshot(),
      ];
      pending.push(...readers);
      const outcomes = Promise.allSettled(readers);
      await Promise.race([
        originalOpenObserved,
        outcomes.then(() => {
          throw new Error("Source readers finished before the real event open");
        }),
      ]);
      const begin = performance.now();
      let zipBytes = 0;
      for (let i = 0; i < 8; i++) {
        await nextTurn();
        zipBytes += exportZip(files, metadata).bytes.length;
        release();
      }
      const results = await outcomes;
      t.diagnostic(
        JSON.stringify({
          zipBuilds: 8,
          inputBytes: 7225960,
          zipBytes,
          wallMs: Math.round(performance.now() - begin),
          outcomes: results.map((r) =>
            r.status === "fulfilled"
              ? "verified"
              : r.reason instanceof Error &&
                  r.reason.message === "Privacy journal: lock timeout"
                ? "lock timeout"
                : "other error",
          ),
        }),
      );
      for (const result of results) {
        assert.equal(result.status, "fulfilled");
        if (result.status === "fulfilled") {
          assert.equal(result.value.hash, baseline.hash);
          assert.deepEqual(result.value.events, baseline.events);
        }
      }
      assert.equal(
        eventOpens,
        3 * 86,
        "each reader reopens the complete source",
      );
      assert.equal(
        eventCloses,
        eventOpens,
        "all original event FDs are closed",
      );
    } finally {
      release();
      await Promise.allSettled(pending);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
