import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { generateSecret } from "otplib";
import { isAdminPermission } from "@timenook/contracts";
import type {
  AdminProvisionCommand,
  AdminProvisionResult,
} from "@timenook/contracts";
import { readConfig } from "../config";
import { encryptSecret, hashPassword } from "./secrets";

async function main() {
  const [command, flag, path, ...extra] = process.argv.slice(2);
  if (command !== "create" || flag !== "--input-file" || !path || extra.length)
    throw new Error();
  const config = readConfig(process.env);
  if (!config.admin) throw new Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 8192
    )
      throw new Error();
    input = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  const realm = config.environment === "production" ? "production" : "local";
  if (
    input.realm !== realm ||
    typeof input.username !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.username) ||
    typeof input.password !== "string" ||
    input.password.length < 16 ||
    input.password.length > 128 ||
    !Array.isArray(input.permissions) ||
    !input.permissions.every(isAdminPermission)
  )
    throw new Error();
  const commandInput: AdminProvisionCommand = {
    username: input.username,
    password: input.password,
    realm,
    permissions: input.permissions,
  };
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const id = randomUUID();
    await database.$transaction(async (tx) => {
      await tx.adminAccount.create({
        data: {
          id,
          realm,
          username: commandInput.username,
          passwordHash: await hashPassword(commandInput.password),
          mfaSecret: encryptSecret(
            generateSecret(),
            config.admin!.encryptionKey,
          ),
          permissions: [...new Set(commandInput.permissions)],
        },
      });
      await tx.adminAudit.create({
        data: {
          id: randomUUID(),
          operatorId: null,
          action: "admin.provision",
          requestId: randomUUID(),
          result: "success",
        },
      });
    });
    console.info(
      JSON.stringify({
        id,
        realm,
        mfaEnrollmentRequired: true,
      } satisfies AdminProvisionResult),
    );
  } finally {
    await database.$disconnect();
  }
}
void main().catch(() => {
  console.error(
    "Admin command failed: check configuration, owner-only input and account uniqueness",
  );
  process.exitCode = 1;
});
