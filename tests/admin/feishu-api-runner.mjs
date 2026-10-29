import { createRequire } from "node:module";
import { syntheticFeishuFetch } from "./feishu-fixture.mjs";
const apiRequire = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const { createApplication } = apiRequire("./dist/application.js");
const { readConfig } = apiRequire("./dist/config.js");
const config = readConfig(process.env);
if (config.environment !== "test")
  throw new Error("Browser fixture is test-only");
const app = await createApplication(config, {
  feishuFetch: syntheticFeishuFetch,
});
await app.listen(config.port, config.host);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
