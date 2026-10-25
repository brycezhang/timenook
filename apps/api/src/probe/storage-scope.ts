import { createHash } from "node:crypto";
import type { ApiConfig } from "../config";

/** Keep API access and operator cleanup within the same configured store. */
export function probeStorageScope(config: ApiConfig["audioProbe"]): string {
  const oss = config?.oss;
  return createHash("sha256")
    .update(
      oss
        ? `oss:${oss.bucket}:${oss.region}${oss.keyPrefix ? `:prefix:${oss.keyPrefix}` : ""}`
        : `local:${config?.storageRoot}`,
    )
    .digest("hex");
}
