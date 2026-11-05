import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { Prisma } from "@prisma/client";
import { Deletions } from "../src/care/deletions";
import {
  app,
  bound,
  data,
  db,
  readyStory,
  request,
  startBookFixture,
  stopBookFixture,
} from "./book-fixture";

const entryId = "Bg_e1EMJ2zXJOA7rEM1zVQ";
const plans = ["force_custom_plan", "force_generic_plan"] as const;
type Plan = (typeof plans)[number];
type Table = "book_audio_entries" | "care_exports";
let projectId: string;
let otherProjectId: string;
let packIds: string[];

before(async () => {
  await startBookFixture();
  const p = await readyStory();
  projectId = p.projectId;
  otherProjectId = (await bound()).projectId;
  const revision = await db.storyRevision.findUniqueOrThrow({
    where: { id: p.story.revision.id },
  });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode=force_custom_plan");
    await tx.bookAudioEntry.create({
      data: {
        id: entryId,
        projectId,
        storyId: revision.storyId,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        audio: revision.audioManifest as Prisma.InputJsonValue,
      },
    });
  });
  packIds = [];
  for (let index = 0; index < 2; index++) {
    const pack = data(
      await request(
        "POST",
        `/v1/projects/${projectId}/exports`,
        p.narrator.token,
        {
          recipient: "self",
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: `synthetic:guard-scope-${index}`,
        },
      ),
    );
    await db.careExport.update({
      where: { id: pack.id },
      data: { manifest: { files: [{ path: "audio/synthetic.mp3" }] } },
    });
    packIds.push(pack.id);
  }
  // The SQL seam owns its transaction and clock. Do not race its synthetic
  // durable items with automatic maintenance; public HTTP coverage runs apart.
  await app.get(Deletions).onModuleDestroy();
});
after(stopBookFixture);

async function inPlan(
  plan: Plan,
  work: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const rollback = new Error("Rollback isolated guard scenario");
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode=${plan}`);
      await work(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function row(tx: Prisma.TransactionClient, table: Table, id: string) {
  const [found] = await tx.$queryRawUnsafe<{ value: Prisma.JsonObject }[]>(
    `SELECT to_jsonb(r) value FROM ${table} r WHERE id::text=$1`,
    id,
  );
  assert.ok(found);
  return found.value;
}

function erased(value: Prisma.JsonObject, column: string) {
  return {
    ...value,
    [column]: null,
    privacy_erased_columns: [
      ...(value.privacy_erased_columns as string[]),
      column,
    ],
  };
}

async function allowed(
  tx: Prisma.TransactionClient,
  table: Table,
  before: Prisma.JsonObject,
  after: Prisma.JsonObject,
) {
  const [result] = await tx.$queryRaw<{ allowed: boolean }[]>`
    SELECT privacy_erasure_allowed(${table},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb) allowed
  `;
  return result.allowed;
}

async function item(
  tx: Prisma.TransactionClient,
  target: {
    table: Table;
    id: string;
    owner?: string;
    category?: string;
    columns: string[];
    scopedExportId?: string;
  },
) {
  const event = randomUUID();
  const owner = target.owner ?? projectId;
  const category = target.category ?? "originalAudio";
  // Real constrained PG rows at the guard's durable-projection seam. The
  // surrounding rollback keeps these synthetic receipts out of the API journal.
  await tx.$executeRaw`
    INSERT INTO privacy_events(id,project_id,kind,source_id,generation,hash,payload,occurred_at)
    VALUES(${event}::uuid,${owner}::uuid,'deletion',${randomUUID()}::uuid,1,${"0".repeat(64)},'{"operation":"erase"}'::jsonb,now())
  `;
  await tx.$executeRaw`
    INSERT INTO privacy_deletions(id,project_id,trigger,categories,effective_at,scoped_export_id)
    VALUES(${event}::uuid,${owner}::uuid,'verified_request',${JSON.stringify([category])}::jsonb,now(),${target.scopedExportId ?? null}::uuid)
  `;
  await tx.$executeRaw`
    INSERT INTO privacy_deletion_items(id,event_id,project_id,category,layer,target_table,target_key,target_columns)
    VALUES(${randomUUID()}::uuid,${event}::uuid,${owner}::uuid,${category},'active_database',${target.table},${JSON.stringify({ id: target.id })}::jsonb,${target.columns}::text[])
  `;
}

async function erase(
  tx: Prisma.TransactionClient,
  table: Table,
  id: string,
  column: string,
) {
  return tx.$executeRawUnsafe(
    `UPDATE ${table} SET ${column}=NULL,privacy_erased_columns=privacy_erased_columns || $2::text[] WHERE id::text=$1`,
    id,
    [column],
  );
}

for (const plan of plans) {
  test(`${plan}: a stable non-UUID audio entry without a durable item is denied without a cast error`, async () => {
    await inPlan(plan, async (tx) => {
      const original = await row(tx, "book_audio_entries", entryId);
      assert.equal(
        await allowed(
          tx,
          "book_audio_entries",
          original,
          erased(original, "audio"),
        ),
        false,
      );
      await tx.$executeRawUnsafe("SAVEPOINT unauthorized_erasure");
      await assert.rejects(erase(tx, "book_audio_entries", entryId, "audio"));
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT unauthorized_erasure");
      assert.deepEqual(await row(tx, "book_audio_entries", entryId), original);
    });
  });

  test(`${plan}: only the exact project, category, row and columns permit actual audio erasure`, async () => {
    await inPlan(plan, async (tx) => {
      const original = await row(tx, "book_audio_entries", entryId);
      const cleared = erased(original, "audio");
      const target = {
        table: "book_audio_entries" as const,
        id: entryId,
        columns: ["audio"],
      };
      for (const mismatch of [
        { owner: otherProjectId },
        { id: "AnotherStableEntryCode1" },
        { columns: ["content_hash"] },
        { category: "confirmedStories" },
        { scopedExportId: packIds[0] },
      ]) {
        await item(tx, { ...target, ...mismatch });
        assert.equal(
          await allowed(tx, "book_audio_entries", original, cleared),
          false,
        );
      }
      await item(tx, target);
      assert.equal(
        await allowed(tx, "book_audio_entries", original, cleared),
        true,
      );
      await tx.$executeRawUnsafe("SAVEPOINT deny_new_audio_payload");
      await assert.rejects(
        tx.$executeRaw`
          INSERT INTO book_audio_entries SELECT * FROM book_audio_entries WHERE id=${entryId}
        `,
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.meta?.code === "P0001" &&
          String(error.meta?.message).includes(
            "Deleted project/category cannot acquire new payload",
          ),
      );
      await tx.$executeRawUnsafe(
        "ROLLBACK TO SAVEPOINT deny_new_audio_payload",
      );
      assert.equal(await erase(tx, "book_audio_entries", entryId, "audio"), 1);
      assert.deepEqual(await row(tx, "book_audio_entries", entryId), cleared);
      await tx.$executeRawUnsafe("SAVEPOINT restore_erased_payload");
      await assert.rejects(tx.$executeRaw`
        UPDATE book_audio_entries SET audio=${JSON.stringify(original.audio)}::jsonb WHERE id=${entryId}
      `);
      await tx.$executeRawUnsafe(
        "ROLLBACK TO SAVEPOINT restore_erased_payload",
      );
      assert.deepEqual(await row(tx, "book_audio_entries", entryId), cleared);
    });
  });

  test(`${plan}: a UUID export erasure remains restricted to its exact package`, async () => {
    await inPlan(plan, async (tx) => {
      const original = await row(tx, "care_exports", packIds[0]);
      const sibling = await row(tx, "care_exports", packIds[1]);
      const target = {
        table: "care_exports" as const,
        id: packIds[0],
        columns: ["manifest"],
        category: "exportPackages",
      };
      await item(tx, { ...target, scopedExportId: packIds[1] });
      assert.equal(
        await allowed(
          tx,
          "care_exports",
          original,
          erased(original, "manifest"),
        ),
        false,
      );
      await item(tx, { ...target, scopedExportId: packIds[0] });
      assert.equal(
        await allowed(
          tx,
          "care_exports",
          original,
          erased(original, "manifest"),
        ),
        true,
      );
      assert.equal(
        await allowed(tx, "care_exports", sibling, erased(sibling, "manifest")),
        false,
      );
      assert.equal(await erase(tx, "care_exports", packIds[0], "manifest"), 1);
      assert.deepEqual(
        await row(tx, "care_exports", packIds[0]),
        erased(original, "manifest"),
      );
      assert.deepEqual(await row(tx, "care_exports", packIds[1]), sibling);
    });
  });
}
