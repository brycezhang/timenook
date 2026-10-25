import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../src/config";
import { OssProbeObjects } from "../src/probe/oss-objects";
import { probeStorageScope } from "../src/probe/storage-scope";
const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1/synthetic",
  REDIS_URL: "redis://127.0.0.1",
  AUDIO_PROBE_ENABLED: "oss",
  AUDIO_PROBE_STORAGE_ROOT: "/tmp/synthetic",
  TIMENOOK_PROBE_OSS_BUCKET: "timenook-synthetic-probe",
  TIMENOOK_PROBE_OSS_REGION: "cn-hangzhou",
  TIMENOOK_PROBE_OSS_ACCESS_KEY_ID: "synthetic-id",
  TIMENOOK_PROBE_OSS_ACCESS_KEY_SECRET: "synthetic-secret",
};
const staticEnv = {
  ...base,
  TIMENOOK_PROBE_OSS_CREDENTIAL_MODE: "static",
  TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook/probe",
};
test("static shared OSS is explicit, requires a safe project prefix, and rejects mixed STS fields", () => {
  const oss = readConfig(staticEnv).audioProbe!.oss!;
  assert.equal(oss.credentialMode, "static");
  assert.equal(oss.keyPrefix, "timenook/probe");
  assert.equal(oss.securityToken, undefined);
  assert.equal(oss.expiresAt, undefined);
  for (const overrides of [
    { TIMENOOK_PROBE_OSS_CREDENTIAL_MODE: "" },
    { TIMENOOK_PROBE_OSS_CREDENTIAL_MODE: "automatic" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "../deed" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "deed" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "/timenook" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook/" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook//probe" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook/%2e%2e" },
    { TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook\\deed" },
    { TIMENOOK_PROBE_OSS_ACCESS_KEY_SECRET: "" },
    { TIMENOOK_PROBE_OSS_SECURITY_TOKEN: "synthetic-token" },
    {
      TIMENOOK_PROBE_OSS_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(),
    },
  ])
    assert.throws(() => readConfig({ ...staticEnv, ...overrides }));
  assert.throws(() => new OssProbeObjects({ ...oss, keyPrefix: undefined }));
  assert.throws(() => new OssProbeObjects({ ...oss, keyPrefix: "../deed" }));
});
test("STS remains the default and storage scope isolates prefixes without rekeying old stores", () => {
  const legacy = readConfig({
    ...base,
    TIMENOOK_PROBE_OSS_SECURITY_TOKEN: "synthetic-token",
    TIMENOOK_PROBE_OSS_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(),
  }).audioProbe!;
  assert.equal(
    probeStorageScope(legacy),
    createHash("sha256")
      .update(
        `oss:${base.TIMENOOK_PROBE_OSS_BUCKET}:${base.TIMENOOK_PROBE_OSS_REGION}`,
      )
      .digest("hex"),
  );
  const shared = readConfig(staticEnv).audioProbe!;
  const other = readConfig({
    ...staticEnv,
    TIMENOOK_PROBE_OSS_KEY_PREFIX: "timenook/other",
  }).audioProbe!;
  assert.notEqual(probeStorageScope(shared), probeStorageScope(legacy));
  assert.notEqual(probeStorageScope(shared), probeStorageScope(other));
  assert.throws(() =>
    readConfig({
      ...base,
      TIMENOOK_PROBE_OSS_KEY_PREFIX: "../deed",
      TIMENOOK_PROBE_OSS_SECURITY_TOKEN: "synthetic-token",
      TIMENOOK_PROBE_OSS_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(),
    }),
  );
});
