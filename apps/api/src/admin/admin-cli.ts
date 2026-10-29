import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { isAdminPermission } from "@timenook/contracts";
import type {
  AdminProvisionCommand,
  AdminProvisionResult,
} from "@timenook/contracts";
import { readConfig } from "../config";

async function main() {
  const [command, flag, path, ...extra] = process.argv.slice(2);
  if (
    !["create", "disable"].includes(command) ||
    flag !== "--input-file" ||
    !path ||
    extra.length
  )
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
  const allowed =
    command === "create"
      ? [
          "username",
          "realm",
          "permissions",
          "feishuAppId",
          "feishuOpenId",
          "tenantKey",
        ]
      : ["username", "realm"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new Error();
  const realm = config.environment === "production" ? "production" : "local";
  if (
    input.realm !== realm ||
    typeof input.username !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.username) ||
    (command === "create" &&
      (!config.admin.feishu ||
        input.feishuAppId !== config.admin.feishu.appId ||
        input.tenantKey !== config.admin.feishu.tenantKey ||
        typeof input.feishuOpenId !== "string" ||
        !/^ou_[A-Za-z0-9_-]{1,128}$/.test(input.feishuOpenId) ||
        !Array.isArray(input.permissions) ||
        !input.permissions.every(isAdminPermission)))
  )
    throw new Error();
  const commandInput: AdminProvisionCommand = {
    username: input.username,
    feishuAppId: input.feishuAppId,
    feishuOpenId: input.feishuOpenId,
    tenantKey: input.tenantKey,
    realm,
    permissions: input.permissions,
  };
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    let id: string = randomUUID();
    await database.$transaction(async (tx) => {
      if (command === "disable") {
        const account = await tx.adminAccount.findUniqueOrThrow({
          where: { realm_username: { realm, username: input.username } },
        });
        id = account.id;
        await tx.adminAccount.update({
          where: { id },
          data: { disabled: true },
        });
      } else
        await tx.adminAccount.create({
          data: {
            id,
            realm,
            username: commandInput.username,
            feishuAppId: commandInput.feishuAppId,
            feishuOpenId: commandInput.feishuOpenId,
            tenantKey: commandInput.tenantKey,
            permissions: [...new Set(commandInput.permissions)],
          },
        });
      await tx.adminAudit.create({
        data: {
          id: randomUUID(),
          operatorId: null,
          action: command === "create" ? "admin.provision" : "admin.disable",
          requestId: randomUUID(),
          result: "success",
        },
      });
    });
    console.info(
      JSON.stringify({
        id,
        realm,
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
