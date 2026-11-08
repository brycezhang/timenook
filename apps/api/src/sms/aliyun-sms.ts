import DysmsapiClient, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { Config } from "@alicloud/openapi-client";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ApiConfig } from "../config";
export const SMS_SENDER = Symbol("SMS_SENDER");
export interface SmsSender {
  sendOtp(input: { phone: string; code: string; outId: string }): Promise<void>;
}
export function aliyunSmsSender(config: ApiConfig["sms"]): SmsSender {
  let client: DysmsapiClient | undefined;
  return {
    async sendOtp(input) {
      if (!config) throw new ServiceUnavailableException();
      client ??= new DysmsapiClient(
        new Config({
          accessKeyId: config.accessKeyId,
          accessKeySecret: config.accessKeySecret,
          endpoint: "dysmsapi.aliyuncs.com",
          regionId: "cn-hangzhou",
          connectTimeout: 3000,
          readTimeout: 5000,
        }),
      );
      try {
        const response = await client.sendSms(
          new SendSmsRequest({
            phoneNumbers: input.phone.slice(3),
            signName: config.signName,
            templateCode: config.templateCode,
            templateParam: JSON.stringify({ code: input.code }),
            outId: input.outId,
          }),
        );
        if (response.body?.code !== "OK") throw new Error("sms_rejected");
      } catch {
        // SDK errors can contain the phone, message body or credentials.
        throw new ServiceUnavailableException();
      }
    },
  };
}
