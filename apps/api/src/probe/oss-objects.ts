import { objectFormat } from "../media/object-format";
import OSS from "ali-oss";
import type { ProbeUploadForm } from "@timenook/contracts";

export interface ProbeOssConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiresAt: string;
}
/** Candidate OSS provider. STS acquisition/role policy and live bucket acceptance remain external checks. */
export class OssProbeObjects {
  private readonly client: OSS;
  constructor(private readonly config: ProbeOssConfig) {
    const options = {
      bucket: config.bucket,
      region: `oss-${config.region}`,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      stsToken: config.securityToken,
      secure: true,
      authorizationV4: true,
      timeout: 10000,
      retryMax: 0,
    };
    this.client = new OSS(options);
  }
  async uploadForm(
    key: string,
    bytes: number,
    requestedExpiry: Date,
    now = new Date(),
  ): Promise<ProbeUploadForm> {
    if (
      !objectFormat(key).staging ||
      key.endsWith(".jpg") ||
      key.endsWith(".png") ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > objectFormat(key).limit
    )
      throw new Error("Invalid staging grant");
    const expiresAt = new Date(
      Math.min(
        requestedExpiry.getTime(),
        now.getTime() + 120000,
        Date.parse(this.config.expiresAt) - 5000,
      ),
    );
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime()
    )
      throw new Error("STS credentials expired");
    const date = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const fields: Record<string, string> = {
      key,
      "x-oss-signature-version": "OSS4-HMAC-SHA256",
      "x-oss-credential": `${this.config.accessKeyId}/${date.slice(0, 8)}/${this.config.region}/oss/aliyun_v4_request`,
      "x-oss-date": date,
      "x-oss-security-token": this.config.securityToken,
      "x-oss-object-acl": "private",
      success_action_status: "204",
    };
    const policy = {
      expiration: expiresAt.toISOString(),
      conditions: [
        { bucket: this.config.bucket },
        ...Object.entries(fields).map(([name, value]) => [
          "eq",
          `$${name}`,
          value,
        ]),
        ["content-length-range", bytes, bytes],
      ],
    };
    // @types/ali-oss does not yet declare this public SDK 6.23 method.
    const signer = this.client as OSS & {
      signPostObjectPolicyV4(policy: object, date: Date): string;
    };
    return {
      storage: "oss",
      url: `https://${this.config.bucket}.oss-${this.config.region}.aliyuncs.com`,
      expiresAt: expiresAt.toISOString(),
      fields: {
        ...fields,
        policy: Buffer.from(JSON.stringify(policy)).toString("base64"),
        "x-oss-signature": signer.signPostObjectPolicyV4(policy, now),
      },
    };
  }
  async asrSource(key: string, fetchWindowSeconds: number) {
    if (
      !/^sealed\/[0-9a-f-]{36}\.mp3$/.test(key) ||
      !Number.isInteger(fetchWindowSeconds) ||
      fetchWindowSeconds < 1 ||
      fetchWindowSeconds > 43190
    )
      throw new Error("Invalid ASR source grant");
    const expiresSeconds = fetchWindowSeconds + 5;
    const expiresAt = new Date(
      Date.now() + expiresSeconds * 1000,
    ).toISOString();
    if (
      !Number.isFinite(Date.parse(this.config.expiresAt)) ||
      Date.parse(this.config.expiresAt) < Date.parse(expiresAt) + 5000
    )
      throw new Error("STS does not cover the ASR fetch window");
    const signer = this.client as OSS & {
      signatureUrlV4(
        method: string,
        expires: number,
        request: undefined,
        key: string,
      ): Promise<string>;
    };
    const url = await signer.signatureUrlV4(
      "GET",
      expiresSeconds,
      undefined,
      key,
    );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !==
        `${this.config.bucket}.oss-${this.config.region}.aliyuncs.com` ||
      parsed.pathname !== `/${key}`
    )
      throw new Error("ASR source must use the public OSS endpoint");
    return { url, expiresAt, credentialsExpireAt: this.config.expiresAt };
  }
  private checkKey(key: string) {
    objectFormat(key);
    if (Date.parse(this.config.expiresAt) <= Date.now() + 5000)
      throw new Error("STS credentials expired");
  }
  async put(_key: string, _bytes: Buffer): Promise<void> {
    throw new Error("OSS upload requires the signed PostObject form");
  }
  // The server snapshots verified bytes before copy. Client uploads still use
  // the exact-key signed PostObject form and cannot call this operation.
  async putSnapshot(key: string, bytes: Buffer): Promise<void> {
    this.checkKey(key);
    if (
      !objectFormat(key).staging ||
      !Buffer.isBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > objectFormat(key).limit
    )
      throw new Error("Invalid server audio snapshot");
    await this.client.put(key, bytes, {
      timeout: 10000,
      mime: objectFormat(key).mime,
      headers: {
        "x-oss-object-acl": "private",
        "Cache-Control": "private, no-store",
      },
    });
  }
  async read(key: string): Promise<Buffer> {
    this.checkKey(key);
    const result = await this.client.getStream(key, { timeout: 10000 });
    const stream = result.stream;
    const timer = setTimeout(
      () => stream.destroy(new Error("OSS read timed out")),
      10000,
    );
    try {
      if (
        Number(
          (result.res.headers as Record<string, string>)["content-length"],
        ) > objectFormat(key).limit
      )
        throw new Error("OSS object exceeds limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > objectFormat(key).limit)
          throw new Error("OSS object exceeds limit");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }
  async copy(source: string, target: string) {
    this.checkKey(source);
    this.checkKey(target);
    if (!objectFormat(source).staging || objectFormat(target).staging)
      throw new Error("Invalid copy direction");
    await this.client.copy(target, source, {
      headers: {
        "x-oss-object-acl": "private",
        "x-oss-metadata-directive": "REPLACE",
        "Content-Type": objectFormat(target).mime,
        "Cache-Control": "private, no-store",
      },
    });
  }
  async remove(key: string) {
    this.checkKey(key);
    await this.client.delete(key);
  }
}
