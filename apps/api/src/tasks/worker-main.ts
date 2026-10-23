import { readConfig } from "../config";
import { launchProductionWorker } from "./worker";

async function main() {
  const runtime = await launchProductionWorker(readConfig(process.env));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
void main().catch(() => {
  process.stderr.write("Worker configuration or dependencies unavailable\n");
  process.exitCode = 1;
});
