import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { PrismaClient } from "@prisma/client";
import { LocalProbeObjects } from "./local-objects";
import { OssProbeObjects } from "./oss-objects";
import Redis from "ioredis";
import { readConfig } from "../config";

async function main() {
  const config = readConfig(process.env);
  const cleaning = process.argv[2] === "--clean";
  const output = process.argv[cleaning ? 3 : 2];
  if (
    !config.audioProbe ||
    config.environment === "production" ||
    !output ||
    !isAbsolute(output)
  )
    throw new Error(
      "Explicit local probe configuration and absolute private output path required",
    );
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0 });
  redis.on("error", () => {});
  if (cleaning) {
    const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
    try {
      if ((await stat(output)).mode & 0o077)
        throw new Error("Private identity file required");
      const identity = JSON.parse(await readFile(output, "utf8"));
      if (
        !/^[0-9a-f-]{36}$/.test(identity.id) ||
        !/^p2_[A-Za-z0-9_-]{43}$/.test(identity.token)
      )
        throw new Error("Invalid identity");
      await redis.del(
        `${config.redisKeyPrefix ?? "timenook"}:probe:session:${createHash("sha256").update(identity.token).digest("hex")}`,
      );
      const oss = config.audioProbe.oss;
      const scope = createHash("sha256")
        .update(
          oss
            ? `oss:${oss.bucket}:${oss.region}`
            : `local:${config.audioProbe.storageRoot}`,
        )
        .digest("hex");
      const objects = oss
        ? new OssProbeObjects(oss)
        : new LocalProbeObjects(config.audioProbe.storageRoot);
      const clips = await db.probeClip.findMany({
        where: { ownerId: identity.id, storageScope: scope },
      });
      for (const clip of clips) {
        await objects.remove(`staging/${clip.id}.mp3`);
        await objects.remove(`sealed/${clip.id}.mp3`);
        await db.probeClip.delete({ where: { id: clip.id } });
      }
      await rm(output);
      console.log("Selected probe identity and object cleanup completed.");
    } finally {
      await db.$disconnect();
      redis.disconnect();
    }
    return;
  }
  const token = `p2_${randomBytes(32).toString("base64url")}`;
  const ttl = config.audioProbe.sessionTtlSeconds ?? 3600;
  const identity = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
  const key = `${config.redisKeyPrefix ?? "timenook"}:probe:session:${createHash("sha256").update(token).digest("hex")}`;
  try {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, JSON.stringify({ ...identity, token }), {
      mode: 0o600,
      flag: "wx",
    });
    await redis.set(key, JSON.stringify(identity), "EX", ttl);
    console.log(
      "Private probe identity file created; expires in at most one hour.",
    );
  } finally {
    redis.disconnect();
  }
}
void main().catch(() => {
  console.error(
    "Probe provisioning failed; check local configuration and a fresh private output path.",
  );
  process.exitCode = 1;
});
