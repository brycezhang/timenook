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

const active = new Map<string, Map<Readable, number>>();
/** Called only after the epoch transaction commits. Each process also checks PostgreSQL. */
export function closeProjectStreams(projectId: string, beforeEpoch?: number) {
  for (const [stream, epoch] of active.get(projectId) ?? []) {
    if (beforeEpoch !== undefined && epoch >= beforeEpoch) continue;
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
  ) {
    this.db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  }
  async userEpoch(projectId: string, authorization: string | undefined) {
    await this.identity.current(authorization);
    return this.epoch(projectId);
  }
  async epoch(projectId: string) {
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: { accessEpoch: true },
    });
    if (!project) throw new ForbiddenException();
    return project.accessEpoch;
  }
  /** The caller still owns its exact file/version, current purpose and expiry checks. */
  async guard(
    projectId: string,
    epoch: number,
    bytes: Buffer,
    check: () => Promise<unknown>,
    authorization?: string,
  ): Promise<Readable> {
    const verify = async () => {
      if (authorization) await this.identity.current(authorization);
      const p = await this.db.project.findUnique({
        where: { id: projectId },
        select: { accessEpoch: true },
      });
      if (!p || p.accessEpoch !== epoch) throw new ForbiddenException();
      await check();
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
    const set = active.get(projectId) ?? new Map<Readable, number>();
    active.set(projectId, set);
    set.set(stream, epoch);
    // Covers revocation from another API process, session expiry and idle backpressure.
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
