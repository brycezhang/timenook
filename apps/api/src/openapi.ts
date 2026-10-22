import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApplication, createOpenApiDocument } from "./application";
import { readConfig } from "./config";

async function exportOpenApi(): Promise<void> {
  const app = await createApplication(readConfig(process.env));
  try {
    const path = resolve(__dirname, "openapi.json");
    await writeFile(
      path,
      JSON.stringify(createOpenApiDocument(app), null, 2) + "\n",
    );
    console.info(`OpenAPI exported to ${path}`);
  } finally {
    await app.close();
  }
}

void exportOpenApi().catch(() => {
  console.error("OpenAPI export failed; check server configuration");
  process.exitCode = 1;
});
