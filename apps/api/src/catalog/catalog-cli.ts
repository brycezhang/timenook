import { randomUUID } from "node:crypto";
import { createApplication } from "../application";
import { readConfig } from "../config";
import { Catalog } from "./catalog";
/** Restricted server operator entry; no simulated Feishu identity or commercial approval. */
async function main() {
  const [command, flag, label, ...extra] = process.argv.slice(2);
  if (
    command !== "publish-e2e" ||
    flag !== "--operator-label" ||
    !label ||
    !/^[A-Za-z0-9_:-]{3,80}$/.test(label) ||
    extra.length
  )
    throw new Error(
      "Expected publish-e2e --operator-label <deployment-run-label>",
    );
  const app = await createApplication(readConfig(process.env));
  try {
    const catalog = app.get(Catalog);
    const version = await catalog.database.$transaction(async (tx) => {
      const result = await catalog.publishE2e(tx);
      await tx.adminAudit.create({
        data: {
          id: randomUUID(),
          operatorId: null,
          action: "catalog.e2e.publish.server",
          requestId: `${label}:${randomUUID()}`,
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
void main().catch(() => {
  process.stderr.write(
    "E2E publication failed; check server configuration and operator arguments\n",
  );
  process.exitCode = 1;
});
