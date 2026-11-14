import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createSyntheticFeishuFetch } from "./feishu-fixture.mjs";
const apiRequire = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const { createApplication } = apiRequire("./dist/application.js");
const { readConfig } = apiRequire("./dist/config.js");
const config = readConfig(process.env);
if (config.environment !== "test")
  throw new Error("Browser fixture is test-only");
if (process.env.CHANNEL_GIFT_BROWSER_FIXTURE_ROOT) {
  const { PrismaClient } = apiRequire("@prisma/client");
  const { PrivacyJournal } = apiRequire(
    "./dist/privacy-journal/privacy-journal.js",
  );
  const { privacyAuthorityId } = apiRequire("./dist/care/privacy-rights.js");
  const database = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const [state] =
      await database.$queryRaw`SELECT database_id FROM privacy_recovery_state WHERE singleton`;
    config.privacyJournal = {
      root: process.env.CHANNEL_GIFT_BROWSER_FIXTURE_ROOT,
      key: randomBytes(32).toString("base64"),
    };
    await PrivacyJournal.bootstrap(config.privacyJournal, {
      databaseId: privacyAuthorityId(config.databaseUrl, state.database_id),
    });
    config.participation = { mode: "synthetic-d08" };
    config.payments = apiRequire(
      "./dist-test/test/payment-fixture.js",
    ).paymentConfig;
    config.wechat = {
      appId: config.payments.appId,
      secret: "synthetic-browser",
    };
  } finally {
    await database.$disconnect();
  }
}
const app = await createApplication(config, {
  ...(process.env.CHANNEL_GIFT_BROWSER_FIXTURE_ROOT
    ? {
        paymentFetch: apiRequire("./dist-test/test/payment-fixture.js")
          .paymentFetch,
      }
    : {}),
  ...(config.admin
    ? { feishuFetch: createSyntheticFeishuFetch(config.admin.origin) }
    : {}),
});
await app.listen(config.port, config.host);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
