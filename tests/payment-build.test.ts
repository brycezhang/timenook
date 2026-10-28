import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

async function paymentVerificationBuild(base: string, enabled?: boolean) {
  const bundle = await build({
    entryPoints: ["miniprogram/config.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: {
      __TIMENOOK_API_BASE_URL__: JSON.stringify(base),
      ...(enabled === undefined
        ? {}
        : { __TIMENOOK_PAYMENT_VERIFICATION__: String(enabled) }),
    },
  });
  const module = { exports: {} as { PAYMENT_VERIFICATION_BUILD: boolean } };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
  });
  return module.exports.PAYMENT_VERIFICATION_BUILD;
}

test("explicit payment verification builds accept the current loopback API ingress and direct local API", async () => {
  for (const base of [
    "http://127.0.0.1:5174/api/v1",
    "http://localhost:5174/api/v1",
    "http://127.0.0.1:3417/v1",
    "http://localhost/v1",
  ])
    assert.equal(await paymentVerificationBuild(base, true), true, base);
});

test("payment verification build gate rejects remote, old, malformed and implicit targets", async () => {
  for (const base of [
    "https://timenookapi.threeminreading.com/api/v1",
    "http://example.test/api/v1",
    "https://127.0.0.1:5174/api/v1",
    "http://127.0.0.2:5174/api/v1",
    "http://127.0.0.1.example.test:5174/api/v1",
    "http://127.0.0.1@other.test/api/v1",
    "http://127.0.0.1:5174/timenook/v1",
    "http://127.0.0.1:5174/api/api/v1",
    "http://127.0.0.1:5174/api/v1/",
    "http://127.0.0.1:5174/api/v1?enable=true",
  ])
    assert.equal(await paymentVerificationBuild(base, true), false, base);
  assert.equal(
    await paymentVerificationBuild("http://127.0.0.1:5174/api/v1", false),
    false,
  );
  assert.equal(
    await paymentVerificationBuild("http://127.0.0.1:5174/api/v1"),
    false,
  );
});
