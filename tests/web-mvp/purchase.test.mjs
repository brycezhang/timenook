import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chromium, webkit, expect } from "@playwright/test";
import { storyBrowser, books, root } from "./flow-fixture.mjs";
import { join } from "node:path";

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: Alipay POST checkout and ledger return deliver one private project`,
    { timeout: 120000 },
    async () => {
      const remote = new Map();
      let returnUrl, channel;
      const paymentFetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://payment.test.invalid");
        assert.equal(
          new Headers(init?.headers).get("X-Internal-Auth"),
          "isolated-payment-secret",
        );
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.pathname === "/v1/payments/orders") {
          channel = body.preferred_channel;
          const row = {
            ...body,
            order_no: `AP${randomUUID()}`,
            channel_preferred: channel,
            status: "pending",
            settled_at: null,
          };
          remote.set(row.order_no, row);
          return Response.json({ data: row });
        }
        const no = decodeURIComponent(
          url.pathname
            .split("/")
            .at(
              url.pathname.endsWith("/prepare") ||
                url.pathname.endsWith("/close")
                ? -2
                : -1,
            ),
        );
        const row = remote.get(no);
        assert.ok(row);
        if (url.pathname.endsWith("/prepare")) {
          returnUrl = body.extra.return_url;
          return Response.json({
            data: {
              expires_in: 600,
              channel_payload: {
                method:
                  body.channel === "alipay_page"
                    ? "page_redirect"
                    : "wap_redirect",
                order_string:
                  '<form method="post" action="https://openapi.alipay.com/gateway.do"><input type="hidden" name="biz_content" value="browser-acceptance"></form><script>window.unsafePaymentScript=true</script>',
              },
            },
          });
        }
        if (url.pathname.endsWith("/close")) row.status = "closed";
        return Response.json({ data: row });
      };
      const f = await storyBrowser(engine, {
        alipay: {
          baseUrl: "https://payment.test.invalid",
          internalToken: "isolated-payment-secret",
        },
        paymentFetch,
      });
      try {
        const buyer = await books.login();
        const context =
          engine === webkit
            ? await f.context
                .browser()
                .newContext({
                  ignoreHTTPSErrors: true,
                  viewport: { width: 390, height: 844 },
                  userAgent:
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
                })
            : f.context;
        let submitted;
        await context.route(
          "https://openapi.alipay.com/gateway.do",
          async (route) => {
            submitted = {
              method: route.request().method(),
              data: route.request().postData(),
            };
            await route.fulfill({
              contentType: "text/html",
              body: "<h1>隔离的支付宝网络边界</h1>",
            });
          },
        );
        const page = await context.newPage();
        await page.goto(`${f.origin}/app/purchase`);
        await f.signIn(page, f.phoneFor(buyer));
        await expect(
          page.getByRole("heading", { name: "新购一本书", exact: true }),
        ).toBeVisible();
        await page
          .getByLabel("书名", { exact: true })
          .fill("网页验收 · 外婆的纸船");
        await page.getByRole("button", { name: /支付宝/ }).click();
        await page.waitForURL("https://openapi.alipay.com/gateway.do");
        assert.deepEqual(submitted, {
          method: "POST",
          data: "biz_content=browser-acceptance",
        });
        assert.equal(channel, engine === webkit ? "alipay_wap" : "alipay_page");
        await page.goto(returnUrl);
        await expect(
          page.getByText("暂未确认付款。完成支付宝付款后，回到这里查询。", {
            exact: true,
          }),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(() => !!window.unsafePaymentScript),
          false,
        );
        assert.equal(
          (
            await context.request.get(`${f.origin}/api/v1/participations`, {
              headers: { "X-Timenook-Web": "1" },
            })
          ).status(),
          200,
        );
        Object.assign(remote.values().next().value, {
          status: "paid",
          settled_at: "2026-11-08T01:02:03Z",
        });
        await page
          .getByRole("button", { name: "我已完成付款，查询状态", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "付款已确认", exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "付款已确认", exact: true }),
        ).toBeVisible();
        const response = await context.request.get(
          `${f.origin}/api/v1/participations`,
          { headers: { "X-Timenook-Web": "1" } },
        );
        const list = (await response.json()).data.projects;
        assert.equal(list.length, 1);
        assert.equal(list[0].bookTitle, "网页验收 · 外婆的纸船");
        await page.screenshot({
          path: join(
            root,
            `output/playwright/wv07-return-${engine.name()}.png`,
          ),
          fullPage: true,
        });
        const stranger = await engine.launch();
        try {
          const outsider = await stranger.newContext({
            ignoreHTTPSErrors: true,
          });
          const r = await outsider.request.get(
            returnUrl.replace("/app/purchase/return/", "/api/v1/web/orders/"),
          );
          assert.equal(r.status(), 401);
        } finally {
          await stranger.close();
        }
        assert.deepEqual(f.errors, []);
        if (context !== f.context) await context.close();
      } finally {
        await f.close();
      }
    },
  );
