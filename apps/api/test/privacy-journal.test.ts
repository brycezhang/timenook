import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PrivacyJournal,
  PrivacyJournalError,
} from "../src/privacy-journal/privacy-journal";

test("only explicit bootstrap opens a privacy source; retry preserves the same event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
  try {
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    await assert.rejects(new PrivacyJournal(config).snapshot());
    const authority = await PrivacyJournal.bootstrap(config, {
      databaseId: randomUUID(),
    });
    const journal = new PrivacyJournal({
      ...config,
      expectedAuthority: authority,
    });
    const event = {
      eventId: "revocation-1",
      projectId: "project-1",
      kind: "revocation" as const,
      occurredAt: "2026-10-27T00:00:00.000Z",
      payload: { purpose: "capture", accessEpoch: "2" },
    };
    const published = await journal.append(event);
    assert.equal(published.generation, 1);
    assert.deepEqual(await journal.append(event), published);
    assert.equal((await journal.snapshot()).events.length, 1);
    await assert.rejects(
      journal.append({ ...event, payload: { purpose: "sharing" } }),
      /conflict/i,
    );
    await assert.rejects(
      PrivacyJournal.bootstrap(config, { databaseId: randomUUID() }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const damage of [
  "head missing",
  "tail missing",
  "tail truncated",
  "HMAC changed",
  "unknown file",
  "public permissions",
] as const) {
  test(`private access fails closed after ${damage}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
    try {
      const config = {
        root: join(directory, "source"),
        key: randomBytes(32).toString("base64"),
      };
      const expectedAuthority = await PrivacyJournal.bootstrap(config, {
        databaseId: randomUUID(),
      });
      const journal = new PrivacyJournal({ ...config, expectedAuthority });
      await journal.append({
        eventId: "deny",
        projectId: "project",
        kind: "deletion",
        occurredAt: "2026-10-27T00:00:00.000Z",
        payload: { categories: ["all"] },
      });
      const eventPath = join(
        config.root,
        "events",
        (await readdir(join(config.root, "events")))[0],
      );
      if (damage === "head missing")
        await unlink(join(config.root, "head.json"));
      if (damage === "tail missing") await unlink(eventPath);
      if (damage === "tail truncated") await truncate(eventPath, 4);
      if (damage === "HMAC changed") {
        const content = await readFile(eventPath, "utf8");
        await writeFile(eventPath, content.replace('"all"', '"none"'));
      }
      if (damage === "unknown file")
        await writeFile(
          join(config.root, "events", "unrecognized.json"),
          "{}",
          { mode: 0o600 },
        );
      if (damage === "public permissions") await chmod(eventPath, 0o644);
      await assert.rejects(journal.assertHealthy(), /Privacy journal:/);
      await assert.rejects(
        journal.append({
          eventId: "later",
          projectId: "project",
          kind: "revocation",
          occurredAt: "2026-10-27T00:00:01.000Z",
          payload: {},
        }),
        /Privacy journal:/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("partial unpublished temporary files are quarantined while published facts remain available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
  try {
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    await PrivacyJournal.bootstrap(config, { databaseId: randomUUID() });
    await writeFile(
      join(config.root, "events", `.tmp-${randomUUID()}`),
      '{"unfinished":',
      { mode: 0o600 },
    );
    const snapshot = await new PrivacyJournal(config).snapshot();
    assert.equal(snapshot.generation, 0);
    assert.equal((await readdir(join(config.root, "quarantine"))).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a complete authenticated fork is rejected instead of accepting one valid prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
  try {
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    const expectedAuthority = await PrivacyJournal.bootstrap(config, {
      databaseId: randomUUID(),
    });
    const journal = new PrivacyJournal({ ...config, expectedAuthority });
    const head = await readFile(join(config.root, "head.json"));
    const base = {
      projectId: "project",
      kind: "deletion" as const,
      occurredAt: "2026-10-27T00:00:00.000Z",
      payload: {},
    };
    await journal.append({ ...base, eventId: "branch-a" });
    const first = (await readdir(join(config.root, "events")))[0];
    const preserved = join(directory, "branch-a.json");
    await copyFile(join(config.root, "events", first), preserved);
    await unlink(join(config.root, "events", first));
    await writeFile(join(config.root, "head.json"), head);
    await journal.append({ ...base, eventId: "branch-b" });
    await copyFile(preserved, join(config.root, "events", first));
    await assert.rejects(journal.snapshot(), PrivacyJournalError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotion requires a caught-up recovery target and fences the old API and worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
  try {
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    const oldAuthority = await PrivacyJournal.bootstrap(config, {
      databaseId: randomUUID(),
    });
    const oldRuntime = new PrivacyJournal({
      ...config,
      expectedAuthority: oldAuthority,
    });
    await oldRuntime.append({
      eventId: "delete-1",
      projectId: "project-1",
      kind: "deletion",
      occurredAt: "2026-10-27T00:00:00.000Z",
      payload: { categories: ["all"] },
    });
    const replay = new PrivacyJournal(config);
    await assert.rejects(replay.assertHealthy(), /authority mismatch/);
    const checkpoint = await replay.snapshot();
    const target = randomUUID();
    await assert.rejects(
      PrivacyJournal.promote(config, {
        expectedAuthority: oldAuthority,
        databaseId: target,
        checkpoint: { ...checkpoint, generation: 0 },
      }),
      /checkpoint/,
    );
    const promoted = await PrivacyJournal.promote(config, {
      expectedAuthority: oldAuthority,
      databaseId: target,
      checkpoint,
    });
    assert.deepEqual(promoted, { databaseId: target, generation: 2 });
    await assert.rejects(oldRuntime.assertHealthy(), /authority mismatch/);
    await new PrivacyJournal({
      ...config,
      expectedAuthority: promoted,
    }).assertHealthy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid JSON and oversized target manifests fail before any event is published", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-"));
  try {
    const config = {
      root: join(directory, "source"),
      key: randomBytes(32).toString("base64"),
    };
    const expectedAuthority = await PrivacyJournal.bootstrap(config, {
      databaseId: randomUUID(),
    });
    const journal = new PrivacyJournal({ ...config, expectedAuthority });
    const event = {
      eventId: "delete",
      projectId: "project",
      kind: "deletion" as const,
      occurredAt: "2026-10-27T00:00:00.000Z",
      payload: { targets: ["private"] },
    };
    const holes = ["private", , "private"];
    await assert.rejects(
      journal.append({ ...event, payload: { targets: holes } }),
      PrivacyJournalError,
    );
    await assert.rejects(
      journal.append({
        ...event,
        payload: { targets: "x".repeat(16 * 1024 * 1024) },
      }),
      /capacity/,
    );
    assert.equal((await journal.snapshot()).generation, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
