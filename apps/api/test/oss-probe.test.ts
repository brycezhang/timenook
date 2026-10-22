import assert from "node:assert/strict";
import nock from "nock";
import { test } from "node:test";
import { OssProbeObjects } from "../src/probe/oss-objects";
const now = new Date("2026-10-22T12:00:00Z");
const config = {
  bucket: "timenook-synthetic-probe",
  region: "cn-hangzhou",
  accessKeyId: "STS.synthetic",
  accessKeySecret: "synthetic-never-real",
  securityToken: "synthetic-sts-token",
  expiresAt: "2026-10-22T12:00:45Z",
};
test("OSS candidate signs one private staging key with V4 and caps its policy at the STS expiry", async () => {
  const objects = new OssProbeObjects(config);
  const form = await objects.uploadForm(
    "staging/00000000-0000-4000-8000-000000000001.mp3",
    6480,
    new Date("2026-10-22T12:02:00Z"),
    now,
  );
  assert.equal(
    form.url,
    "https://timenook-synthetic-probe.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.equal(form.storage, "oss");
  const policy = JSON.parse(
    Buffer.from(form.fields.policy, "base64").toString(),
  );
  assert.equal(policy.expiration, "2026-10-22T12:00:40.000Z");
  assert.ok(
    policy.conditions.some(
      (c: any) =>
        JSON.stringify(c) === JSON.stringify(["eq", "$key", form.fields.key]),
    ),
  );
  assert.deepEqual(
    policy.conditions.find((c: any) => c[0] === "content-length-range"),
    ["content-length-range", 6480, 6480],
  );
  assert.equal(form.fields["x-oss-object-acl"], "private");
  assert.equal(form.fields["x-oss-signature-version"], "OSS4-HMAC-SHA256");
  assert.equal(
    form.fields["x-oss-credential"],
    "STS.synthetic/20261022/cn-hangzhou/oss/aliyun_v4_request",
  );
  // Independent Python hmac/hashlib fixture from the published OSS V4 derivation.
  assert.equal(
    form.fields["x-oss-signature"],
    "e367a148cc797e6aa19fc11acc129badceb062f0b0922e6ffd9523032ae473b2",
  );
  assert.ok(!JSON.stringify(form).includes(config.accessKeySecret));
  await assert.rejects(
    objects.uploadForm(
      "sealed/00000000-0000-4000-8000-000000000001.mp3",
      6480,
      new Date("2026-10-22T12:02:00Z"),
      now,
    ),
  );
  await assert.rejects(
    objects.uploadForm(
      form.fields.key,
      6480,
      new Date("2026-10-22T12:02:00Z"),
      new Date("2026-10-22T12:00:41Z"),
    ),
  );
});

test("OSS candidate uses authenticated private copy and bounded reads, with provider errors preserved as failures", async () => {
  nock.disableNetConnect();
  const fresh = {
    ...config,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const objects = new OssProbeObjects(fresh);
  const source = "staging/00000000-0000-4000-8000-000000000001.mp3";
  const target = source.replace("staging", "sealed");
  const provider = nock(
    "https://timenook-synthetic-probe.oss-cn-hangzhou.aliyuncs.com",
    {
      reqheaders: {
        authorization: (v: string) => v.startsWith("OSS4-HMAC-SHA256 "),
        "x-oss-security-token": "synthetic-sts-token",
      },
    },
  );
  try {
    const copied = provider
      .put(`/${target}`)
      .matchHeader(
        "x-oss-copy-source",
        `/${config.bucket}/staging%2F00000000-0000-4000-8000-000000000001.mp3`,
      )
      .matchHeader("x-oss-object-acl", "private")
      .reply(
        200,
        "<CopyObjectResult><LastModified>2026-10-22T00:00:00Z</LastModified><ETag>synthetic</ETag></CopyObjectResult>",
        { "content-type": "application/xml" },
      );
    await objects.copy(source, target);
    assert.ok(copied.isDone());
    const read = provider
      .get(`/${target}`)
      .reply(200, Buffer.from("synthetic-audio"), { "content-length": "15" });
    assert.equal((await objects.read(target)).toString(), "synthetic-audio");
    assert.ok(read.isDone());
    provider.get(`/${target}`).reply(200, Buffer.alloc(2097153));
    await assert.rejects(objects.read(target));
    provider
      .get(`/${target}`)
      .reply(
        403,
        "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
        { "content-type": "application/xml" },
      );
    await assert.rejects(objects.read(target));
    provider.delete(`/${target}`).reply(204);
    await objects.remove(target);
    assert.ok(nock.isDone());
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
});

test("ASR source grant signs only a sealed public HTTPS URL and refuses STS shorter than the explicit fetch window", async () => {
  const objects = new OssProbeObjects({
    ...config,
    expiresAt: new Date(Date.now() + 700000).toISOString(),
  });
  const key = "sealed/00000000-0000-4000-8000-000000000003.mp3";
  const source = await objects.asrSource(key, 600);
  const url = new URL(source.url);
  assert.equal(url.protocol, "https:");
  assert.equal(
    url.hostname,
    "timenook-synthetic-probe.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.equal(url.pathname, `/${key}`);
  assert.equal(url.searchParams.get("x-oss-expires"), "605");
  assert.equal(
    url.searchParams.get("x-oss-signature-version"),
    "OSS4-HMAC-SHA256",
  );
  assert.ok(Date.parse(source.expiresAt) >= Date.now() + 600000);
  assert.ok(
    Date.parse(source.credentialsExpireAt) > Date.parse(source.expiresAt),
  );
  await assert.rejects(
    objects.asrSource(key.replace("sealed", "staging"), 600),
  );
  await assert.rejects(
    new OssProbeObjects({
      ...config,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    }).asrSource(key, 600),
  );
});
