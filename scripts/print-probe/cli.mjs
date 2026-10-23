import { mkdir, rm, rename, lstat, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runBounded } from "../../apps/api/runtime/bounded-process.mjs";
import { fileURLToPath } from "node:url";

// S0 only. These are local probe ceilings, not product/printing specifications.
if (
  process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
  process.env.NODE_ENV === "production"
) {
  console.error("PRINT_PROBE_DISABLED");
  process.exit(1);
}
const [command, input, output, ...args] = process.argv.slice(2);

let staging;
try {
  if (!["photo", "book", "inspect"].includes(command) || !input || !output)
    throw Error("INVALID_COMMAND");
  const target = resolve(output);
  if (
    await lstat(target).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw Error("OUTPUT_ALREADY_EXISTS");
  const maximumRss = command === "photo" ? 384 : 2048,
    maximumTime = command === "photo" ? 15000 : 60000;
  const rssLimit = Number(process.env.PRINT_PROBE_RSS_MIB ?? maximumRss),
    timeLimit = Number(process.env.PRINT_PROBE_TIMEOUT_MS ?? maximumTime);
  if (
    !Number.isInteger(rssLimit) ||
    rssLimit < 1 ||
    rssLimit > maximumRss ||
    !Number.isInteger(timeLimit) ||
    timeLimit < 1 ||
    timeLimit > maximumTime
  )
    throw Error("INVALID_RESOURCE_LIMIT");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  staging = `${target}.partial-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  const runtime = await runBounded({
    worker: fileURLToPath(new URL(`./${command}-worker.mjs`, import.meta.url)),
    args: [resolve(input), staging, ...args],
    heapMiB: command === "photo" ? 128 : 256,
    rssLimit,
    timeLimit,
  });
  await writeFile(
    resolve(staging, "runtime.json"),
    JSON.stringify(runtime, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  await rename(staging, target);
  staging = undefined;
  console.log(`${command.toUpperCase()}_READY`);
} catch (error) {
  if (staging) await rm(staging, { recursive: true, force: true });
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PROBE_FAILED",
  );
  process.exitCode = 1;
}
