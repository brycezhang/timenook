import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ApiConfig } from "../src/config";
import { WebAccess, WEB_COOKIE } from "../src/web/web-access";
import { provisionWebAccount } from "../src/web/web-provisioning";

/** Privileged fixture setup for media/payment tests, never an HTTP login bypass. */
export async function fixtureWebSession(
  app: NestFastifyApplication,
  config: ApiConfig,
  userId?: string,
  previousToken?: string,
) {
  const account = userId
    ? { user: { id: userId } }
    : ((await provisionWebAccount(config, "create", {})) as {
        user: { id: string };
      });
  const issued = (await provisionWebAccount(config, "issue", {
    userId: account.user.id,
  })) as { url: string };
  const ticket = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "ticket",
  )!;
  const result = await app.get(WebAccess).exchange(ticket, previousToken);
  return {
    ...result.data,
    user: account.user,
    cookie: `${WEB_COOKIE}=${result.token}`,
  };
}
