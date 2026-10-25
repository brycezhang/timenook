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
  assert.ok(typeof source.credentialsExpireAt === "string");
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

test("shared static OSS signs only the prefixed private object without inventing STS expiry", async () => {
  const objects = new OssProbeObjects({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: "synthetic-static-id",
    accessKeySecret: config.accessKeySecret,
    credentialMode: "static",
    keyPrefix: "timenook/probe",
  });
  const key = "staging/00000000-0000-4000-8000-000000000004.mp3";
  const form = await objects.uploadForm(
    key,
    15,
    new Date(now.getTime() + 180000),
    now,
  );
  assert.equal(form.fields.key, `timenook/probe/${key}`);
  assert.equal(form.expiresAt, new Date(now.getTime() + 120000).toISOString());
  assert.equal("x-oss-security-token" in form.fields, false);
  const policy = JSON.parse(
    Buffer.from(form.fields.policy, "base64").toString(),
  );
  assert.ok(
    policy.conditions.some(
      (c: unknown) =>
        JSON.stringify(c) ===
        JSON.stringify(["eq", "$key", `timenook/probe/${key}`]),
    ),
  );
  assert.ok(!JSON.stringify(form).includes(config.accessKeySecret));
  for (const invalid of ["../" + key, "/" + key, "timenook/probe/" + key])
    await assert.rejects(
      objects.uploadForm(invalid, 15, new Date(now.getTime() + 180000), now),
    );
  const grant = await objects.asrSource(key.replace("staging", "sealed"), 600);
  assert.equal(
    new URL(grant.url).pathname,
    `/timenook/probe/${key.replace("staging", "sealed")}`,
  );
  assert.equal(grant.credentialMode, "static");
  assert.equal(grant.credentialsExpireAt, null);
  assert.equal(
    new URL(grant.url).searchParams.has("x-oss-security-token"),
    false,
  );
});

test("shared OSS prefixes snapshot, read, copy and deletion while rejecting caller paths", async () => {
  nock.disableNetConnect();
  const objects = new OssProbeObjects({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: "synthetic-static-id",
    accessKeySecret: config.accessKeySecret,
    credentialMode: "static",
    keyPrefix: "timenook/probe",
  });
  const source = "staging/00000000-0000-4000-8000-000000000004.mp3";
  const target = source.replace("staging", "sealed");
  const prefix = "timenook/probe/";
  const provider = nock(
    `https://${config.bucket}.oss-${config.region}.aliyuncs.com`,
    {
      reqheaders: {
        authorization: (v: string) => v.startsWith("OSS4-HMAC-SHA256 "),
      },
      badheaders: ["x-oss-security-token"],
    },
  );
  try {
    provider
      .put(`/${prefix}${source}`, "synthetic-audio")
      .matchHeader("x-oss-object-acl", "private")
      .reply(200, "", { etag: '"synthetic"' });
    await objects.putSnapshot(source, Buffer.from("synthetic-audio"));
    provider
      .put(`/${prefix}${target}`)
      .matchHeader(
        "x-oss-copy-source",
        `/${config.bucket}/${encodeURIComponent(prefix + source)}`,
      )
      .reply(
        200,
        "<CopyObjectResult><LastModified>2026-10-22T00:00:00Z</LastModified><ETag>synthetic</ETag></CopyObjectResult>",
        { "content-type": "application/xml" },
      );
    await objects.copy(source, target);
    provider
      .get(`/${prefix}${target}`)
      .reply(200, Buffer.from("synthetic-audio"));
    assert.equal((await objects.read(target)).toString(), "synthetic-audio");
    provider.delete(`/${prefix}${target}`).reply(204);
    await objects.remove(target);
    for (const invalid of ["../" + target, "/" + target, prefix + target]) {
      await assert.rejects(objects.read(invalid));
      await assert.rejects(objects.remove(invalid));
    }
    assert.ok(nock.isDone());
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
});
