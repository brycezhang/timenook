import {
  syntheticFeishu,
  createSyntheticFeishuFetch,
} from "./feishu-fixture.mjs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const apiRequire = createRequire(resolve("apps/api/package.json"));
const { createApplication } = apiRequire("./dist-test/src/application.js");
const { bootPrivacyFixture, closePrivacyFixture } = apiRequire(
  "./dist-test/test/privacy-fixture.js",
);
const configurations = new WeakMap();

/** Explicit bootstrap at this isolated browser-fixture boundary only. */
export async function createPrivacyFixtureApplication(config, options) {
  if (config.environment !== "test" || config.privacyJournal)
    throw new Error(
      "Browser fixture requires its own fresh test privacy source",
    );
  if (config.admin) config.admin.feishu ??= { ...syntheticFeishu };
  await bootPrivacyFixture(config);
  try {
    const app = await createApplication(config, {
      ...(config.admin
        ? { feishuFetch: createSyntheticFeishuFetch(config.admin.origin) }
        : {}),
      ...options,
    });
    configurations.set(app, config);
    return app;
  } catch (error) {
    await closePrivacyFixture(config);
    throw error;
  }
}

export async function closePrivacyFixtureApplication(app) {
  if (!app) return;
  const config = configurations.get(app);
  try {
    await app.close();
  } finally {
    configurations.delete(app);
    if (config) await closePrivacyFixture(config);
  }
}
