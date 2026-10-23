import { processPhoto } from "./photo-kernel.mjs";
try {
  if (
    process.env.TIMENOOK_PHOTO_MODE !== "synthetic-local" ||
    process.env.NODE_ENV !== "test"
  )
    throw Error("PRODUCT_PHOTO_DISABLED");
  const args = process.argv.slice(2);
  await processPhoto(
    ...args.slice(0, 4),
    "product-photo",
    args[4] ? JSON.parse(args[4]) : undefined,
  );
} catch (error) {
  console.error(
    /^[A-Z_]+$/.test(error.message) ? error.message : "PHOTO_DECODE_REJECTED",
  );
  process.exitCode = 1;
}
