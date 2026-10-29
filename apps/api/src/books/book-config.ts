import type { ApiConfig } from "../config";
import { ConfigurationError } from "../config";

export function readInternalBookConfig(
  env: NodeJS.ProcessEnv,
): ApiConfig["books"] {
  if (
    env.INTERNAL_ACCEPTANCE_ENABLED !== "1" ||
    !env.TIMENOOK_PRODUCT_OSS_BUCKET
  )
    return undefined;
  const storageRoot =
    env.BOOK_STORAGE_ROOT ?? `${env.TIMENOOK_PRODUCT_STORAGE_ROOT ?? ""}/books`;
  let entry: URL;
  try {
    entry = new URL(env.BOOK_ENTRY_BASE_URL ?? `${env.WEB_ORIGIN}/app/audio/`);
  } catch {
    throw new ConfigurationError(
      "Internal book audio entry requires the web HTTPS origin",
    );
  }
  if (
    !env.TIMENOOK_PRODUCT_STORAGE_ROOT?.startsWith("/") ||
    !storageRoot.startsWith("/") ||
    entry.origin !== env.WEB_ORIGIN ||
    entry.pathname !== "/app/audio/" ||
    entry.protocol !== "https:" ||
    entry.username ||
    entry.password ||
    entry.search ||
    entry.hash
  )
    throw new ConfigurationError(
      "Internal book storage and audio entry configuration are invalid",
    );
  return {
    mode: "internal-acceptance",
    storageRoot,
    entryBaseUrl: entry.href,
    specificationVersion: "internal-a5-candidate-v1",
    provenanceVersion: "internal-provenance-v1",
  };
}
