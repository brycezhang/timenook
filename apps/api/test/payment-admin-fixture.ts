import type { ApiConfig } from "../src/config";
import type { createApplication } from "../src/application";
import {
  authenticateFeishu,
  authenticatePartner,
  createFeishuAccount,
} from "./admin-feishu-fixture";
export async function paymentAdmin(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
  permissions = ["audit:read"],
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

export async function partnerAdmin(
  config: ApiConfig,
  app: Awaited<ReturnType<typeof createApplication>>,
) {
  const auth = await authenticatePartner(config, app);
  return {
    cookie: auth.cookie,
    origin: config.admin!.origin,
    "x-csrf-token": auth.csrf,
  };
}
