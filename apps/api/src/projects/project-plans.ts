import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  PlanContent,
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

  async getProjectPlan(projectId: string): Promise<ProjectPlan> {
    validateProjectId(projectId);
    return this.database.$transaction((tx) => readPlan(tx, projectId));
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

  async revisePlan(command: {
    projectId: string;
    expectedVersion: number;
    createdBy: string;
    content: PlanContent;
  }): Promise<ProjectPlan> {
    validateWrite(command.projectId, command.createdBy);
    validateVersion(command.expectedVersion);
    validateContent(command.content);
    command = { ...command };
    const content = structuredClone(command.content);
    return this.database.$transaction(async (tx) => {
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
    });
  }

  // Only a caller that has verified the subject or assisted-session evidence
  // may invoke this command, including an explicit decision to unblock topics.
  async setBlockedTopics(command: {
    projectId: string;
    expectedVersion: number;
    updatedBy: string;
    blockedTopics: string[];
  }): Promise<ProjectPlan> {
    validateWrite(command.projectId, command.updatedBy);
    validateVersion(command.expectedVersion);
    if (
      !stringList(command.blockedTopics) ||
      new Set(command.blockedTopics).size !== command.blockedTopics.length
    ) {
      throw new ProjectPlanError("INVALID_COMMAND");
    }
    command = { ...command, blockedTopics: [...command.blockedTopics] };
    return this.database.$transaction(async (tx) => {
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
    });
  }
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

function hash(content: PlanContent): string {
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
