import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
  symlink,
  realpath,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import { createApplication } from "../src/application";
import { PrivacyJournal } from "../src/privacy-journal/privacy-journal";
import { privacyAuthorityId } from "../src/care/privacy-rights";
import { ProductionTasks } from "../src/tasks/tasks";

const oldMain = "321f0e15a0687f458df6d60ad88bff793cd3c8d4";

/** Compile immutable historical sources only. The old schema generates its own
 * client outside the checkout; the current worktree's client is never changed. */
async function historicalSources(directory: string, api: string) {
  const repository = resolve(api, "../..");
  const archive = spawnSync("git", ["archive", oldMain], {
    cwd: repository,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(
    archive.status,
    0,
    "fixed historical commit must be locally available",
  );
  const root = join(directory, "old-main");
  await mkdir(root);
  const unpacked = spawnSync("tar", ["-xf", "-", "-C", root], {
    input: archive.stdout,
    timeout: 30000,
  });
  assert.equal(unpacked.status, 0, "historical source extraction");
  const oldApi = join(root, "apps/api");
  const schemaPath = join(oldApi, "prisma/schema.prisma");
  const client = join(directory, "historical-deps/@prisma/client");
  const oldSchema = await readFile(schemaPath, "utf8");
  assert.ok(oldSchema.includes("generator client {"));
  const generator = join(directory, "historical-generator");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    generator,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(await realpath(join(api, "node_modules/@prisma/client/generator-build/index.js")))}\n`,
    { mode: 0o700 },
  );
  await writeFile(
    schemaPath,
    oldSchema
      .replace(
        "generator client {",
        `generator client {\n  output = ${JSON.stringify(client)}`,
      )
      .replace(
        /provider\s*=\s*"prisma-client-js"/,
        `provider = ${JSON.stringify(generator)}`,
      ),
  );
  const generated = spawnSync(
    process.execPath,
    [
      join(api, "node_modules/prisma/build/index.js"),
      "generate",
      "--schema",
      schemaPath,
    ],
    {
      cwd: oldApi,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PRISMA_GENERATE_SKIP_AUTOINSTALL: "true",
        NODE_PATH: [
          join(api, "node_modules"),
          resolve(api, "../../node_modules"),
        ].join(delimiter),
      },
    },
  );
  if (generated.status !== 0)
    await writeFile(
      join(directory, "generation-failure.txt"),
      generated.stdout + generated.stderr,
      { mode: 0o600 },
    );
  assert.equal(
    generated.status,
    0,
    `isolated historical client generation; diagnostic ${join(directory, "generation-failure.txt")}`,
  );
  const generatedSchema = await readFile(join(client, "schema.prisma"), "utf8");
  assert.equal(
    generatedSchema.includes("shippedAt"),
    false,
    "the real historical client uses the old shipment model",
  );
  async function compile(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await compile(file);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        let source = await readFile(file, "utf8");
        // Only the fixture's migration executable locator changes. Its real old
        // schema/migrations and all business source/adapter behavior stay intact.
        if (file === join(oldApi, "test/book-fixture.ts"))
          source = source.replaceAll(
            '"node_modules/prisma/build/index.js"',
            JSON.stringify(join(api, "node_modules/prisma/build/index.js")),
          );
        const emitted = ts.transpileModule(source, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.Node16,
            moduleResolution: ts.ModuleResolutionKind.Node16,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            esModuleInterop: true,
          },
        });
        const output = join(
          oldApi,
          "dist-test",
          relative(oldApi, file).replace(/\.ts$/, ".js"),
        );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, emitted.outputText);
      }
    }
  }
  await compile(join(oldApi, "src"));
  await compile(join(oldApi, "test"));
  // The historical public print flow uses the same verified, Git-ignored font
  // prerequisite as the current fixture; its business sources stay unchanged.
  const fontDirectory = resolve(oldApi, "../../.cache/print-probe");
  await mkdir(fontDirectory, { recursive: true });
  await copyFile(
    resolve(api, "../../.cache/print-probe/NotoSansCJKsc-Regular.otf"),
    join(fontDirectory, "NotoSansCJKsc-Regular.otf"),
  );
  // ESM worker resolution does not use NODE_PATH. Link only locked print/photo
  // dependencies; @prisma/client keeps its separate historical generator output.
  for (const dependency of [
    "@playwright/test",
    "fontkit",
    "qrcode",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "jsqr",
    "sharp",
    "libheif-js",
  ]) {
    const target = resolve(oldApi, "../../node_modules", dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(
      resolve(api, "../../node_modules", dependency),
      target,
      "dir",
    );
  }
  return oldApi;
}

async function historicalUpgradeScenario(
  oldApi: string,
  currentApi: string,
  directory: string,
) {
  const oldRequire = createRequire(join(oldApi, "package.json"));
  assert.ok(
    oldRequire
      .resolve("@prisma/client")
      .includes("/historical-deps/@prisma/client/"),
    "old application must never fall back to the current generated client",
  );
  const historicalModel = oldRequire(
    "@prisma/client",
  ).Prisma.dmmf.datamodel.models.find(
    (model: { name: string }) => model.name === "FulfillmentAttempt",
  );
  assert.equal(
    historicalModel.fields.some(
      (field: { name: string }) => field.name === "shippedAt",
    ),
    false,
  );
  const oldApplication = oldRequire("./dist-test/src/application.js");
  const originalCreate = oldApplication.createApplication;
  let options: Parameters<typeof createApplication>[1];
  let providerCalls = 0;
  // Observe the actual public fixture options without changing its adapters.
  oldApplication.createApplication = async (
    config: any,
    value: typeof options,
  ) => {
    options = {
      ...value,
      aiFetch: async (...args) => {
        providerCalls++;
        return value!.aiFetch!(...args);
      },
    };
    return originalCreate(config, value);
  };
  const fixture = oldRequire("./dist-test/test/book-fixture.js");
  const adminFixture = oldRequire("./dist-test/test/payment-admin-fixture.js");
  const oldFilter = oldRequire(
    "./dist-test/src/http-error-filter.js",
  ).HttpErrorFilter;
  const originalCatch = oldFilter.prototype.catch;
  oldFilter.prototype.catch = function (error: unknown, host: unknown) {
    if (!(error as { getStatus?: unknown })?.getStatus)
      writeFileSync(
        join(directory, "historical-http-failure.txt"),
        String((error as Error).stack ?? error),
        { mode: 0o600 },
      );
    return originalCatch.call(this, error, host);
  };
  const historicalRenderer = oldRequire("./dist-test/src/books/render-book.js");
  const originalRenderer = historicalRenderer.renderBook;
  historicalRenderer.renderBook = async (...args: unknown[]) => {
    try {
      return await originalRenderer(...args);
    } catch (error) {
      await writeFile(
        join(directory, "historical-render-failure.txt"),
        String((error as Error).stack ?? error),
        { mode: 0o600 },
      );
      throw error;
    }
  };
  let phase = "historical setup";
  let backup = "";
  let initialized = false;
  const sourceRoot = join(directory, "independent-source");
  const cwd = process.cwd();
  const migrate = () => {
    const result = spawnSync(
      process.execPath,
      [
        join(currentApi, "node_modules/prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        join(currentApi, "prisma/schema.prisma"),
      ],
      {
        env: { ...process.env, DATABASE_URL: fixture.config.databaseUrl },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, "real incremental T26 migration");
  };
  const container = () => {
    const result = spawnSync(
      "docker",
      ["ps", "--filter", "publish=54329", "--format", "{{.ID}}"],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0);
    const ids = result.stdout.trim().split(/\s+/);
    assert.equal(ids.length, 1, "one isolated loopback PostgreSQL service");
    assert.match(ids[0], /^[a-f0-9]+$/);
    return ids[0];
  };
  const database = () =>
    decodeURIComponent(new URL(fixture.config.databaseUrl).pathname.slice(1));
  const privatePlan = (p: any) =>
    fixture.request(
      "GET",
      `/v1/projects/${p.projectId}/plan`,
      p.narrator.token,
    );
  const book = (p: any) =>
    fixture.request(
      "GET",
      `/v1/projects/${p.projectId}/book`,
      p.narrator.token,
    );
  try {
    process.chdir(oldApi);
    await fixture.startBookFixture();
    initialized = true;
    const [count] = await fixture.db.$queryRawUnsafe(
      'SELECT count(*)::integer AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    assert.equal(
      count.count,
      40,
      "the baseline has the actual old forty migrations",
    );
    const [missing] = await fixture.db.$queryRawUnsafe(
      "SELECT to_regclass(current_schema()||'.privacy_recovery_state') IS NULL AS absent",
    );
    assert.equal(
      missing.absent,
      true,
      "historical baseline contains no T26 tables",
    );
    const revoked = await fixture.bound(),
      control = await fixture.bound(),
      unknown = await fixture.bound(),
      deleted = await fixture.bound();
    for (const p of [revoked, control, unknown, deleted])
      fixture.data(
        (await fixture.choose(p, p.narrator.token, "collection", true))
          .response,
      );
    const storyProject = await fixture.readyStory();
    const unknownInterview = await fixture.interview(unknown);
    await fixture.sealedClip(unknown, unknownInterview.id);
    const unknownTask = await fixture.db.productionTask.findFirstOrThrow({
      where: { projectId: unknown.projectId },
    });
    const first = storyProject.story;
    const story = fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${storyProject.projectId}/stories/${first.id}/revisions`,
        storyProject.narrator.token,
        {
          baseRevisionId: first.revision.id,
          expectedVersion: first.version,
          title: first.revision.title,
          theme: first.revision.theme,
          paragraphs: first.revision.paragraphs,
          reviewResolutions: first.revision.reviewItems.map((item: string) => ({
            item,
            reason: "合成样本本人核对后保留约略年代",
          })),
          notes: [],
        },
      ),
    );
    const decision = {
      revisionId: story.revision.id,
      expectedVersion: story.version,
      contentHash: story.revision.contentHash,
      noticeVersion: "synthetic-d08-v1",
      evidenceRef: "synthetic:升级前本人确认",
    };
    fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${storyProject.projectId}/stories/${story.id}/decisions`,
        storyProject.narrator.token,
        { ...decision, confirmed: true, allowInBook: true },
      ),
    );
    for (const p of [revoked, control, unknown, deleted])
      assert.equal((await privatePlan(p)).statusCode, 200);
    assert.equal(
      fixture.data(await book(storyProject), 200).eligibleStories.length,
      1,
    );
    const qualityFixture = oldRequire("./dist-test/test/quality-fixture.js");
    const shipmentControls: {
      id: string;
      expected: string | null;
      orderId: string;
      headers: Record<string, string>;
    }[] = [];
    for (const kind of ["valid", "invalid", "missing"]) {
      const shipped = await qualityFixture.deliveredQualityOrder();
      const row = await fixture.db.fulfillmentAttempt.findUniqueOrThrow({
        where: { id: shipped.attempt.id },
      });
      const tracking = row.tracking;
      if (kind === "invalid")
        await fixture.db.fulfillmentAttempt.update({
          where: { id: row.id },
          data: {
            tracking: { ...tracking, shippedAt: "2026-02-31T12:00:00.000Z" },
          },
        });
      if (kind === "missing") {
        const { shippedAt: ignored, ...privateTracking } = tracking;
        await fixture.db.fulfillmentAttempt.update({
          where: { id: row.id },
          data: { tracking: privateTracking },
        });
      }
      shipmentControls.push({
        id: row.id,
        expected: kind === "valid" ? tracking.shippedAt : null,
        orderId: shipped.order.id,
        headers: shipped.headers,
      });
    }
    const verifyShipmentBackfill = async () => {
      for (const expected of shipmentControls) {
        const [row] = await fixture.db.$queryRawUnsafe(
          "SELECT shipped_at FROM fulfillment_attempts WHERE id=$1::uuid",
          expected.id,
        );
        assert.equal(
          row.shipped_at?.toISOString() ?? null,
          expected.expected,
          "only an actual valid historical shipment time is backfilled",
        );
      }
    };
    const schema = new URL(fixture.config.databaseUrl).searchParams.get(
      "schema",
    )!;
    const dumped = spawnSync(
      "docker",
      [
        "exec",
        container(),
        "pg_dump",
        "-U",
        "timenook",
        "-d",
        database(),
        "--schema=" + schema,
        "--no-owner",
        "--no-acl",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
    );
    assert.equal(dumped.status, 0, "real readable historical backup A");
    backup = dumped.stdout;

    phase = "historical refusals";
    fixture.data(
      (
        await fixture.choose(
          revoked,
          revoked.narrator.token,
          "collection",
          false,
        )
      ).response,
    );
    const beforeDenial = fixture.data(
      await fixture.request(
        "GET",
        `/v1/projects/${storyProject.projectId}/stories/${story.id}`,
        storyProject.narrator.token,
      ),
      200,
    );
    fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${storyProject.projectId}/stories/${story.id}/decisions`,
        storyProject.narrator.token,
        {
          ...decision,
          expectedVersion: beforeDenial.version,
          evidenceRef: "synthetic:升级前本人明确否决",
          confirmed: false,
          allowInBook: false,
        },
      ),
    );
    const oldRevocation =
      await fixture.db.projectAccessRevocation.findFirstOrThrow({
        where: { projectId: revoked.projectId },
      });
    assert.equal(oldRevocation.captureVersion, 1);
    const legacyId = randomUUID();
    await fixture.db.$executeRawUnsafe(
      "INSERT INTO project_access_revocations(id,project_id,access_epoch,purpose,reason,task_fences,capture_version) VALUES($1::uuid,$2::uuid,1,'collection',$3,'[]'::jsonb,0)",
      legacyId,
      unknown.projectId,
      oldRevocation.reason,
    );
    const state = await fixture.state(deleted, deleted.narrator.token);
    const care = fixture.data(
      await fixture.request(
        "POST",
        `/v1/projects/${deleted.projectId}/care-requests`,
        deleted.narrator.token,
        { kind: "delete", expectedBindingVersion: state.bindingVersion },
      ),
    );
    const headers = await adminFixture.paymentAdmin(
      fixture.config,
      fixture.app,
      ["care:write"],
    );
    fixture.data(
      await fixture.app.inject({
        method: "POST",
        url: `/v1/admin/care-requests/${care.id}/verify`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          expectedBindingVersion: state.bindingVersion,
          expectedAccessEpoch: state.accessEpoch,
          noticeVersion: "synthetic-d08-v1",
          evidenceRef: "synthetic:旧版本删除本人核验",
        },
      }),
    );
    const payloadBefore = await fixture.db.planRevision.findFirstOrThrow({
      where: { projectId: deleted.projectId },
      select: { content: true },
    });
    await fixture.app.close();

    phase = "explicit source and incremental upgrade";
    migrate();
    await verifyShipmentBackfill();
    const [installation] = await fixture.db.$queryRawUnsafe(
      "SELECT database_id FROM privacy_recovery_state WHERE singleton",
    );
    const key = randomBytes(32).toString("base64");
    await PrivacyJournal.bootstrap(
      { root: sourceRoot, key },
      {
        databaseId: privacyAuthorityId(
          fixture.config.databaseUrl,
          installation.database_id,
        ),
      },
    );
    fixture.config.privacyJournal = { root: sourceRoot, key };
    fixture.app = await createApplication(fixture.config, options);
    const journal = new PrivacyJournal(fixture.config.privacyJournal);
    const imported = await journal.snapshot();
    assert.ok(imported.events.some((e) => e.eventId === oldRevocation.id));
    assert.ok(
      imported.events.some(
        (e) => e.eventId === legacyId && e.payload.operation === "legacy_hold",
      ),
    );
    assert.ok(
      imported.events.some(
        (e) => e.eventId === care.id && e.payload.operation === "legacy_hold",
      ),
    );
    assert.ok(
      imported.events.some((e) => e.payload.operation === "story_decision"),
    );
    const verify = async () => {
      for (const shipped of shipmentControls) {
        const progress = fixture.data(
          await fixture.app.inject({
            method: "GET",
            url: `/v1/admin/fulfillment/${shipped.orderId}`,
            headers: shipped.headers,
          }),
          200,
        );
        assert.equal(progress.current.id, shipped.id);
        assert.equal(
          progress.current.cancellationNotice.includes("原实际发货时间待核实"),
          shipped.expected === null,
        );
      }
      assert.equal((await privatePlan(revoked)).statusCode, 403);
      assert.equal((await privatePlan(control)).statusCode, 200);
      assert.equal((await privatePlan(unknown)).statusCode, 403);
      assert.equal((await privatePlan(deleted)).statusCode, 403);
      const previousCalls = providerCalls;
      await fixture.app
        .get(ProductionTasks)
        .run(unknownTask.id)
        .catch((error: any) => {
          assert.equal(
            error.getStatus?.(),
            403,
            "unverified legacy work is refused",
          );
        });
      assert.equal(
        providerCalls,
        previousCalls,
        "a legacy hold never submits private work",
      );
      const controlledInterview = await fixture.interview(control);
      await fixture.sealedClip(control, controlledInterview.id);
      const controlledTask = await fixture.db.productionTask.findFirstOrThrow({
        where: { projectId: control.projectId },
        orderBy: { createdAt: "desc" },
      });
      for (let n = 0; n < 3; n++)
        await fixture.app.get(ProductionTasks).run(controlledTask.id);
      assert.equal(
        (
          await fixture.db.productionTask.findUniqueOrThrow({
            where: { id: controlledTask.id },
          })
        ).state,
        "succeeded",
        "unrelated new work still processes after legacy import",
      );
      assert.ok(providerCalls > previousCalls);
      assert.equal(
        fixture.data(await book(storyProject), 200).eligibleStories.length,
        0,
      );
      const pending = fixture.data(
        await fixture.request(
          "GET",
          `/v1/projects/${deleted.projectId}/deletion-status`,
          deleted.narrator.token,
        ),
        200,
      );
      assert.equal(pending.onlineAccessStopped, true);
      assert.equal(pending.permanentProjectDeletion, true);
      const items = pending.changes.flatMap((change: any) => change.items);
      assert.equal(items.length, 6);
      assert.ok(
        items.every(
          (item: any) =>
            item.state === "awaiting_evidence" && item.completedAt === null,
        ),
      );
      const held = fixture.data(
        await fixture.request(
          "GET",
          `/v1/projects/${unknown.projectId}/deletion-status`,
          unknown.narrator.token,
        ),
        200,
      );
      assert.equal(held.onlineAccessStopped, true);
      assert.equal(held.permanentProjectDeletion, false);
      const payload = await fixture.db.planRevision.findFirstOrThrow({
        where: { projectId: deleted.projectId },
        select: { content: true },
      });
      assert.deepEqual(
        payload.content,
        payloadBefore.content,
        "unknown legacy targets are not fabricated as cleared",
      );
    };
    await verify();
    await fixture.app.close();
    fixture.app = await createApplication(fixture.config, options);
    assert.equal(
      (await journal.snapshot()).generation,
      imported.generation,
      "restart does not republish history",
    );
    await verify();
    await fixture.app.close();

    phase = "restore real pre-T26 backup A";
    await fixture.db.$disconnect();
    const maintenanceUrl = new URL(fixture.config.databaseUrl);
    maintenanceUrl.searchParams.set("schema", "public");
    const maintenance = new PrismaClient({
      datasourceUrl: maintenanceUrl.toString(),
    });
    try {
      await maintenance.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await maintenance.$disconnect();
    }
    const restored = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        container(),
        "psql",
        "-U",
        "timenook",
        "-d",
        database(),
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        input: backup,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30000,
      },
    );
    assert.equal(
      restored.status,
      0,
      "real restore of the same old schema and logical file roots",
    );
    migrate();
    await verifyShipmentBackfill();
    fixture.db = new PrismaClient({
      datasourceUrl: fixture.config.databaseUrl,
    });
    await assert.rejects(
      createApplication(fixture.config, options),
      "restored installation cannot self-activate",
    );
    const configuration = join(directory, "recovery.json");
    await writeFile(configuration, JSON.stringify(fixture.config), {
      mode: 0o600,
    });
    const activated = spawnSync(
      process.execPath,
      [
        resolve(__dirname, "../src/care/privacy-recovery-cli.js"),
        "activate",
        "--test-config-file",
        configuration,
      ],
      {
        env: { ...process.env, NODE_ENV: "test" },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(
      activated.status,
      0,
      "explicit recovery replays imported history before changing authority",
    );
    fixture.app = await createApplication(fixture.config, options);
    await verify();
    assert.equal(
      (await journal.snapshot()).generation,
      imported.generation,
      "old restore adds no invented history",
    );
    return {
      oldMigrations: 40,
      importedEvents: imported.generation,
      restored: true,
    };
  } catch (error) {
    await writeFile(
      join(directory, "failure.txt"),
      String((error as Error).stack),
      { mode: 0o600 },
    );
    throw new Error(
      `Historical privacy upgrade failed at ${phase}; private diagnostic ${join(directory, "failure.txt")}`,
    );
  } finally {
    if (initialized) await fixture.stopBookFixture();
    process.chdir(cwd);
  }
}

if (process.argv[2] === "--historical-fixture") {
  void historicalUpgradeScenario(
    process.argv[3],
    process.argv[4],
    process.argv[5],
  )
    .then(
      (result) => {
        process.send?.({ ok: true, result });
      },
      (error) => {
        process.send?.({ ok: false, message: error.message });
        process.exitCode = 1;
      },
    )
    .finally(() => process.disconnect?.());
} else {
  test(
    "a real pre-T26 upgrade imports actual historical refusals before an older readable backup can reopen access",
    { timeout: 180000 },
    async (context) => {
      assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL);
      assert.ok(
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(process.env.DATABASE_URL).hostname,
        ),
      );
      assert.equal(
        new URL(process.env.DATABASE_URL).port,
        "54329",
        "the isolated Docker PostgreSQL port is required",
      );
      const currentApi = process.cwd();
      assert.equal(
        currentApi.endsWith("/apps/api"),
        true,
        "run through the API package test entry",
      );
      const directory = await mkdtemp(join(tmpdir(), "timenook-old-privacy-"));
      const oldApi = await historicalSources(directory, currentApi);
      const child = fork(
        __filename,
        ["--historical-fixture", oldApi, currentApi, directory],
        {
          execArgv: [],
          env: {
            ...process.env,
            NODE_ENV: "test",
            NODE_PATH: [
              join(directory, "historical-deps"),
              join(currentApi, "node_modules"),
              resolve(currentApi, "../../node_modules"),
            ].join(delimiter),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const abort = () => {
        child.kill("SIGKILL");
      };
      context.signal.addEventListener("abort", abort, { once: true });
      let successful = false;
      try {
        const result = await new Promise<{ ok: boolean; message?: string }>(
          (yes, no) => {
            child.once("message", (message) => yes(message as any));
            child.once("error", no);
            child.once("exit", () =>
              no(new Error("Historical upgrade process exited before proof")),
            );
          },
        );
        assert.equal(result.ok, true, result.message);
        await new Promise<void>((yes, no) =>
          child.exitCode !== null
            ? child.exitCode === 0
              ? yes()
              : no(new Error("Historical fixture failed cleanup"))
            : child.once("exit", (code) =>
                code === 0
                  ? yes()
                  : no(new Error("Historical fixture failed cleanup")),
              ),
        );
        successful = true;
      } finally {
        context.signal.removeEventListener("abort", abort);
        if (child.exitCode === null) child.kill("SIGKILL");
        if (successful) await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
