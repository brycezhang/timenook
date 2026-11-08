import assert from "node:assert/strict";
import { test, afterEach, after } from "node:test";
import nock from "nock";
import { aliyunSmsSender } from "../src/sms/aliyun-sms";
const settings = {
  accessKeyId: "isolated-sms-key",
  accessKeySecret: "isolated-sms-secret",
  signName: "测试签名",
  templateCode: "SMS_ISOLATED",
  phoneDailyLimit: 10,
  ipDailyLimit: 100,
};
nock.disableNetConnect();
afterEach(() => nock.cleanAll());
after(() => nock.enableNetConnect());
test("Alibaba SMS adapter sends the intended OTP template through the provider boundary", async () => {
  let parameters: Record<string, string> = {};
  const provider = nock("https://dysmsapi.aliyuncs.com")
    .post("/")
    .query((query) => {
      parameters = Object.fromEntries(
        Object.entries(query).map(([key, value]) => [key, String(value)]),
      );
      return true;
    })
    .reply(200, { Code: "OK", Message: "OK", RequestId: "isolated-request" });
  await aliyunSmsSender(settings).sendOtp({
    phone: "+8613800000001",
    code: "123456",
    outId: "isolated-challenge",
  });
  assert.equal(provider.isDone(), true);
  assert.equal(parameters.PhoneNumbers, "13800000001");
  assert.equal(parameters.SignName, "测试签名");
  assert.deepEqual(JSON.parse(parameters.TemplateParam), { code: "123456" });
});
test("an HTTP 200 provider rejection is a failure without exposing provider details", async () => {
  nock("https://dysmsapi.aliyuncs.com")
    .post("/")
    .query(true)
    .reply(200, {
      Code: "isv.BUSINESS_LIMIT_CONTROL",
      Message: "private provider details 13800000001",
    });
  await assert.rejects(
    aliyunSmsSender(settings).sendOtp({
      phone: "+8613800000001",
      code: "123456",
      outId: "isolated-rejected",
    }),
    (error: Error) => {
      assert.doesNotMatch(
        String(error),
        /13800000001|123456|isolated-sms|private provider/,
      );
      return true;
    },
  );
});
