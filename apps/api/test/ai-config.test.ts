import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config";
const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1/synthetic",
  REDIS_URL: "redis://127.0.0.1",
  AUDIO_PROBE_ENABLED: "local-simulator",
  AUDIO_PROBE_STORAGE_ROOT: "/tmp/synthetic",
};
const ai = {
  AI_PROBE_ENABLED: "candidate",
  TIMENOOK_PROBE_AI_CONFIG_VERSION: "candidate-2026-10-22",
  TIMENOOK_PROBE_DOUBAO_API_KEY: "synthetic-key",
  TIMENOOK_PROBE_DOUBAO_RESOURCE_ID: "volc.bigasr.auc",
  TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS: "600",
  TIMENOOK_PROBE_DEEPSEEK_API_KEY: "synthetic-key",
  TIMENOOK_PROBE_DEEPSEEK_MODEL: "explicit-candidate",
  TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS: "1024",
};
test("AI candidate configuration is explicit, defaults off and fails closed on partial or production configuration", () => {
  assert.equal(readConfig(base).aiProbe, undefined);
  assert.equal(
    readConfig({ ...base, ...ai }).aiProbe?.deepseek.model,
    "explicit-candidate",
  );
  for (const key of Object.keys(ai).filter((k) => k !== "AI_PROBE_ENABLED")) {
    const env: NodeJS.ProcessEnv = { ...base, ...ai };
    delete env[key];
    assert.throws(() => readConfig(env));
  }
  for (const overrides of [
    { NODE_ENV: "production" },
    { AI_PROBE_ENABLED: "yes" },
    { AUDIO_PROBE_ENABLED: "" },
    { TIMENOOK_PROBE_DOUBAO_RESOURCE_ID: "volc.bigasr.auc_turbo" },
    { TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS: "0" },
    { TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS: "43200" },
    { TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS: "-1" },
    { TIMENOOK_PROBE_AI_CONFIG_VERSION: "" },
  ])
    assert.throws(() => readConfig({ ...base, ...ai, ...overrides }));
});
