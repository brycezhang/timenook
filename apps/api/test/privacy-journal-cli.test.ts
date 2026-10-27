import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";

test("maintenance CLI bootstraps external credentials and inspects only authenticated metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timenook-journal-cli-"));
  try {
    const ts = __filename.endsWith(".ts");
    const command = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          ...(ts ? ["--import", "tsx"] : []),
          join(
            __dirname,
            `../src/privacy-journal/journal-cli.${ts ? "ts" : "js"}`,
          ),
          ...args,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
    const root = join(directory, "source");
    const keyFile = join(directory, "secret.key");
    const databaseId = randomUUID();
    const common = ["--root", root, "--key-file", keyFile];
    assert.equal(command(["inspect", ...common]).status, 1);
    const result = command([
      "bootstrap",
      ...common,
      "--database-id",
      databaseId,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const key = (await readFile(keyFile, "utf8")).trim();
    await new PrivacyJournal({
      root,
      key,
      expectedAuthority: { databaseId, generation: 1 },
    }).append({
      eventId: "synthetic-delete",
      projectId: "private-project",
      kind: "deletion",
      occurredAt: "2026-10-27T00:00:00.000Z",
      payload: { privateMarker: "must-not-be-printed" },
    });
    const inspected = command(["inspect", ...common]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).generation, 1);
    assert.ok(!inspected.stdout.includes(key));
    assert.ok(!inspected.stdout.includes("must-not-be-printed"));
    assert.equal(command(["append", ...common]).status, 1);
    assert.equal(
      command(["bootstrap", ...common, "--database-id", databaseId]).status,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
