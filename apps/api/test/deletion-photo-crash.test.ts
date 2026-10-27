import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { access, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  app,
  config,
  startBookFixture,
  stopBookFixture,
  request,
  storyPhoto,
} from "./book-fixture";
import { readyFirstCopyBook } from "./first-copy-fixture";
import { Deletions } from "../src/care/deletions";
import { ProjectServiceTerms } from "../src/projects/service-terms";
before(startBookFixture);
after(stopBookFixture);
test("SIGKILL after crop I/O still permits exact original-only cleanup and preserves independent derivatives", async (t) => {
  const p = await readyFirstCopyBook(
      {},
      {},
      { originalPhotos: 1, derivedPhotos: 20 },
    ),
    photos = await storyPhoto(p, "原图临时副本核验"),
    photo = photos.entries[0];
  const base = `/v1/projects/${p.projectId}/interviews/${p.interviewId}/photos/${photo.photoId}`;
  const previewBefore = await request(
    "GET",
    base + "/content/preview",
    p.narrator.token,
  );
  assert.equal(previewBefore.statusCode, 200);
  const directory = await mkdtemp(join(tmpdir(), "timenook-crop-review-")),
    path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const proc = fork(
    resolve(__dirname, "fixtures/privacy-crop-process.js"),
    [path],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await new Promise<void>((r) => proc.once("exit", () => r()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const message = () =>
    new Promise<any>((yes, no) => {
      const timer = setTimeout(
        () => no(Error("Crop child did not reach real I/O")),
        20000,
      );
      proc.once("message", (m) => {
        clearTimeout(timer);
        yes(m);
      });
      proc.once("error", no);
    });
  const ready = await message();
  assert.equal(ready.stage, "ready");
  const written = message();
  const pending = fetch(ready.url + base + "/crop", {
    method: "POST",
    headers: {
      authorization: "Bearer " + p.narrator.token,
      "idempotency-key": randomUUID(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expectedRevision: photos.revision,
      left: 0,
      top: 0,
      width: 60,
      height: 40,
    }),
  }).catch(() => null);
  const stopped = await written;
  assert.equal(stopped.stage, "outputs-written");
  proc.kill("SIGKILL");
  await new Promise<void>((r) => proc.once("exit", () => r()));
  await pending;
  const input = join(stopped.root, "input"),
    copy = join(stopped.root, "output/original.bin"),
    derived = join(stopped.root, "output/preview.jpg");
  const originalBytes = await readFile(input);
  assert.deepEqual(await readFile(copy), originalBytes);
  const derivativeBytes = await readFile(derived);
  const terms = new ProjectServiceTerms(config.databaseUrl),
    anchor = new Date();
  await terms.recordFact({
    projectId: p.projectId,
    eventId: "synthetic-crop-crash-" + randomUUID(),
    kind: "delivery_completed",
    occurredAt: anchor,
  });
  await terms.close();
  await app.get(Deletions).sweep(new Date(anchor.getTime() + 86400000));
  await assert.rejects(access(input), { code: "ENOENT" });
  await assert.rejects(access(copy), { code: "ENOENT" });
  assert.deepEqual(await readFile(derived), derivativeBytes);
  const after = await request(
    "GET",
    base + "/content/preview",
    p.narrator.token,
  );
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.rawPayload, previewBefore.rawPayload);
  assert.equal(
    (await request("GET", base + "/content/original", p.narrator.token))
      .statusCode,
    403,
  );
});
