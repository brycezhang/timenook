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
      !/^staging\/[0-9a-f-]{36}\.mp3$/.test(key) ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > 2097152
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
  private checkKey(key: string) {
    if (!/^(staging|sealed)\/[0-9a-f-]{36}\.mp3$/.test(key))
      throw new Error("Invalid object key");
    if (Date.parse(this.config.expiresAt) <= Date.now() + 5000)
      throw new Error("STS credentials expired");
  }
  async put(_key: string, _bytes: Buffer): Promise<void> {
    throw new Error("OSS upload requires the signed PostObject form");
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
        ) > 2097152
      )
        throw new Error("OSS object exceeds limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > 2097152) throw new Error("OSS object exceeds limit");
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
    if (!source.startsWith("staging/") || !target.startsWith("sealed/"))
      throw new Error("Invalid copy direction");
    await this.client.copy(target, source, {
      headers: {
        "x-oss-object-acl": "private",
        "x-oss-metadata-directive": "REPLACE",
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, no-store",
      },
    });
  }
  async remove(key: string) {
    this.checkKey(key);
    await this.client.delete(key);
  }
}
