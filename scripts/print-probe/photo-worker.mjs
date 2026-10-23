import { processPhoto } from "../../apps/api/runtime/photo-kernel.mjs";
try {
  if (
    process.env.PRINT_PROBE_ENABLED !== "synthetic-local" ||
    process.env.NODE_ENV === "production"
  )
    throw Error("PRINT_PROBE_DISABLED");
  await processPhoto(...process.argv.slice(2), "synthetic-local-probe");
} catch (error) {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PHOTO_DECODE_REJECTED",
  );
  process.exitCode = 1;
}
