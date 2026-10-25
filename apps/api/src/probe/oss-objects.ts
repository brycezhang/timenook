import { objectFormat } from "../media/object-format";
import OSS from "ali-oss";
import type { ProbeUploadForm } from "@timenook/contracts";
import type { AsrSource } from "./ai-providers";

interface ProbeOssBase {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  keyPrefix?: string;
}
export type ProbeOssConfig = ProbeOssBase &
  (
    | { credentialMode?: "sts"; securityToken: string; expiresAt: string }
    | { credentialMode: "static"; securityToken?: never; expiresAt?: never }
  );

export function validOssKeyPrefix(prefix: string | undefined): boolean {
  return (
    prefix === undefined ||
    (prefix.length <= 128 &&
      /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(prefix))
  );
}
/** All provider keys are scoped beneath the configured project prefix. */
export class OssProbeObjects {
  private readonly client: OSS;
  constructor(private readonly config: ProbeOssConfig) {
    if (
      !validOssKeyPrefix(config.keyPrefix) ||
      (config.credentialMode === "static" &&
        (!config.keyPrefix?.match(/^timenook(?:\/|$)/) ||
          config.securityToken ||
          config.expiresAt))
    )
      throw new Error("Invalid shared OSS credential mode or key prefix");
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
        this.credentialDeadline() - 5000,
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
      key: this.physicalKey(key),
      "x-oss-signature-version": "OSS4-HMAC-SHA256",
      "x-oss-credential": `${this.config.accessKeyId}/${date.slice(0, 8)}/${this.config.region}/oss/aliyun_v4_request`,
      "x-oss-date": date,
      ...(this.config.credentialMode === "static"
        ? {}
        : { "x-oss-security-token": this.config.securityToken }),
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
  async asrSource(key: string, fetchWindowSeconds: number): Promise<AsrSource> {
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
      this.config.credentialMode !== "static" &&
      (!Number.isFinite(this.credentialDeadline()) ||
        this.credentialDeadline() < Date.parse(expiresAt) + 5000)
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
      this.physicalKey(key),
    );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !==
        `${this.config.bucket}.oss-${this.config.region}.aliyuncs.com` ||
      parsed.pathname !== `/${this.physicalKey(key)}`
    )
      throw new Error("ASR source must use the public OSS endpoint");
    return this.config.credentialMode === "static"
      ? { url, expiresAt, credentialMode: "static", credentialsExpireAt: null }
      : { url, expiresAt, credentialsExpireAt: this.config.expiresAt };
  }
  private physicalKey(key: string): string {
    objectFormat(key);
    return this.config.keyPrefix ? `${this.config.keyPrefix}/${key}` : key;
  }
  private credentialDeadline(): number {
    return this.config.credentialMode === "static"
      ? Infinity
      : Date.parse(this.config.expiresAt);
  }
  private checkKey(key: string) {
    objectFormat(key);
    if (
      this.config.credentialMode !== "static" &&
      (!Number.isFinite(this.credentialDeadline()) ||
        this.credentialDeadline() <= Date.now() + 5000)
    )
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
    await this.client.put(this.physicalKey(key), bytes, {
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
    const result = await this.client.getStream(this.physicalKey(key), {
      timeout: 10000,
    });
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
    await this.client.copy(this.physicalKey(target), this.physicalKey(source), {
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
    await this.client.delete(this.physicalKey(key));
  }
}
