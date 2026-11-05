import type { ApiConfig } from "../config";
import { effectiveDeepSeekBaseUrl } from "../probe/ai-providers";
import { validOssKeyPrefix } from "../probe/oss-objects";

type MediaConfig = Pick<
  ApiConfig,
  "recording" | "photos" | "transcription" | "generation"
>;

/** The explicit product prefix reuses the probe adapters, never probe identity/data. */
export function readInternalMediaConfig(env: NodeJS.ProcessEnv): MediaConfig {
  if (!env.TIMENOOK_PRODUCT_OSS_BUCKET) return {};
  if (env.INTERNAL_ACCEPTANCE_ENABLED !== "1")
    throw new Error("Product OSS requires explicit internal acceptance");
  const result: MediaConfig = {
    recording: {
      mode: "internal-acceptance",
      storageRoot: env.TIMENOOK_PRODUCT_STORAGE_ROOT ?? "",
      oss: {
        credentialMode: "static",
        bucket: env.TIMENOOK_PRODUCT_OSS_BUCKET,
        region: env.TIMENOOK_PRODUCT_OSS_REGION ?? "",
        keyPrefix: env.TIMENOOK_PRODUCT_OSS_KEY_PREFIX ?? "",
        accessKeyId: env.TIMENOOK_PRODUCT_OSS_ACCESS_KEY_ID ?? "",
        accessKeySecret: env.TIMENOOK_PRODUCT_OSS_ACCESS_KEY_SECRET ?? "",
      },
    },
    photos: {
      mode: "internal-acceptance",
      placement: { widthMm: 120, heightMm: 160 },
    },
    transcription: {
      mode: "internal-acceptance",
      configVersion: "internal-media-v1",
      doubao: {
        apiKey: env.TIMENOOK_PRODUCT_DOUBAO_API_KEY ?? "",
        resourceId: env.TIMENOOK_PRODUCT_DOUBAO_RESOURCE_ID ?? "",
        fetchWindowSeconds: 600,
      },
      pollIntervalMs: 3000,
      submissionReservationFen: 1,
      deadlineMs: 600000,
    },
    generation: {
      mode: "internal-acceptance",
      configVersion: "internal-media-v1",
      deepseek: {
        apiKey: env.TIMENOOK_PRODUCT_DEEPSEEK_API_KEY ?? "",
        model: env.TIMENOOK_PRODUCT_DEEPSEEK_MODEL ?? "",
        baseUrl: effectiveDeepSeekBaseUrl(
          env.TIMENOOK_PRODUCT_DEEPSEEK_BASE_URL,
        ),
        maxTokens: 4096,
      },
      submissionReservationFen: 1,
      maxSubmissions: 20,
      deadlineMs: 600000,
    },
  };
  validateInternalMediaConfig({
    ...result,
    acceptance: {
      mode: "internal-acceptance",
      profileVersion: "internal-acceptance-v1",
    },
  });
  return result;
}

export function validateInternalMediaConfig(
  config: MediaConfig & Pick<ApiConfig, "acceptance">,
) {
  const { recording, photos, transcription, generation } = config;
  const oss = recording?.oss;
  if (
    !config.acceptance ||
    !recording ||
    recording.mode !== "internal-acceptance" ||
    !recording.storageRoot.startsWith("/") ||
    !oss ||
    oss.credentialMode !== "static" ||
    oss.bucket !== "timenook" ||
    oss.region !== "cn-shanghai" ||
    !validOssKeyPrefix(oss.keyPrefix) ||
    !oss.keyPrefix?.startsWith("timenook/product/") ||
    [oss.accessKeyId, oss.accessKeySecret].some(
      (v) => !v || /\s|YOUR_|PLACEHOLDER|<|>/i.test(v),
    ) ||
    !photos ||
    photos.mode !== "internal-acceptance" ||
    ![photos.placement.widthMm, photos.placement.heightMm].every(
      (n) => Number.isFinite(n) && n >= 1 && n <= 300,
    ) ||
    !transcription ||
    transcription.mode !== "internal-acceptance" ||
    !generation ||
    generation.mode !== "internal-acceptance"
  )
    throw new Error(
      "Internal media requires product-scoped private OSS and complete runtime configuration",
    );
  effectiveDeepSeekBaseUrl(generation.deepseek.baseUrl);
  if (
    !["volc.bigasr.auc", "volc.seedasr.auc"].includes(
      transcription.doubao.resourceId,
    ) ||
    [transcription.doubao.apiKey, generation.deepseek.apiKey].some(
      (key) => !key || /\s|YOUR_|PLACEHOLDER|<|>/i.test(key),
    ) ||
    !/^[A-Za-z0-9._:-]{1,120}$/.test(generation.deepseek.model) ||
    ![transcription.configVersion, generation.configVersion].every((v) =>
      /^[A-Za-z0-9._-]{1,80}$/.test(v),
    ) ||
    !Number.isInteger(transcription.doubao.fetchWindowSeconds) ||
    transcription.doubao.fetchWindowSeconds < 1 ||
    transcription.doubao.fetchWindowSeconds > 43190 ||
    !Number.isInteger(transcription.pollIntervalMs) ||
    transcription.pollIntervalMs < 0 ||
    transcription.pollIntervalMs > 60000 ||
    !Number.isInteger(generation.deepseek.maxTokens) ||
    generation.deepseek.maxTokens < 1 ||
    generation.deepseek.maxTokens > 32768 ||
    !Number.isInteger(generation.maxSubmissions) ||
    generation.maxSubmissions < 1 ||
    ![
      transcription.submissionReservationFen,
      generation.submissionReservationFen,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    ![transcription.deadlineMs, generation.deadlineMs].every(
      (n) => Number.isSafeInteger(n) && n >= 30000 && n <= 86400000,
    )
  )
    throw new Error(
      "Internal media requires explicit ASR, DeepSeek and bounded candidate budgets",
    );
}
