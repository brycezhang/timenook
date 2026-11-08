import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { books, root, storyBrowser } from "./flow-fixture.mjs";
for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: five-tab workspace keeps the selected real project, handles an empty account and fits recording at 320px`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine);
      try {
        const first = await books.readyStory();
        const second = await books.project();
        const secondTitle = "爸爸的时光手记 · 全家一起珍藏的故事";
        const overview = books.data(
          await books.request(
            "GET",
            `/v1/projects/${second.projectId}/overview`,
            second.buyer.token,
          ),
          200,
        );
        books.data(
          await books.request(
            "POST",
            `/v1/projects/${second.projectId}/metadata`,
            second.buyer.token,
            {
              expectedVersion: overview.metadataVersion,
              bookTitle: secondTitle,
            },
          ),
        );
        const invitation = books.data(
          await books.request(
            "POST",
            `/v1/projects/${second.projectId}/invitations`,
            second.buyer.token,
          ),
        );
        books.data(
          await books.request(
            "POST",
            `/v1/invitations/${invitation.token}/accept`,
            first.buyer.token,
            {
              termsVersion: (
                await import("../../packages/contracts/dist/index.js")
              ).USER_TERMS_VERSION,
            },
          ),
        );
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(`${flow.origin}/app/projects/${first.projectId}`);
        await flow.signIn(page, flow.phoneFor(first.buyer));
        await expect(
          page.getByRole("heading", { name: "私人标题不能泄露", exact: true }),
        ).toBeVisible();
        const nav = page.getByRole("navigation", {
          name: "手机主导航",
          exact: true,
        });
        assert.deepEqual(
          (await nav.getByRole("button").allTextContents()).map((text) =>
            text.trim(),
          ),
          ["首页", "故事", "书稿", "项目", "我的"],
        );
        await nav.getByRole("button", { name: "首页", exact: true }).click();
        await expect(
          page.getByRole("heading", {
            name: "把往事，慢慢写成书。",
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.locator(".recent-story")).toHaveCount(1);
        const initialTopic = await page.locator(".topic-card h2").innerText();
        await page
          .locator(".topic-card")
          .getByRole("button", { name: "换个话题", exact: true })
          .click();
        const chosenTopic = await page.locator(".topic-card h2").innerText();
        assert.notEqual(chosenTopic, initialTopic);
        await page
          .getByRole("link", { name: "从这里开始", exact: true })
          .click();
        await expect(page.locator(".recording-question")).toHaveText(
          chosenTopic,
        );
        await nav.getByRole("button", { name: "首页", exact: true }).click();
        await expect(page.locator(".recent-story")).toHaveCount(1);
        await nav.getByRole("button", { name: "项目", exact: true }).click();
        await expect(page.locator(".project-card")).toHaveCount(2);
        await page.setViewportSize({ width: 320, height: 568 });
        assert.equal(
          await page
            .locator(".project-card .project-cover")
            .evaluateAll((covers) =>
              covers.every((cover) => {
                const b = cover.getBoundingClientRect(),
                  c = cover.closest(".project-card").getBoundingClientRect();
                return b.left >= c.left && b.right <= c.right;
              }),
            ),
          true,
          "both thumbnails stay inside their 320px project cards",
        );
        await expect(page.locator(".project-card .skeleton")).toHaveCount(0);
        await page.screenshot({
          path: `${root}/output/playwright/design-two-projects-${engine.name()}-320.png`,
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .locator(".project-card")
          .filter({ hasText: secondTitle })
          .click();
        await expect(page.locator(".workspace-hero-copy h2")).toHaveText(
          secondTitle,
        );
        await page.setViewportSize({ width: 320, height: 568 });
        assert.equal(
          await page
            .locator(".workspace-hero-cover")
            .evaluate(
              (cover) =>
                cover.getBoundingClientRect().bottom <=
                document.querySelector(".hero-stats").getBoundingClientRect()
                  .top,
            ),
          true,
          "long-title cover stays above the statistics",
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await nav.getByRole("button", { name: "书稿", exact: true }).click();
        await expect(page.locator(".book-cover h2")).toHaveText(secondTitle);
        await nav.getByRole("button", { name: "故事", exact: true }).click();
        await expect(page.locator(".current-project-label")).toHaveText(
          secondTitle,
        );
        await nav.getByRole("button", { name: "我的", exact: true }).click();
        const nicknameButton = page.getByRole("button", {
          name: "修改昵称",
          exact: true,
        });
        await nicknameButton.click();
        await expect(page.getByLabel("昵称", { exact: true })).toBeFocused();
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press("Tab");
          assert.equal(
            await page.evaluate(
              () => !!document.activeElement.closest("dialog:modal"),
            ),
            true,
            `Tab ${index + 1} stays in the active modal`,
          );
        }
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(nicknameButton).toBeFocused();
        await page.setViewportSize({ width: 320, height: 568 });
        await page.goto(
          `${flow.origin}/app/projects/${first.projectId}/record`,
        );
        await page
          .getByRole("button", { name: "开始录音", exact: true })
          .waitFor();
        assert.equal(
          await page.locator(".recording-start").evaluate((button) => {
            const r = button.getBoundingClientRect(),
              n = document.querySelector(".bottom-nav").getBoundingClientRect();
            return r.top >= 0 && r.bottom <= n.top;
          }),
          true,
        );
        await page
          .getByRole("button", { name: "换个话题", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "选一个想讲的话题", exact: true }),
        ).toBeVisible();
        assert.ok((await page.locator(".recording-topic").count()) > 0);
        await page.keyboard.press("Escape");
        await page.screenshot({
          path: `${root}/output/playwright/design-fixed-record-${engine.name()}.png`,
        });
        await page.goto(`${flow.origin}/app/account`);
        await page
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "欢迎来到时光故事", exact: true }),
        ).toBeVisible();
        const empty = await books.login();
        await page.goto(`${flow.origin}/app/`);
        await page
          .getByRole("button", { name: "登录 / 注册", exact: true })
          .click();
        await flow.signIn(page, flow.phoneFor(empty));
        await expect(
          page.getByRole("heading", {
            name: "第一本故事书，从这里开始。",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("navigation", { name: "手机主导航", exact: true })
          .getByRole("button", { name: "书稿", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "你的第一本书，还在等故事",
            exact: true,
          }),
        ).toBeVisible();
        assert.equal(
          await page.getByText(secondTitle, { exact: true }).count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );
}
