import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { ProjectPlans } from "../src/projects/project-plans";
import { BUILTIN_TEMPLATE } from "../src/projects/builtin-template";
import { createApplication } from "../src/application";

// Only database lifecycle setup/teardown uses Prisma. All behavior and
// persistence assertions use the public project creation/query boundary.
const schema = `t09_${randomUUID().replaceAll("-", "")}`;
let databaseUrl: string;
let plans: ProjectPlans;

before(() => {
  assert.ok(process.env.DATABASE_URL, "A real PostgreSQL database is required");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  databaseUrl = url.toString();
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    "Isolated integration schema migration failed",
  );
  plans = new ProjectPlans(databaseUrl);
});

after(async () => {
  await plans?.close();
  if (!databaseUrl) return;
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await database.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    );
  } finally {
    await database.$disconnect();
  }
});

test("a new project starts with neutral questions plus photo and free narration", async () => {
  const projectId = randomUUID();
  const plan = await plans.createProject({
    projectId,
    createdBy: "synthetic-initiator",
  });
  assert.equal(plan.projectId, projectId);
  assert.equal(plan.revision, 1);
  assert.deepEqual(plan.sourceTemplate, {
    id: "timenook-default",
    version: 1,
    contentHash: plan.sourceTemplate.contentHash,
    reviewStatus: "unreviewed-test-only",
  });
  assert.match(plan.sourceTemplate.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    plan.chapters.map((chapter) => chapter.title),
    ["记得的地方", "生活里的片段", "想留下的话"],
  );
  assert.equal(
    plan.chapters[0].questions[0].text,
    "有没有一个地方，你现在还想说说它的样子？",
  );
  assert.equal(
    plan.chapters[0].questions[0].intent,
    "从本人选择的地点回忆一个具体场景",
  );
  assert.deepEqual(
    plan.starters.map((starter) => starter.kind),
    ["photo", "free-narration"],
  );
  assert.deepEqual(plan.preferences, { version: 1, blockedTopics: [] });
  assert.doesNotMatch(
    JSON.stringify(plan.chapters),
    /丈夫|妻子|孩子|结婚|退休|职业/,
  );
});

test("repeated and concurrent project creation restores one durable plan after restart", async () => {
  const command = { projectId: randomUUID(), createdBy: "synthetic-initiator" };
  const original = await plans.createProject(command);
  const repeats = await Promise.all(
    Array.from({ length: 8 }, () => plans.createProject(command)),
  );
  for (const repeat of repeats) assert.deepEqual(repeat, original);
  const restarted = new ProjectPlans(databaseUrl);
  try {
    assert.deepEqual(
      await restarted.getProjectPlan(command.projectId),
      original,
    );
    assert.deepEqual(await restarted.createProject(command), original);
  } finally {
    await restarted.close();
  }
});

test("initializing the same template version is idempotent and refuses changed code content", async () => {
  const original = await plans.createProject({
    projectId: randomUUID(),
    createdBy: "synthetic-initiator",
  });
  assert.deepEqual(
    await plans.initializeDefaultTemplate(),
    original.sourceTemplate,
  );
  assert.deepEqual(
    await plans.initializeDefaultTemplate(),
    original.sourceTemplate,
  );
  const changed = structuredClone(BUILTIN_TEMPLATE);
  changed.content.chapters[0].title = "同版本不能替换的内容";
  const badRelease = new ProjectPlans(databaseUrl, changed);
  try {
    await assert.rejects(badRelease.initializeDefaultTemplate(), {
      code: "TEMPLATE_VERSION_CONFLICT",
    });
    assert.deepEqual(await plans.getProjectPlan(original.projectId), original);
  } finally {
    await badRelease.close();
  }
});

test("a project creation replay by a different initiator is a conflict", async () => {
  const command = {
    projectId: randomUUID(),
    createdBy: "synthetic-initiator-a",
  };
  const original = await plans.createProject(command);
  await assert.rejects(
    plans.createProject({ ...command, createdBy: "synthetic-initiator-b" }),
    {
      code: "IDEMPOTENCY_CONFLICT",
    },
  );
  assert.deepEqual(await plans.getProjectPlan(command.projectId), original);
});

test("project and initial plan participate in the caller transaction and roll back together", async () => {
  const command = { projectId: randomUUID(), createdBy: "synthetic-initiator" };
  const caller = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assert.rejects(
      caller.$transaction(async (transaction) => {
        const created = await plans.createProject(command, transaction);
        assert.equal(created.revision, 1);
        throw new Error("Synthetic calling use case failed");
      }),
      /Synthetic calling use case failed/,
    );
    await assert.rejects(plans.getProjectPlan(command.projectId), {
      code: "PROJECT_NOT_FOUND",
    });
    const committed = await caller.$transaction((transaction) =>
      plans.createProject(command, transaction),
    );
    assert.deepEqual(await plans.getProjectPlan(command.projectId), committed);
  } finally {
    await caller.$disconnect();
  }
});

test("a code release preserves each old project's personal revision and blocked topics", async () => {
  const command = { projectId: randomUUID(), createdBy: "synthetic-initiator" };
  const original = await plans.createProject(command);
  const neighbor = await plans.createProject({
    ...command,
    projectId: randomUUID(),
  });
  await plans.setBlockedTopics({
    projectId: original.projectId,
    expectedVersion: 1,
    updatedBy: "synthetic-subject",
    blockedTopics: ["work"],
  });
  const content = {
    chapters: structuredClone(original.chapters),
    starters: original.starters,
  };
  content.chapters[0].title = "我自己改的章节";
  content.chapters[0].questions[0].text = "那条熟悉的小路，你记得什么？";
  const personal = await plans.revisePlan({
    projectId: original.projectId,
    expectedVersion: 1,
    createdBy: "synthetic-initiator",
    content,
  });
  assert.equal(personal.revision, 2);
  assert.equal(personal.chapters[0].title, "我自己改的章节");
  assert.equal(
    personal.chapters[0].questions[0].text,
    "那条熟悉的小路，你记得什么？",
  );
  assert.deepEqual(personal.preferences, {
    version: 2,
    blockedTopics: ["work"],
  });
  assert.notEqual(personal.contentHash, original.contentHash);
  const nextRelease = structuredClone(BUILTIN_TEMPLATE);
  nextRelease.version = 2;
  nextRelease.content.chapters[0].title = "新版默认章节";
  const upgraded = new ProjectPlans(databaseUrl, nextRelease);
  try {
    const fresh = await upgraded.createProject({
      ...command,
      projectId: randomUUID(),
    });
    assert.equal(fresh.sourceTemplate.version, 2);
    assert.notEqual(
      fresh.sourceTemplate.contentHash,
      original.sourceTemplate.contentHash,
    );
    assert.equal(fresh.chapters[0].title, "新版默认章节");
    assert.deepEqual(fresh.preferences, { version: 1, blockedTopics: [] });
    assert.deepEqual(await upgraded.createProject(command), personal);
    assert.deepEqual(
      await upgraded.getProjectPlan(original.projectId),
      personal,
    );
    assert.deepEqual(
      await upgraded.getProjectPlan(neighbor.projectId),
      neighbor,
    );
    await plans.initializeDefaultTemplate();
    assert.deepEqual(await plans.getProjectPlan(original.projectId), personal);
    assert.deepEqual(await plans.getProjectPlan(fresh.projectId), fresh);
  } finally {
    await upgraded.close();
  }
});

test("concurrent personal edits keep one winner and immutable project-scoped history", async () => {
  const original = await plans.createProject({
    projectId: randomUUID(),
    createdBy: "synthetic-initiator",
  });
  const neighbor = await plans.createProject({
    projectId: randomUUID(),
    createdBy: "synthetic-initiator",
  });
  const results = await Promise.allSettled(
    ["synthetic-initiator", "synthetic-subject"].map((createdBy) => {
      const content = {
        chapters: structuredClone(original.chapters),
        starters: original.starters,
      };
      content.chapters[0].title = createdBy;
      return plans.revisePlan({
        projectId: original.projectId,
        expectedVersion: 1,
        createdBy,
        content,
      });
    }),
  );
  const winners = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.code, "VERSION_CONFLICT");
  const current = await plans.getProjectPlan(original.projectId);
  assert.deepEqual(current, winners[0].value);
  assert.equal(current.revision, 2);
  const { preferences, ...firstRevision } = original;
  assert.deepEqual(
    await plans.getPlanRevision(original.projectId, 1),
    firstRevision,
  );
  await assert.rejects(plans.getPlanRevision(neighbor.projectId, 2), {
    code: "PLAN_REVISION_NOT_FOUND",
  });
  assert.deepEqual(await plans.getProjectPlan(neighbor.projectId), neighbor);
});

test("template identity uses canonical content and captures the code release at construction", async () => {
  const reference = await plans.initializeDefaultTemplate();
  const equivalent = structuredClone(BUILTIN_TEMPLATE);
  equivalent.content = {
    starters: equivalent.content.starters,
    chapters: equivalent.content.chapters,
  };
  const release = new ProjectPlans(databaseUrl, equivalent);
  try {
    assert.deepEqual(await release.initializeDefaultTemplate(), reference);
    equivalent.content.chapters[0].title = "调用方后来修改的对象";
    assert.deepEqual(await release.initializeDefaultTemplate(), reference);
    const project = await release.createProject({
      projectId: randomUUID(),
      createdBy: "synthetic-initiator",
    });
    assert.equal(project.chapters[0].title, "记得的地方");
  } finally {
    await release.close();
  }
});

test("invalid personal plan content cannot consume a revision or replace project metadata", async () => {
  const original = await plans.createProject({
    projectId: randomUUID(),
    createdBy: "synthetic-initiator",
  });
  const duplicateQuestion = {
    chapters: structuredClone(original.chapters),
    starters: original.starters,
  };
  duplicateQuestion.chapters[1].questions[0].key =
    duplicateQuestion.chapters[0].questions[0].key;
  const duplicateChapter = {
    chapters: structuredClone(original.chapters),
    starters: original.starters,
  };
  duplicateChapter.chapters[1].key = duplicateChapter.chapters[0].key;
  const injectedMetadata = Object.assign(
    { chapters: original.chapters, starters: original.starters },
    {
      projectId: randomUUID(),
      preferences: { version: 99, blockedTopics: [] },
    },
  );
  const emptyQuestion = {
    chapters: structuredClone(original.chapters),
    starters: original.starters,
  };
  emptyQuestion.chapters[0].questions[0].text = "   ";
  for (const content of [
    duplicateQuestion,
    duplicateChapter,
    injectedMetadata,
    emptyQuestion,
  ]) {
    await assert.rejects(
      plans.revisePlan({
        projectId: original.projectId,
        expectedVersion: 1,
        createdBy: "synthetic-initiator",
        content,
      }),
      { code: "INVALID_PLAN" },
    );
    assert.deepEqual(await plans.getProjectPlan(original.projectId), original);
  }
  const blank = await plans.revisePlan({
    projectId: original.projectId,
    expectedVersion: 1,
    createdBy: "synthetic-subject",
    content: { chapters: [], starters: original.starters },
  });
  assert.equal(blank.revision, 2);
  assert.deepEqual(blank.chapters, []);
  assert.deepEqual(blank.starters, original.starters);
});

test("a code release accepts only the one built-in template and a positive integer version", () => {
  for (const invalid of [
    { ...BUILTIN_TEMPLATE, id: "another-template" },
    { ...BUILTIN_TEMPLATE, version: 0 },
    { ...BUILTIN_TEMPLATE, version: 1.5 },
  ]) {
    assert.throws(() => new ProjectPlans(databaseUrl, invalid), {
      code: "INVALID_TEMPLATE",
    });
  }
});

test("blocked-topic changes validate the command and reject stale concurrent decisions", async () => {
  const original = await plans.createProject({
    projectId: randomUUID(),
    createdBy: "synthetic-initiator",
  });
  for (const invalid of [
    { expectedVersion: 1, updatedBy: "", blockedTopics: ["work"] },
    { expectedVersion: 1, updatedBy: "synthetic-subject", blockedTopics: [""] },
    {
      expectedVersion: 0,
      updatedBy: "synthetic-subject",
      blockedTopics: ["work"],
    },
  ]) {
    await assert.rejects(
      plans.setBlockedTopics({ projectId: original.projectId, ...invalid }),
      { code: "INVALID_COMMAND" },
    );
    assert.deepEqual(await plans.getProjectPlan(original.projectId), original);
  }
  const results = await Promise.allSettled(
    ["work", "family"].map((topic) =>
      plans.setBlockedTopics({
        projectId: original.projectId,
        expectedVersion: 1,
        updatedBy: "synthetic-subject",
        blockedTopics: [topic],
      }),
    ),
  );
  const winners = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.code, "VERSION_CONFLICT");
  const current = await plans.getProjectPlan(original.projectId);
  assert.deepEqual(current, winners[0].value);
  assert.equal(current.preferences.version, 2);
  assert.equal(current.revision, 1);
});

test("production does not expose project, personal-edit, or template administration routes", async () => {
  assert.ok(process.env.REDIS_URL);
  const app = await createApplication({
    environment: "production",
    host: "127.0.0.1",
    port: 3417,
    databaseUrl,
    redisUrl: process.env.REDIS_URL,
  });
  try {
    const id = randomUUID();
    for (const prefix of ["", "/v1"]) {
      for (const url of [
        `${prefix}/projects`,
        `${prefix}/projects/${id}/plan-revisions`,
        `${prefix}/outline-templates`,
      ]) {
        const response = await app.inject({ method: "POST", url, payload: {} });
        assert.equal(response.statusCode, 404);
        assert.equal(response.json().error.code, "NOT_FOUND");
      }
      const read = await app.inject({
        method: "GET",
        url: `${prefix}/projects/${id}/plan`,
      });
      assert.equal(read.statusCode, 404);
    }
  } finally {
    await app.close();
  }
});
