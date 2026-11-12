import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { books, root, storyBrowser } from "./flow-fixture.mjs";

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(
    `${engineName}: members read/edit versioned stories, manage project/profile and explicitly accept web invitations`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine);
      try {
        const p = await books.readyStory();
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(`${flow.origin}/app/projects/${p.projectId}`);
        await page
          .getByRole("dialog", { name: "登录，继续你的故事" })
          .waitFor();
        await flow.signIn(page, flow.phoneFor(p.buyer));
        await page
          .getByRole("heading", { name: "私人标题不能泄露", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "修改项目名称", exact: true })
          .click();
        const title = "妈妈亲手写下的长长时光故事，值得一家人一起珍藏";
        await page.getByLabel("项目名称", { exact: true }).fill(title);
        await page
          .getByRole("button", { name: "保存名称", exact: true })
          .click();
        await page.getByRole("heading", { name: title, exact: true }).waitFor();
        await page
          .getByLabel("搜索故事", { exact: true })
          .fill("没有这个关键词");
        await page
          .getByRole("heading", { name: "没有找到这段故事", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "查看全部故事", exact: true })
          .click();
        await page.locator(".story-card").first().click();
        await page
          .getByRole("heading", { name: p.story.revision.title, exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "编辑故事", exact: true })
          .click();
        await page
          .getByLabel("故事标题", { exact: true })
          .fill("院子里那棵枣树");
        await page
          .getByLabel("故事正文", { exact: true })
          .fill(
            "小时候，我们在院子里种下一棵枣树。\n\n每年秋天，家里人都一起收枣子。",
          );
        await page
          .getByRole("button", { name: "保存修改", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "院子里那棵枣树", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "移出书稿", exact: true })
          .click();
        await page
          .getByRole("button", { name: "编入书稿", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "编入书稿", exact: true })
          .click();
        await page
          .getByRole("button", { name: "移出书稿", exact: true })
          .waitFor();
        await page.screenshot({
          path: join(root, `output/playwright/wv03-story-${engineName}.png`),
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "编辑故事", exact: true })
          .click();
        await page
          .getByLabel("故事正文", { exact: true })
          .fill("我还没有保存的故事草稿。 ");
        const current = books.data(
          await books.request(
            "GET",
            `/v1/projects/${p.projectId}/stories/${p.story.id}`,
            p.narrator.token,
          ),
          200,
        );
        books.data(
          await books.request(
            "POST",
            `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
            p.narrator.token,
            {
              expectedVersion: current.version,
              baseRevisionId: current.revision.id,
              title: "家人刚刚修改的枣树故事",
              theme: current.revision.theme,
              paragraphs: current.revision.paragraphs,
              notes: current.revision.notes,
              reviewResolutions: current.revision.reviewResolutions,
            },
          ),
        );
        await page
          .getByRole("button", { name: "保存修改", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "内容已被其他成员更新" })
          .waitFor();
        assert.equal(
          await page.getByLabel("故事正文", { exact: true }).inputValue(),
          "我还没有保存的故事草稿。 ",
        );
        await page
          .getByRole("button", { name: "读取最新版本", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "家人刚刚修改的枣树故事", exact: true })
          .waitFor();
        await page
          .getByRole("link", { name: "返回故事", exact: false })
          .click();
        await page
          .getByRole("button", { name: "邀请家人", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "邀请链接", exact: true })
          .waitFor();
        const invitationUrl = await page
          .getByRole("textbox", { name: "邀请链接", exact: true })
          .inputValue();
        assert.ok(invitationUrl.startsWith(`${flow.origin}/app/invite/`));
        await page
          .getByRole("button", { name: "关闭邀请", exact: true })
          .click();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({
          path: join(root, `output/playwright/wv03-project-${engineName}.png`),
          fullPage: true,
        });
        await page.goto(`${flow.origin}/app/account`);
        await page
          .getByRole("button", { name: "修改昵称", exact: true })
          .click();
        await page.getByLabel("昵称", { exact: true }).fill("一起记录的人");
        await page
          .getByRole("button", { name: "保存昵称", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "一起记录的人", exact: true })
          .waitFor();
        // A fresh browser profile must explicitly join, even after it logs in.
        const memberContext = await flow.context.browser().newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 320, height: 780 },
        });
        const memberPage = await memberContext.newPage();
        const outsider = await books.login();
        await memberPage.goto(invitationUrl);
        await memberPage
          .getByRole("heading", { name: "一起把故事写完整", exact: true })
          .waitFor();
        await memberPage
          .getByRole("button", { name: "登录后接受邀请", exact: true })
          .click();
        await flow.signIn(memberPage, flow.phoneFor(outsider));
        await memberPage
          .getByRole("button", { name: "接受邀请", exact: true })
          .waitFor();
        assert.equal(
          memberPage.url(),
          invitationUrl,
          "login returns to the same invitation",
        );
        assert.deepEqual(
          books.data(
            await books.request("GET", "/v1/participations", outsider.token),
            200,
          ).projects,
          [],
          "login alone does not join the project",
        );
        await memberPage.getByLabel("你是主讲人的谁（必填）").fill("外孙女");
        await memberPage.getByRole("checkbox", { name: /同意/ }).check();
        await memberPage
          .getByRole("button", { name: "接受邀请", exact: true })
          .click();
        await memberPage
          .getByRole("heading", { name: title, exact: true })
          .waitFor();
        assert.equal(
          await memberPage
            .getByRole("button", { name: "邀请家人", exact: true })
            .count(),
          0,
        );
        assert.ok(
          (await memberPage
            .getByRole("link", { name: "再记一个故事", exact: true })
            .count()) >= 1,
        );
        assert.equal(
          await memberPage.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await memberPage.locator(".story-card").first().click();
        await memberPage
          .getByRole("button", { name: "编辑故事", exact: true })
          .waitFor();
        await memberContext.close();
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );
}
