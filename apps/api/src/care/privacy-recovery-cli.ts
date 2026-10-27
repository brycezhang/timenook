import { readFile } from "node:fs/promises";
import { readConfig, type ApiConfig } from "../config";
import { recoverPrivacy } from "./privacy-recovery";
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "activate")
    throw new Error(
      "Use privacy:recover activate [--test-config-file absolute-private-file]",
    );
  let config: ApiConfig;
  if (args[1] === "--test-config-file") {
    if (
      process.env.NODE_ENV !== "test" ||
      args.length !== 3 ||
      !args[2].startsWith("/")
    )
      throw new Error("Isolated recovery fixture requires NODE_ENV=test");
    config = JSON.parse(await readFile(args[2], "utf8"));
    if (
      config.environment !== "test" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(config.databaseUrl).hostname,
      )
    )
      throw new Error("Recovery fixture requires loopback PostgreSQL");
  } else {
    if (args.length !== 1) throw new Error("Unknown recovery argument");
    config = readConfig(process.env);
  }
  const result = await recoverPrivacy(config);
  process.stdout.write(
    JSON.stringify({
      recovery: "activated",
      sourceId: result.sourceId,
      checkpoint: result.checkpoint,
    }) + "\n",
  );
}
void main().catch(() => {
  process.stderr.write(
    "Privacy recovery activation failed; private capabilities remain closed.\n",
  );
  process.exitCode = 1;
});
