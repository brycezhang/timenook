import type { ApiConfig } from "../src/config";
import type { createApplication } from "../src/application";
import {
  authenticateFeishu,
  createFeishuAccount,
} from "./admin-feishu-fixture";
export async function paymentAdmin(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  permissions = ["service-terms:write", "audit:read"],
) {
  const auth = await authenticateFeishu(
    config,
    app,
    createFeishuAccount(config, permissions),
  );
  return {
    cookie: auth.cookie,
    origin: config.admin!.origin,
    "x-csrf-token": auth.csrf,
  };
}
