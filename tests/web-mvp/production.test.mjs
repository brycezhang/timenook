import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { books, root, storyBrowser } from "./flow-fixture.mjs";
const require = createRequire(join(root, "apps/api/package.json"));
const {
  readyFirstCopyBook,
} = require("./dist-test/test/first-copy-fixture.js");
const { paymentAdmin } = require("./dist-test/test/payment-admin-fixture.js");
const {
  TERMS_VERSION,
} = require("./dist-test/src/identity/project-members.js");
async function admin(url, headers, body) {
  return books.data(
    await books.app.inject({
      method: "POST",
      url,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: body,
    }),
  );
}
async function fillAddress(page, detail = "合成地址一号") {
  await page.getByLabel("收件人", { exact: true }).fill("合成收件人");
  await page.getByLabel("收货手机号", { exact: true }).fill("13800000000");
  await page.getByLabel("配送地区", { exact: true }).selectOption("CN-110000");
  await page.getByLabel("详细地址", { exact: true }).fill(detail);
  await page.getByRole("button", { name: "保存收货地址", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "收货地址已保存" })
    .waitFor();
}

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: losing project membership clears private production content after any denied action`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine, {
        previewPort: Number(process.env.TIMENOOK_TEST_PREVIEW_PORT || 4446),
      });
      try {
        const p = await readyFirstCopyBook();
        const other = await books.project();
        const invite = books.data(
          await books.request(
            "POST",
            `/v1/projects/${other.projectId}/invitations`,
            other.buyer.token,
          ),
        );
        books.data(
          await books.request(
            "POST",
            `/v1/invitations/${invite.token}/accept`,
            p.narrator.token,
            {
              relationship: "家人",
              termsVersion: TERMS_VERSION,
            },
          ),
        );
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(
          `${flow.origin}/app/projects/${p.projectId}/production`,
        );
        await flow.signIn(page, flow.phoneFor(p.narrator));
        await fillAddress(page);
        const member = await books.db.projectMember.findUniqueOrThrow({
          where: {
            projectId_userId: { projectId: p.projectId, userId: p.narrator.id },
          },
        });
        for (const action of ["address", "submit", "refresh"]) {
          if (action === "address")
            await page
              .getByLabel("详细地址", { exact: true })
              .fill("失权前未保存的私人地址");
          if (action === "refresh") {
            await page
              .getByRole("button", { name: "提交印刷", exact: true })
              .click();
            await page
              .getByRole("heading", { name: "已提交，等待制作", exact: true })
              .waitFor();
            const current = books.data(
              await books.request("GET", p.base, p.buyer.token),
              200,
            );
            const headers = await paymentAdmin(books.config, books.app, [
              "fulfillment:write",
              "audit:read",
            ]);
            const orderBase = `/v1/admin/fulfillment/${current.production.id}`;
            const view = await admin(`${orderBase}/attempts`, headers, {
              bookVersionId: p.book.id,
              snapshotHash: p.book.snapshotHash,
              pdfHash: p.book.pdf.sha256,
              addressHash: current.address.hash,
              supplierRef: "record:synthetic-provider",
              dueAt: new Date(Date.now() + 86400000).toISOString(),
            });
            const attemptBase = `${orderBase}/attempts/${view.current.id}`;
            await admin(`${attemptBase}/handoff`, headers, {});
            await admin(`${attemptBase}/receipt`, headers, {
              outcome: "accepted",
              evidenceRef: "synthetic:印厂已接单",
            });
            await admin(`${attemptBase}/printing`, headers, {
              printedAt: new Date().toISOString(),
              evidenceRef: "synthetic:登记完成印制",
            });
            await admin(`${attemptBase}/shipping`, headers, {
              carrier: "失权前私人承运公司",
              number: "SYNTHETIC-PRIVATE-TRACKING",
              shippedAt: new Date().toISOString(),
              evidenceRef: "synthetic:登记发货",
            });
            await page
              .getByRole("button", { name: "刷新进度", exact: true })
              .click();
            await page
              .getByText("SYNTHETIC-PRIVATE-TRACKING", { exact: true })
              .waitFor();
            // A transport failure preserves already loaded private content.
            await page.route(
              `**/api/v1/projects/${p.projectId}/first-copy`,
              (route) => route.abort(),
              { times: 1 },
            );
            await page
              .getByRole("button", { name: "刷新进度", exact: true })
              .click();
            await page
              .getByRole("alert")
              .filter({ hasText: "暂时无法读取制作状态" })
              .waitFor();
            assert.equal(
              await page
                .getByText("SYNTHETIC-PRIVATE-TRACKING", { exact: true })
                .count(),
              1,
            );
            await page
              .getByRole("button", { name: "重新读取", exact: true })
              .click();
            await page.getByRole("alert").waitFor({ state: "hidden" });
            await page
              .getByRole("button", { name: "刷新进度", exact: true })
              .click({ trial: true });
          }
          // Controlled operator fixture: the next browser request uses the real
          // session and authorization checks against the revoked DB membership.
          await books.db.projectMember.delete({
            where: {
              projectId_userId: {
                projectId: p.projectId,
                userId: p.narrator.id,
              },
            },
          });
          const endpoint = `/api/v1/projects/${p.projectId}/first-copy${action === "refresh" ? "" : `/${action}`}`;
          const denied = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === endpoint &&
              response.status() === 403,
          );
          await page
            .getByRole("button", {
              name: {
                address: "保存收货地址",
                submit: "提交印刷",
                refresh: "刷新进度",
              }[action],
              exact: true,
            })
            .click();
          await denied;
          await page
            .getByRole("alert")
            .filter({ hasText: "请确认项目成员资格" })
            .waitFor();
          assert.equal(
            await page.locator(".production-card").count(),
            0,
            `${action}: private book/address must be removed`,
          );
          assert.equal(
            await page.getByRole("region", { name: "制作与物流进度" }).count(),
            0,
          );
          assert.equal(
            await page
              .getByText("SYNTHETIC-PRIVATE-TRACKING", { exact: true })
              .count(),
            0,
          );
          assert.equal(await page.getByRole("dialog").count(), 0);
          assert.equal(
            (
              await page.request.get(`${flow.origin}/api/v1/web/session`, {
                headers: { "X-Timenook-Web": "1" },
              })
            ).status(),
            200,
          );
          assert.equal(
            (
              await page.request.get(
                `${flow.origin}/api/v1/projects/${other.projectId}/overview`,
                { headers: { "X-Timenook-Web": "1" } },
              )
            ).status(),
            200,
          );
          if (action !== "refresh") {
            await books.db.projectMember.create({ data: member });
            await page
              .getByRole("button", { name: "重新读取", exact: true })
              .click();
            await page.getByLabel("收件人", { exact: true }).waitFor();
          }
        }
        await page.screenshot({
          path: join(
            root,
            `output/playwright/wv08-revoked-${engine.name()}.png`,
          ),
          fullPage: true,
        });
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: a member saves a supported address and submits the fixed ready book only once`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine, {
        previewPort: Number(process.env.TIMENOOK_TEST_PREVIEW_PORT || 4444),
      });
      try {
        const p = await readyFirstCopyBook();
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(
          `${flow.origin}/app/projects/${p.projectId}/production`,
        );
        await flow.signIn(page, flow.phoneFor(p.narrator));
        await page
          .getByRole("heading", { name: "让故事，成为一本书", exact: true })
          .waitFor();
        await fillAddress(page);
        // The real API commits the reservation, but its first browser response is lost.
        await page.route(
          `**/api/v1/projects/${p.projectId}/first-copy/submit`,
          async (route) => {
            await route.fetch();
            await route.abort();
          },
          { times: 1 },
        );
        await page
          .getByRole("button", { name: "提交印刷", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "提交结果尚未确认" })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "提交印刷", exact: true })
            .isDisabled(),
          true,
        );
        await page
          .getByRole("button", { name: "查询提交结果", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "已提交，等待制作", exact: true })
          .waitFor();
        const current = books.data(
          await books.request("GET", p.base, p.buyer.token),
          200,
        );
        assert.equal(current.production.bookVersionId, p.book.id);
        assert.equal(current.production.pdfHash, p.book.pdf.sha256);
        assert.equal(current.production.addressHash, current.address.hash);
        assert.equal(
          await page
            .getByRole("button", { name: "提交印刷", exact: true })
            .count(),
          0,
        );
        await page.reload();
        await page
          .getByRole("heading", { name: "已提交，等待制作", exact: true })
          .waitFor();
        assert.equal(
          books.data(await books.request("GET", p.base, p.buyer.token), 200)
            .production.id,
          current.production.id,
        );
        await page.screenshot({
          path: join(root, "output/playwright/wv08-submitted.png"),
          fullPage: true,
        });
        const headers = await paymentAdmin(books.config, books.app, [
          "fulfillment:write",
          "audit:read",
        ]);
        const orderBase = `/v1/admin/fulfillment/${current.production.id}`;
        const attemptBody = {
          bookVersionId: current.production.bookVersionId,
          snapshotHash: current.production.snapshotHash,
          pdfHash: current.production.pdfHash,
          addressHash: current.production.addressHash,
          supplierRef: "record:synthetic-provider",
          dueAt: new Date(Date.now() + 86400000).toISOString(),
        };
        let view = await admin(`${orderBase}/attempts`, headers, attemptBody);
        await admin(
          `${orderBase}/attempts/${view.current.id}/cancel`,
          headers,
          {
            evidenceRef: "synthetic:制作开始前确认取消",
          },
        );
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "本次制作已取消", exact: true })
          .waitFor();
        await fillAddress(page, "合成更正后地址二号");
        await page
          .getByRole("button", { name: "提交印刷", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "已提交，等待制作", exact: true })
          .waitFor();
        const revised = books.data(
          await books.request("GET", p.base, p.buyer.token),
          200,
        );
        assert.equal(revised.production.id, current.production.id);
        view = await admin(`${orderBase}/attempts`, headers, {
          ...attemptBody,
          addressHash: revised.address.hash,
        });
        const attemptBase = `${orderBase}/attempts/${view.current.id}`;
        await admin(`${attemptBase}/handoff`, headers, {});
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "正在核实制作安排", exact: true })
          .waitFor();
        await admin(`${attemptBase}/receipt`, headers, {
          outcome: "accepted",
          evidenceRef: "synthetic:印厂已接单",
        });
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "正在印制", exact: true })
          .waitFor();
        await admin(`${attemptBase}/cancel`, headers, {
          evidenceRef: "synthetic:请求核实取消",
        });
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "正在核实取消结果", exact: true })
          .waitFor();
        await page
          .getByText("已请求取消，须人工核实印厂结果；不承诺撤回实物。", {
            exact: true,
          })
          .waitFor();
        await admin(`${attemptBase}/receipt`, headers, {
          outcome: "cancellation_rejected",
          evidenceRef: "synthetic:印厂确认不可取消",
        });
        await admin(`${attemptBase}/printing`, headers, {
          printedAt: new Date().toISOString(),
          evidenceRef: "synthetic:独立登记完成印制",
        });
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "已印好，等待发货", exact: true })
          .waitFor();
        await admin(`${attemptBase}/shipping`, headers, {
          carrier: "合成承运公司",
          number: "SYNTHETIC-WV08-0001",
          shippedAt: new Date().toISOString(),
          evidenceRef: "synthetic:独立登记发货",
        });
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "已发货", exact: true })
          .waitFor();
        await page.getByText("SYNTHETIC-WV08-0001", { exact: true }).waitFor();
        await admin(`${attemptBase}/delivery`, headers, {
          deliveredAt: new Date().toISOString(),
          evidenceRef: "synthetic:登记送达",
        });
        await page
          .getByRole("button", { name: "刷新进度", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "已送达", exact: true })
          .waitFor();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({
          path: join(root, "output/playwright/wv08-delivered.png"),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: address and book changes require a fresh read, and content-only projects remain blocked`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine, {
        previewPort: Number(process.env.TIMENOOK_TEST_PREVIEW_PORT || 4444),
      });
      try {
        const p = await readyFirstCopyBook();
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.route(
          `**/api/v1/projects/${p.projectId}/first-copy`,
          (route) => route.abort(),
          { times: 1 },
        );
        await page.goto(
          `${flow.origin}/app/projects/${p.projectId}/production`,
        );
        await flow.signIn(page, flow.phoneFor(p.buyer));
        await page
          .getByRole("alert")
          .filter({ hasText: "暂时无法读取制作状态" })
          .waitFor();
        await page
          .getByRole("button", { name: "重新读取", exact: true })
          .click();
        await fillAddress(page);
        const options = await page
          .getByLabel("配送地区", { exact: true })
          .locator("option")
          .evaluateAll((nodes) => nodes.map((node) => node.value));
        assert.ok(options.includes("CN-110000"));
        assert.equal(options.includes("CN-810000"), false);
        const before = books.data(
          await books.request("GET", p.base, p.buyer.token),
          200,
        );
        books.data(
          await books.request("POST", `${p.base}/address`, p.narrator.token, {
            expectedVersion: before.address.version,
            ...before.address.value,
            detail: "家人保存的新地址",
          }),
        );
        await page
          .getByLabel("详细地址", { exact: true })
          .fill("未保存的本机地址草稿");
        await page
          .getByRole("button", { name: "保存收货地址", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "书稿、收货地址或制作状态已更新" })
          .waitFor();
        assert.equal(
          await page.getByLabel("详细地址", { exact: true }).inputValue(),
          "未保存的本机地址草稿",
        );
        await page
          .getByRole("button", { name: "读取最新状态", exact: true })
          .click();
        await page
          .getByRole("button", { name: "提交印刷", exact: true })
          .waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector("textarea")?.value === "家人保存的新地址",
        );
        books.data(
          await books.request(
            "POST",
            `/v1/projects/${p.projectId}/book/cover`,
            p.narrator.token,
            {
              ...(await books.coverMetadata(p.projectId, p.buyer.token)),
              expectedVersion: 0,
              salutation: "家人改写的新寄语",
              photoAssetId: null,
            },
          ),
        );
        await page
          .getByRole("button", { name: "提交印刷", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "书稿、收货地址或制作状态已更新" })
          .waitFor();
        await page
          .getByRole("button", { name: "读取最新状态", exact: true })
          .click();
        await page
          .getByText("请先生成完整书稿，再提交制作。", { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "提交印刷", exact: true })
            .isDisabled(),
          true,
        );
        await page.setViewportSize({ width: 320, height: 780 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.screenshot({
          path: join(root, "output/playwright/wv08-address.png"),
          fullPage: true,
        });
        const blocked = await readyFirstCopyBook({}, false);
        const blockedContext = await flow.context
          .browser()
          .newContext({ ignoreHTTPSErrors: true });
        const blockedPage = await blockedContext.newPage();
        await blockedPage.goto(
          `${flow.origin}/app/projects/${blocked.projectId}/production`,
        );
        await flow.signIn(blockedPage, flow.phoneFor(blocked.narrator));
        await blockedPage
          .getByText("当前项目没有实体书制作权益。", { exact: true })
          .first()
          .waitFor();
        assert.equal(
          await blockedPage
            .getByRole("button", { name: "提交印刷", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await blockedPage
            .getByRole("button", { name: "保存收货地址", exact: true })
            .count(),
          0,
        );
        await blockedContext.close();
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );
