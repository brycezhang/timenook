import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  PlanContent,
  PlanQuestionState,
  PlanPreferenceDecision,
  ActualPlanQuestion,
  PlanDirectory,
  ProjectPlan,
  ProjectPlanRevision,
  TemplateReference,
} from "@timenook/contracts";
import { BUILTIN_TEMPLATE, BuiltinTemplate } from "./builtin-template";

export class ProjectPlanError extends Error {
  constructor(
    readonly code:
      | "TEMPLATE_VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "PROJECT_NOT_FOUND"
      | "PLAN_REVISION_NOT_FOUND"
      | "VERSION_CONFLICT"
      | "INVALID_PLAN"
      | "INVALID_TEMPLATE"
      | "INVALID_COMMAND",
  ) {
    super(code);
  }
}

// Server-only project creation boundary. The caller must authorize every
// operation; IDs and createdBy are not proof of identity or permission.
// No HTTP controller registers this module before T06/T11/T13 authorization.
export class ProjectPlans {
  private readonly database: PrismaClient;
  private readonly template: BuiltinTemplate;

  constructor(
    databaseUrl: string,
    template: BuiltinTemplate = BUILTIN_TEMPLATE,
  ) {
    if (
      template.id !== "timenook-default" ||
      !Number.isInteger(template.version) ||
      template.version < 1 ||
      template.version > 2147483647 ||
      template.reviewStatus !== "unreviewed-test-only"
    ) {
      throw new ProjectPlanError("INVALID_TEMPLATE");
    }
    validateContent(template.content);
    this.template = structuredClone(template);
    this.database = new PrismaClient({ datasourceUrl: databaseUrl });
  }

  // A trusted orchestrator can pass its transaction so payment/project/plan
  // commit as one unit. No payment logic or transaction is simulated here.
  async createProject(
    command: { projectId: string; createdBy: string },
    transaction?: Prisma.TransactionClient,
  ): Promise<ProjectPlan> {
    validateWrite(command.projectId, command.createdBy);
    command = { ...command };
    const template = this.template;
    const contentHash = hash(template.content);
    const create = async (tx: Prisma.TransactionClient) => {
      await initializeTemplate(tx, template);
      const inserted = await tx.project.createMany({
        data: [
          {
            id: command.projectId,
            createdBy: command.createdBy,
            sourceTemplateId: template.id,
            sourceTemplateVersion: template.version,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        await tx.planRevision.create({
          data: {
            projectId: command.projectId,
            revision: 1,
            createdBy: command.createdBy,
            content: json(template.content),
            contentHash,
          },
        });
        await tx.interviewPreferences.create({
          data: { projectId: command.projectId },
        });
        await tx.planDirectoryVersion.create({
          data: {
            projectId: command.projectId,
            version: 1,
            chapters: [],
            contentHash: hash([]),
            createdBy: command.createdBy,
          },
        });
      }
      const project = await tx.project.findUniqueOrThrow({
        where: { id: command.projectId },
      });
      if (project.createdBy !== command.createdBy)
        throw new ProjectPlanError("IDEMPOTENCY_CONFLICT");
      return readPlan(tx, command.projectId);
    };
    return transaction
      ? create(transaction)
      : this.database.$transaction(create);
  }

  async close(): Promise<void> {
    await this.database.$disconnect();
  }

  async getProjectPlan(
    projectId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<ProjectPlan> {
    validateProjectId(projectId);
    return transaction
      ? readPlan(transaction, projectId)
      : this.database.$transaction((tx) => readPlan(tx, projectId));
  }

  async getPlanRevision(
    projectId: string,
    revision: number,
  ): Promise<ProjectPlanRevision> {
    validateProjectId(projectId);
    validateVersion(revision);
    const { preferences, ...snapshot } = await this.database.$transaction(
      (tx) => readPlan(tx, projectId, revision),
    );
    return snapshot;
  }

  async initializeDefaultTemplate(): Promise<TemplateReference> {
    return this.database.$transaction((tx) =>
      initializeTemplate(tx, this.template),
    );
  }

  async revisePlan(
    command: {
      projectId: string;
      expectedVersion: number;
      createdBy: string;
      content: PlanContent;
    },
    transaction?: Prisma.TransactionClient,
  ): Promise<ProjectPlan> {
    validateWrite(command.projectId, command.createdBy);
    validateVersion(command.expectedVersion);
    validateContent(command.content);
    command = { ...command };
    const content = structuredClone(command.content);
    const revise = async (tx: Prisma.TransactionClient) => {
      const updated = await tx.project.updateMany({
        where: {
          id: command.projectId,
          currentRevision: command.expectedVersion,
        },
        data: { currentRevision: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ProjectPlanError("VERSION_CONFLICT");
      await tx.planRevision.create({
        data: {
          projectId: command.projectId,
          revision: command.expectedVersion + 1,
          createdBy: command.createdBy,
          content: json(content),
          contentHash: hash(content),
        },
      });
      return readPlan(tx, command.projectId);
    };
    return transaction
      ? revise(transaction)
      : this.database.$transaction(revise);
  }

  async directory(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanDirectory> {
    validateProjectId(projectId);
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
    const row = await tx.planDirectoryVersion.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    if (!row) throw new ProjectPlanError("PROJECT_NOT_FOUND");
    return {
      version: row.version,
      contentHash: row.contentHash,
      chapters: row.chapters as unknown as PlanDirectory["chapters"],
    };
  }
  async reviseDirectory(
    command: {
      projectId: string;
      expectedVersion: number;
      createdBy: string;
      chapters: PlanDirectory["chapters"];
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlanDirectory> {
    validateWrite(command.projectId, command.createdBy);
    validateVersion(command.expectedVersion);
    if (!Array.isArray(command.chapters))
      throw new ProjectPlanError("INVALID_COMMAND");
    const keys = new Set<string>(),
      stories = new Set<string>();
    for (const chapter of command.chapters) {
      record(chapter, ["key", "title", "storyRefs"]);
      if (
        !nonempty(chapter.key) ||
        !nonempty(chapter.title) ||
        !stringList(chapter.storyRefs) ||
        keys.has(chapter.key)
      )
        throw new ProjectPlanError("INVALID_COMMAND");
      keys.add(chapter.key);
      for (const ref of chapter.storyRefs) {
        if (stories.has(ref)) throw new ProjectPlanError("INVALID_COMMAND");
        stories.add(ref);
      }
    }
    const current = await this.directory(command.projectId, tx);
    if (current.version !== command.expectedVersion)
      throw new ProjectPlanError("VERSION_CONFLICT");
    const contentHash = hash(command.chapters);
    if (current.contentHash === contentHash) return current;
    await tx.planDirectoryVersion.create({
      data: {
        projectId: command.projectId,
        version: current.version + 1,
        contentHash,
        createdBy: command.createdBy,
        chapters: JSON.parse(JSON.stringify(command.chapters)),
      },
    });
    return {
      version: current.version + 1,
      contentHash,
      chapters: structuredClone(command.chapters),
    };
  }
  async assertDirectoryVersion(
    projectId: string,
    expectedVersion: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    validateVersion(expectedVersion);
    if ((await this.directory(projectId, tx)).version !== expectedVersion)
      throw new ProjectPlanError("VERSION_CONFLICT");
  }

  async captureActualQuestion(
    command: {
      id: string;
      projectId: string;
      expectedPlanRevision: number;
      capturedBy: string;
      questionKey?: string;
      starterKind?: "photo" | "free-narration";
    },
    tx: Prisma.TransactionClient,
  ): Promise<ActualPlanQuestion> {
    validateWrite(command.projectId, command.capturedBy);
    validateProjectId(command.id);
    validateVersion(command.expectedPlanRevision);
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${command.projectId}::uuid FOR UPDATE`;
    const prior = await tx.actualPlanQuestion.findUnique({
      where: { id: command.id },
    });
    if (prior) {
      if (
        prior.projectId !== command.projectId ||
        prior.planRevision !== command.expectedPlanRevision ||
        prior.capturedBy !== command.capturedBy ||
        prior.questionKey !== (command.questionKey ?? null) ||
        prior.starterKind !== (command.starterKind ?? null)
      )
        throw new ProjectPlanError("IDEMPOTENCY_CONFLICT");
      return actualQuestionView(prior);
    }
    const plan = await readPlan(tx, command.projectId);
    if (plan.revision !== command.expectedPlanRevision)
      throw new ProjectPlanError("VERSION_CONFLICT");
    if (!!command.questionKey === !!command.starterKind)
      throw new ProjectPlanError("INVALID_COMMAND");
    const snapshot = command.questionKey
      ? plan.chapters
          .flatMap((c) => c.questions)
          .find((q) => q.key === command.questionKey)
      : plan.starters.find((s) => s.kind === command.starterKind);
    if (!snapshot) throw new ProjectPlanError("INVALID_COMMAND");
    if (
      command.questionKey &&
      "sensitivityTags" in snapshot &&
      [command.questionKey, ...snapshot.sensitivityTags].some((topic) =>
        plan.preferences.blockedTopics.includes(topic),
      )
    )
      throw new ProjectPlanError("INVALID_COMMAND");
    return actualQuestionView(
      await tx.actualPlanQuestion.create({
        data: {
          id: command.id,
          projectId: command.projectId,
          planRevision: command.expectedPlanRevision,
          capturedBy: command.capturedBy,
          questionKey: command.questionKey,
          starterKind: command.starterKind,
          snapshot: JSON.parse(JSON.stringify(snapshot)),
        },
      }),
    );
  }
  async linkActualAnswer(
    command: { projectId: string; actualQuestionId: string; answerRef: string },
    tx: Prisma.TransactionClient,
  ): Promise<ActualPlanQuestion> {
    validateProjectId(command.projectId);
    validateProjectId(command.actualQuestionId);
    if (!nonempty(command.answerRef) || command.answerRef.length > 200)
      throw new ProjectPlanError("INVALID_COMMAND");
    await tx.$queryRaw`SELECT id FROM projects WHERE id=${command.projectId}::uuid FOR UPDATE`;
    const row = await tx.actualPlanQuestion.findUnique({
      where: { id: command.actualQuestionId },
    });
    if (!row || row.projectId !== command.projectId)
      throw new ProjectPlanError("INVALID_COMMAND");
    if (row.answerRef && row.answerRef !== command.answerRef)
      throw new ProjectPlanError("IDEMPOTENCY_CONFLICT");
    return actualQuestionView(
      await tx.actualPlanQuestion.update({
        where: { id: row.id },
        data: { answerRef: command.answerRef },
      }),
    );
  }

  async readPersonalState(projectId: string, tx: Prisma.TransactionClient) {
    const preferences = await tx.interviewPreferences.findUniqueOrThrow({
      where: { projectId },
    });
    const history = await tx.planPreferenceDecision.findMany({
      where: { projectId },
      orderBy: { version: "asc" },
    });
    return {
      actualQuestions: (
        await tx.actualPlanQuestion.findMany({
          where: { projectId },
          orderBy: { id: "asc" },
        })
      ).map(actualQuestionView),
      questionStates:
        preferences.questionStates as unknown as PlanQuestionState[],
      preferenceHistory: history.map(({ projectId: _, createdAt, ...row }) => ({
        ...row,
        method: row.method as PlanPreferenceDecision["method"],
        questionStates: row.questionStates as unknown as PlanQuestionState[],
        createdAt: createdAt.toISOString(),
      })),
    };
  }

  // Only a caller that verified this subject decision in the same transaction
  // may use this boundary. Normal plan revisions never write preferences.
  async decidePreferences(
    command: {
      projectId: string;
      expectedVersion: number;
      subjectId: string;
      operatorUserId: string;
      method: "self_wechat" | "assisted";
      assistedSessionId?: string;
      blockedTopics: string[];
      questionStates: PlanQuestionState[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    validateWrite(command.projectId, command.operatorUserId);
    validateVersion(command.expectedVersion);
    if (
      !stringList(command.blockedTopics) ||
      new Set(command.blockedTopics).size !== command.blockedTopics.length ||
      !Array.isArray(command.questionStates) ||
      new Set(command.questionStates.map((row) => row?.questionKey)).size !==
        command.questionStates.length
    )
      throw new ProjectPlanError("INVALID_COMMAND");
    const plan = await readPlan(tx, command.projectId);
    const prior = await tx.interviewPreferences.findUniqueOrThrow({
      where: { projectId: command.projectId },
    });
    const known = new Set([
      ...plan.chapters.flatMap((chapter) =>
        chapter.questions.map((q) => q.key),
      ),
      ...(prior.questionStates as unknown as PlanQuestionState[]).map(
        (row) => row.questionKey,
      ),
    ]);
    for (const row of command.questionStates) {
      record(row, ["questionKey", "state"]);
      if (
        !nonempty(row.questionKey) ||
        !known.has(row.questionKey) ||
        !["ready", "later", "skipped", "not-applicable"].includes(row.state)
      )
        throw new ProjectPlanError("INVALID_COMMAND");
    }
    const updated = await tx.interviewPreferences.updateMany({
      where: { projectId: command.projectId, version: command.expectedVersion },
      data: {
        version: { increment: 1 },
        blockedTopics: command.blockedTopics,
        questionStates: JSON.parse(JSON.stringify(command.questionStates)),
        updatedBy: command.operatorUserId,
      },
    });
    if (updated.count !== 1) throw new ProjectPlanError("VERSION_CONFLICT");
    await tx.planPreferenceDecision.create({
      data: {
        projectId: command.projectId,
        version: command.expectedVersion + 1,
        subjectId: command.subjectId,
        operatorUserId: command.operatorUserId,
        method: command.method,
        assistedSessionId: command.assistedSessionId,
        blockedTopics: command.blockedTopics,
        questionStates: JSON.parse(JSON.stringify(command.questionStates)),
      },
    });
  }

  // Only a caller that has verified the subject or assisted-session evidence
  // may invoke this command, including an explicit decision to unblock topics.
  async setBlockedTopics(
    command: {
      projectId: string;
      expectedVersion: number;
      updatedBy: string;
      blockedTopics: string[];
    },
    transaction?: Prisma.TransactionClient,
  ): Promise<ProjectPlan> {
    validateWrite(command.projectId, command.updatedBy);
    validateVersion(command.expectedVersion);
    if (
      !stringList(command.blockedTopics) ||
      new Set(command.blockedTopics).size !== command.blockedTopics.length
    ) {
      throw new ProjectPlanError("INVALID_COMMAND");
    }
    command = { ...command, blockedTopics: [...command.blockedTopics] };
    const update = async (tx: Prisma.TransactionClient) => {
      const updated = await tx.interviewPreferences.updateMany({
        where: {
          projectId: command.projectId,
          version: command.expectedVersion,
        },
        data: {
          version: { increment: 1 },
          blockedTopics: command.blockedTopics,
          updatedBy: command.updatedBy,
        },
      });
      if (updated.count !== 1) throw new ProjectPlanError("VERSION_CONFLICT");
      return readPlan(tx, command.projectId);
    };
    return transaction
      ? update(transaction)
      : this.database.$transaction(update);
  }
}

function actualQuestionView(row: {
  id: string;
  projectId: string;
  planRevision: number;
  capturedBy: string;
  questionKey: string | null;
  starterKind: string | null;
  snapshot: Prisma.JsonValue;
  answerRef: string | null;
}): ActualPlanQuestion {
  return {
    ...row,
    starterKind: row.starterKind as ActualPlanQuestion["starterKind"],
    snapshot: row.snapshot as unknown as ActualPlanQuestion["snapshot"],
  };
}

async function initializeTemplate(
  tx: Prisma.TransactionClient,
  template: BuiltinTemplate,
): Promise<TemplateReference> {
  const contentHash = hash(template.content);
  await tx.outlineTemplateVersion.createMany({
    data: [
      {
        templateId: template.id,
        version: template.version,
        contentHash,
        reviewStatus: template.reviewStatus,
        content: json(template.content),
      },
    ],
    skipDuplicates: true,
  });
  const stored = await tx.outlineTemplateVersion.findUniqueOrThrow({
    where: {
      templateId_version: {
        templateId: template.id,
        version: template.version,
      },
    },
  });
  if (
    stored.contentHash !== contentHash ||
    stored.reviewStatus !== template.reviewStatus
  ) {
    throw new ProjectPlanError("TEMPLATE_VERSION_CONFLICT");
  }
  return {
    id: stored.templateId,
    version: stored.version,
    contentHash: stored.contentHash,
    reviewStatus: template.reviewStatus,
  };
}

async function readPlan(
  tx: Prisma.TransactionClient,
  projectId: string,
  revisionNumber?: number,
): Promise<ProjectPlan> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    include: { sourceTemplate: true, preferences: true },
  });
  if (!project) throw new ProjectPlanError("PROJECT_NOT_FOUND");
  if (!project.preferences) throw new Error("Project preferences are missing");
  const revision = await tx.planRevision.findUnique({
    where: {
      projectId_revision: {
        projectId,
        revision: revisionNumber ?? project.currentRevision,
      },
    },
  });
  if (!revision) throw new ProjectPlanError("PLAN_REVISION_NOT_FOUND");
  const template = project.sourceTemplate;
  return {
    projectId: project.id,
    revision: revision.revision,
    createdBy: revision.createdBy,
    sourceTemplate: {
      id: template.templateId,
      version: template.version,
      contentHash: template.contentHash,
      reviewStatus: template.reviewStatus as TemplateReference["reviewStatus"],
    },
    ...(revision.content as unknown as PlanContent),
    contentHash: revision.contentHash,
    preferences: {
      version: project.preferences.version,
      blockedTopics: project.preferences.blockedTopics,
    },
  };
}

function json(content: PlanContent): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(content));
}

function hash(content: unknown): string {
  const canonical = JSON.stringify(content, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProjectId(projectId: string): void {
  if (
    typeof projectId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId,
    )
  ) {
    throw new ProjectPlanError("INVALID_COMMAND");
  }
}

function validateWrite(projectId: string, actor: string): void {
  validateProjectId(projectId);
  if (!nonempty(actor)) throw new ProjectPlanError("INVALID_COMMAND");
}

function validateVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version >= 2147483647)
    throw new ProjectPlanError("INVALID_COMMAND");
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new ProjectPlanError("INVALID_PLAN");
  }
  return value as Record<string, unknown>;
}

function validateContent(value: unknown): asserts value is PlanContent {
  const content = record(value, ["chapters", "starters"]);
  if (!Array.isArray(content.chapters) || !Array.isArray(content.starters))
    throw new ProjectPlanError("INVALID_PLAN");
  const chapters = new Set<string>();
  const questions = new Set<string>();
  for (const value of content.chapters) {
    const chapter = record(value, ["key", "title", "questions"]);
    if (
      !nonempty(chapter.key) ||
      chapters.has(chapter.key) ||
      !nonempty(chapter.title) ||
      !Array.isArray(chapter.questions)
    ) {
      throw new ProjectPlanError("INVALID_PLAN");
    }
    chapters.add(chapter.key);
    for (const value of chapter.questions) {
      const question = record(value, [
        "key",
        "text",
        "intent",
        "optionalContext",
        "sensitivityTags",
        "followupCandidates",
        "locale",
      ]);
      if (
        !nonempty(question.key) ||
        questions.has(question.key) ||
        !nonempty(question.text) ||
        !nonempty(question.intent) ||
        !stringList(question.optionalContext) ||
        !stringList(question.sensitivityTags) ||
        !stringList(question.followupCandidates) ||
        question.locale !== "zh-CN"
      ) {
        throw new ProjectPlanError("INVALID_PLAN");
      }
      questions.add(question.key);
    }
  }
  const starters = new Set<string>();
  for (const value of content.starters) {
    const starter = record(value, ["kind", "text", "intent"]);
    if (
      (starter.kind !== "photo" && starter.kind !== "free-narration") ||
      starters.has(starter.kind) ||
      !nonempty(starter.text) ||
      !nonempty(starter.intent)
    )
      throw new ProjectPlanError("INVALID_PLAN");
    starters.add(starter.kind);
  }
  if (starters.size !== 2) throw new ProjectPlanError("INVALID_PLAN");
}
