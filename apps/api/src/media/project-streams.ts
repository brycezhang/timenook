import { PrivacyRights } from "../care/privacy-rights";
import {
  Injectable,
  Inject,
  OnModuleDestroy,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { API_CONFIG, ApiConfig } from "../config";
import { IdentityAccess } from "../identity/identity-access";

export type ProjectStreamFence = { epoch: number; sequence: number };
const active = new Map<
  string,
  Map<Readable, { sequence: number; usesSharing: boolean }>
>();
/** A replay only closes streams that began before this committed revocation. */
export function closeProjectStreams(
  projectId: string,
  sequence: number,
  purpose: string,
  assisted: boolean,
) {
  if (assisted && purpose === "ai") return;
  for (const [stream, fence] of active.get(projectId) ?? []) {
    if (
      fence.sequence >= sequence ||
      (assisted && purpose === "sharing" && !fence.usesSharing)
    )
      continue;
    stream.destroy(
      new ForbiddenException("Current project access was revoked"),
    );
  }
}
@Injectable()
export class ProjectStreams implements OnModuleDestroy {
  private readonly db: PrismaClient;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly identity: IdentityAccess,
    private readonly rights: PrivacyRights,
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  async userEpoch(projectId: string, authorization: string | undefined) {
    return (await this.userFence(projectId, authorization)).epoch;
  }
  async epoch(projectId: string) {
    return (await this.fence(projectId)).epoch;
  }
  async userFence(
    projectId: string,
    authorization: string | undefined,
    scope?: "bookPdf",
  ) {
    const user = await this.identity.current(authorization);
    return this.fence(
      projectId,
      await this.usesSharing(projectId, user.id),
      scope,
    );
  }
  async fence(
    projectId: string,
    usesSharing = true,
    scope?: "bookPdf",
  ): Promise<ProjectStreamFence> {
    await this.rights.assertReplayed(projectId, scope);
    if (await this.rights.deletedIn(this.db as never, projectId))
      throw new ForbiddenException();
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: { accessEpoch: true },
    });
    if (!project) throw new ForbiddenException();
    return {
      epoch: project.accessEpoch,
      sequence: await this.sequence(projectId, usesSharing),
    };
  }
  private async usesSharing(projectId: string, userId: string) {
    const subject = await this.db.projectSubject.findUnique({
      where: { projectId },
      select: { boundUserId: true },
    });
    return subject?.boundUserId !== userId;
  }
  private async sequence(projectId: string, usesSharing = true) {
    const latest = await this.db.projectAccessRevocation.findFirst({
      where: {
        projectId,
        OR: [
          { reason: { not: "assisted" } },
          {
            purpose: {
              in: usesSharing
                ? ["collection", "sharing", "all", "binding"]
                : ["collection", "all", "binding"],
            },
          },
        ],
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    return latest?.sequence ?? 0;
  }
  /** Capture before file I/O where possible; callers retain exact purpose/version/expiry checks. */
  async guard(
    projectId: string,
    epoch: number,
    bytes: Buffer,
    check: () => Promise<unknown>,
    authorization?: string,
    capturedSequence?: number,
    // Only a content owner with its own current operational grant uses this.
    // Product Authorization always derives purpose from the real user instead.
    usesSharingOverride?: boolean,
    scope?: "bookPdf",
  ): Promise<Readable> {
    const user = authorization
      ? await this.identity.current(authorization)
      : null;
    const usesSharing = user
      ? await this.usesSharing(projectId, user.id)
      : (usesSharingOverride ?? true);
    const sequence =
      capturedSequence ?? (await this.sequence(projectId, usesSharing));
    const currentFence = async () => {
      const fence = await this.fence(projectId, usesSharing, scope);
      if (fence.epoch !== epoch || fence.sequence !== sequence)
        throw new ForbiddenException();
    };
    const verify = async () => {
      if (authorization) await this.identity.current(authorization);
      await currentFence();
      await check();
      // A scope read can wait behind a transaction that publishes a denial
      // and then rolls back. Its old PG grant cannot authorize the next chunk.
      await currentFence();
    };
    await verify();
    let stream!: Readable;
    stream = Readable.from(
      (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          await verify();
          if (stream.destroyed) return;
          yield bytes.subarray(offset, Math.min(bytes.length, offset + 65536));
          await nextTurn();
        }
      })(),
      { highWaterMark: 65536, objectMode: false },
    );
    const set =
      active.get(projectId) ??
      new Map<Readable, { sequence: number; usesSharing: boolean }>();
    active.set(projectId, set);
    set.set(stream, { sequence, usesSharing });
    let checking = false;
    const timer = setInterval(() => {
      if (checking || stream.destroyed) return;
      checking = true;
      void verify()
        .catch(() => stream.destroy(new ForbiddenException()))
        .finally(() => {
          checking = false;
        });
    }, 100);
    timer.unref();
    stream.once("close", () => {
      clearInterval(timer);
      set.delete(stream);
      if (!set.size) active.delete(projectId);
    });
    return stream;
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}
