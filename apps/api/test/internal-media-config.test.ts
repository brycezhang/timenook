import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config";
import { validateInternalMediaConfig } from "../src/media/product-runtime";
const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://local:local@127.0.0.1/local",
  REDIS_URL: "redis://127.0.0.1",
};
const media = {
  INTERNAL_ACCEPTANCE_ENABLED: "1",
  TIMENOOK_PRODUCT_STORAGE_ROOT: "/tmp/timenook-internal-media",
  TIMENOOK_PRODUCT_OSS_BUCKET: "timenook",
  TIMENOOK_PRODUCT_OSS_REGION: "cn-shanghai",
  TIMENOOK_PRODUCT_OSS_KEY_PREFIX: "timenook/product/internal",
  TIMENOOK_PRODUCT_OSS_ACCESS_KEY_ID: "candidate-id",
  TIMENOOK_PRODUCT_OSS_ACCESS_KEY_SECRET: "candidate-secret",
  TIMENOOK_PRODUCT_DOUBAO_API_KEY: "candidate-asr-key",
  TIMENOOK_PRODUCT_DOUBAO_RESOURCE_ID: "volc.seedasr.auc",
  TIMENOOK_PRODUCT_DEEPSEEK_API_KEY: "candidate-text-key",
  TIMENOOK_PRODUCT_DEEPSEEK_BASE_URL: "https://cf.api.fan/v1",
  TIMENOOK_PRODUCT_DEEPSEEK_MODEL: "deepseek-flash",
};
test("product media stays off by default and explicit internal config uses independent private OSS and native AI adapters", () => {
  assert.equal(readConfig(base).recording, undefined);
  assert.equal(
    readConfig({ ...base, INTERNAL_ACCEPTANCE_ENABLED: "1" }).recording,
    undefined,
  );
  const config = readConfig({ ...base, ...media });
  assert.equal(config.environment, "development");
  assert.equal(config.recording!.mode, "internal-acceptance");
  assert.equal(config.recording!.oss!.keyPrefix, "timenook/product/internal");
  assert.equal(config.transcription!.doubao.resourceId, "volc.seedasr.auc");
  assert.equal(config.generation!.deepseek.baseUrl, "https://cf.api.fan/v1");
  assert.equal(config.payments, undefined);
  validateInternalMediaConfig(config);
  assert.throws(() =>
    readConfig({ ...base, ...media, INTERNAL_ACCEPTANCE_ENABLED: "" }),
  );
  assert.throws(() =>
    readConfig({
      ...base,
      ...media,
      TIMENOOK_PRODUCT_OSS_KEY_PREFIX: "timenook/probe",
    }),
  );
  assert.throws(() =>
    readConfig({ ...base, ...media, TIMENOOK_PRODUCT_DOUBAO_API_KEY: "" }),
  );
});
