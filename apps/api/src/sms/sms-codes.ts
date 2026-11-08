import { createHmac, randomInt, randomUUID } from "node:crypto";
import {
  HttpException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import Redis from "ioredis";
import { API_CONFIG, ApiConfig } from "../config";
import { mainlandPhone } from "../identity/phone-account";
import { SMS_SENDER, type SmsSender } from "./aliyun-sms";

@Injectable()
export class SmsCodes implements OnModuleDestroy {
  private readonly redis: Redis;
  private connection?: Promise<void>;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
  ) {
    this.redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => null,
    });
    this.redis.on("error", () => {});
  }
  private hash(value: string) {
    return createHmac(
      "sha256",
      Buffer.from(this.config.web!.sessionKey, "base64"),
    )
      .update(value)
      .digest("hex");
  }
  private key(kind: string, value: string) {
    return `${this.config.redisKeyPrefix ?? "timenook"}:sms:${kind}:${this.hash(value)}`;
  }
  private async ready() {
    try {
      if (this.redis.status !== "ready") {
        this.connection ??= this.redis.connect().finally(() => {
          this.connection = undefined;
        });
        await this.connection;
      }
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  async send(phoneInput: string, source: string) {
    const phone = mainlandPhone(phoneInput),
      challengeId = randomUUID();
    const code = String(randomInt(100000, 1000000));
    const challenge = this.key("challenge", challengeId),
      active = this.key("active", phone);
    await this.ready();
    let reserved: unknown;
    try {
      reserved = await this.redis.eval(
        `
        if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
        if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[1]) or
           tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[2]) then return 0 end
        for i=2,3 do local n=redis.call('INCR', KEYS[i]); if n==1 then redis.call('EXPIRE', KEYS[i], 86400) end end
        redis.call('SET', KEYS[1], ARGV[3], 'EX', 60)
        redis.call('SET', KEYS[5], ARGV[3], 'EX', 300)
        redis.call('HSET', KEYS[4], 'phone', ARGV[4], 'hash', ARGV[5], 'attempts', 0, 'ready', 0)
        redis.call('EXPIRE', KEYS[4], 300)
        return 1`,
        5,
        this.key("cooldown", phone),
        this.key("phone-day", phone),
        this.key("ip-day", source),
        challenge,
        active,
        this.config.sms?.phoneDailyLimit ?? 10,
        this.config.sms?.ipDailyLimit ?? 100,
        challengeId,
        phone,
        this.hash(`${challengeId}:${code}`),
      );
    } catch {
      throw new ServiceUnavailableException();
    }
    if (Number(reserved) !== 1) throw new HttpException("Rate limited", 429);
    try {
      await this.sender.sendOtp({ phone, code, outId: challengeId });
      await this.redis.hset(challenge, "ready", 1);
    } catch {
      await this.redis.del(challenge).catch(() => {});
      throw new ServiceUnavailableException();
    }
    return { challengeId, expiresInSeconds: 300, retryAfterSeconds: 60 };
  }
  async consume(challengeId: string, code: string): Promise<string> {
    await this.ready();
    let phone: string | null;
    try {
      const challenge = this.key("challenge", challengeId);
      phone = await this.redis.hget(challenge, "phone");
      if (!phone) throw new UnauthorizedException();
      const accepted = await this.redis.eval(
        `
        if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('HGET', KEYS[1], 'ready') ~= '1' then return 0 end
        if redis.call('HGET', KEYS[1], 'hash') ~= ARGV[2] then
          if redis.call('HINCRBY', KEYS[1], 'attempts', 1) >= 5 then redis.call('DEL', KEYS[1], KEYS[2]) end
          return 0
        end
        redis.call('DEL', KEYS[1], KEYS[2]); return 1`,
        2,
        challenge,
        this.key("active", phone),
        challengeId,
        this.hash(`${challengeId}:${code}`),
      );
      if (Number(accepted) !== 1) throw new UnauthorizedException();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException();
    }
    return phone;
  }
  onModuleDestroy() {
    this.redis.disconnect();
  }
}
