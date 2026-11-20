import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { isUUID } from "class-validator";
import { createApplication } from "../application";
import { readConfig } from "../config";
import { Catalog } from "./catalog";
const usage =
  "Expected publish-e2e --operator-label <deployment-run-label> or " +
  "publish-manual-v12 --draft-id <uuid> --expected-revision <revision> " +
  "--operator-label <deployment-run-label>";

/** Restricted server operator entry. Record the operator run in the version transaction. */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const label = args.at(-1);
  if (
    args.at(-2) !== "--operator-label" ||
    !label ||
    !/^[A-Za-z0-9_:-]{3,80}$/.test(label)
  )
    throw new Error(usage);

  const [draftFlag, draftId, revisionFlag, revision] = args;
  const expectedRevision = Number(revision);
  if (command === "publish-e2e") {
    if (args.length !== 2) throw new Error(usage);
  } else if (
    command !== "publish-manual-v12" ||
    args.length !== 6 ||
    draftFlag !== "--draft-id" ||
    !isUUID(draftId) ||
    revisionFlag !== "--expected-revision" ||
    !/^[1-9]\d*$/.test(revision) ||
    !Number.isSafeInteger(expectedRevision)
  ) {
    throw new Error(usage);
  }

  const app = await createApplication(readConfig(process.env));
  try {
    const catalog = app.get(Catalog);
    const version = await catalog.database.$transaction(async (tx) => {
      const result =
        command === "publish-e2e"
          ? await catalog.publishE2e(tx)
          : await catalog.publishManualV12(tx, draftId, expectedRevision);
      await tx.adminAudit.create({
        data: {
          id: randomUUID(),
          operatorId: null,
          action:
            command === "publish-e2e"
              ? "catalog.e2e.publish.server"
              : "catalog.production.manual-v12.publish.server",
          requestId: `${label}:${randomUUID()}`,
          resourceType: "package_version",
          resourceId: result.id,
          result: "success",
        },
      });
      return result;
    });
    process.stdout.write(
      JSON.stringify({
        id: version.id,
        sequence: version.sequence,
        purpose: version.purpose,
        listAmount: version.price.value,
      }) + "\n",
    );
  } finally {
    await app.close();
  }
}
void main().catch((error: unknown) => {
  const detail =
    error instanceof HttpException
      ? " (status " + error.getStatus() + ")"
      : error instanceof Error && error.message === usage
        ? "\n" + usage
        : "";
  process.stderr.write("Catalog publication failed" + detail + "\n");
  process.exitCode = 1;
});
