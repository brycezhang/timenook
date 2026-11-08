import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "@playwright/test";
import { books, root, storyBrowser } from "./flow-fixture.mjs";

for (const engine of [chromium, webkit])
  test(`${engine.name()}: member composes a real book, reads its PDF and frozen audio, then clears private access`, async () => {
    const fixture = await storyBrowser(engine);
    try {
      const p = await books.readyStory();
      const materials = await books.storyPhoto(p, "那年院子里的合照");
      p.story = books.data(
        await books.request(
          "POST",
          `/v1/projects/${p.projectId}/stories/${p.story.id}/revisions`,
          p.narrator.token,
          {
            baseRevisionId: p.story.revision.id,
            expectedVersion: p.story.version,
            title: "院子里的童年",
            theme: p.story.revision.theme,
            paragraphs: p.story.revision.paragraphs,
            notes: [],
            photoSnapshotId: materials.id,
            reviewResolutions: p.story.revision.reviewItems.map((item) => ({
              item,
              reason: "核对后保留",
            })),
          },
        ),
      );
      const second = await books.readyStory(p);
      const base = `/v1/projects/${p.projectId}`;
      const page = await fixture.context.newPage();
      await page.goto(`${fixture.origin}/app/projects/${p.projectId}/book`);
      await fixture.signIn(page, fixture.phoneFor(p.buyer));
      await page
        .getByRole("heading", { name: "我的书稿", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "编辑封面", exact: true }).click();
      await page.getByLabel("书名", { exact: true }).fill("妈妈的旧时光");
      await page.getByLabel("封面寄语").fill("把一路走来的日子，留给家人。");
      await page
        .getByRole("button", { name: "选择封面照片", exact: true })
        .click();
      await page
        .getByRole("button", { name: "那年院子里的合照", exact: true })
        .click();
      await page.getByAltText("选定的封面照片").waitFor();
      await page.getByRole("button", { name: "保存封面", exact: true }).click();
      await page.getByText("封面已保存", { exact: true }).waitFor();
      const projectPage = await fixture.context.newPage();
      await projectPage.setViewportSize({ width: 1280, height: 900 });
      await projectPage.goto(`${fixture.origin}/app/projects/${p.projectId}`);
      await projectPage
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "岁月成书", exact: true })
        .click();
      await projectPage.getByAltText("故事书封面照片").waitFor();
      assert.ok(
        await projectPage
          .getByAltText("故事书封面照片")
          .evaluate(async (image) => {
            await image.decode();
            return image.naturalWidth > 0;
          }),
      );
      await projectPage.close();
      await page
        .getByRole("button", { name: "管理入书故事", exact: true })
        .click();
      await page.getByRole("button", { name: "添加章节", exact: true }).click();
      await page.getByLabel("章节名称 2", { exact: true }).fill("后来的日子");
      await page
        .getByLabel(`移动故事 ${second.story.id}`)
        .selectOption({ label: "后来的日子" });
      await page.getByRole("button", { name: "保存目录", exact: true }).click();
      await page.getByText("目录已保存", { exact: true }).waitFor();
      await page.getByRole("button", { name: "生成书稿", exact: true }).click();
      await page
        .getByText("书稿已就绪", { exact: true })
        .waitFor({ timeout: 45000 });
      const current = books.data(
        await books.request("GET", `${base}/book`, p.buyer.token),
        200,
      ).current;
      assert.equal(current.snapshot.cover.title, "妈妈的旧时光");
      assert.equal(
        current.snapshot.cover.salutation,
        "把一路走来的日子，留给家人。",
      );
      assert.equal(current.snapshot.chapters[1].stories[0].id, second.story.id);
      assert.equal(current.snapshot.cover.photo.caption, "那年院子里的合照");
      await page.setViewportSize({ width: 320, height: 700 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "book fits narrow screen",
      );
      await page.screenshot({
        path: `${root}/output/playwright/web-book-mobile-${engine.name()}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: `${root}/output/playwright/web-book-desktop-${engine.name()}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "阅读 PDF", exact: true }).click();
      await page.locator('iframe[title="书稿 PDF"]').waitFor();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载 PDF", exact: true }).click();
      assert.match((await download).suggestedFilename(), /\.pdf$/);
      assert.equal(
        await page.locator('iframe[title="书稿 PDF"]').count(),
        1,
        "download keeps the open reader",
      );
      await page.getByRole("button", { name: "编辑封面", exact: true }).click();
      await page.getByLabel("封面寄语").fill("尚未保存的寄语");
      const bookContext = books.data(
        await books.request("GET", `${base}/book`, p.buyer.token),
        200,
      );
      books.data(
        await books.request("POST", `${base}/book/cover`, p.narrator.token, {
          expectedVersion: bookContext.cover.version,
          salutation: "另一位成员保存的寄语",
          photoAssetId: bookContext.cover.photoAssetId,
        }),
      );
      await page.waitForResponse(
        (response) =>
          response.url().endsWith(`${base.replace("/v1/", "/api/v1/")}/book`) &&
          response.request().method() === "GET",
      );
      await page.getByRole("button", { name: "保存封面", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "内容已被其他成员更新" })
        .waitFor();
      assert.equal(
        await page.getByLabel("封面寄语").inputValue(),
        "尚未保存的寄语",
      );
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("dialog", { name: "编辑封面", exact: true })
        .getByRole("button", { name: "读取最新内容", exact: true })
        .click();
      await page.getByText("内容已修改，请重新生成", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "更换封面照片", exact: true })
        .click();
      await page.getByRole("button", { name: "不用照片", exact: true }).click();
      await page.getByRole("button", { name: "保存封面", exact: true }).click();
      await page.getByText("封面已保存", { exact: true }).waitFor();
      assert.equal(
        books.data(
          await books.request("GET", `${base}/book`, p.buyer.token),
          200,
        ).cover.photoAssetId,
        null,
      );
      await page.goto(
        `${fixture.origin}/app/projects/${p.projectId}/book?version=${current.id}`,
      );
      await page
        .getByText("正在查看固定的第 1 版书稿。", { exact: false })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "保存封面", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "下载 PDF", exact: true })
          .count(),
        0,
      );
      await page
        .getByText("把一路走来的日子，留给家人。", { exact: true })
        .waitFor();
      const entry = current.snapshot.chapters[0].stories[0].entry;
      await page.goto(`${fixture.origin}/app/audio/${entry.id}`);
      await page
        .getByRole("heading", { name: "书中原声", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "播放第 1 段", exact: true })
        .click();
      await page.locator("audio").waitFor();
      await page.waitForFunction(
        () => document.querySelector("audio")?.currentTime > 0,
      );
      const accountPage = await fixture.context.newPage();
      await accountPage.goto(`${fixture.origin}/app/account`);
      const loggedOut = accountPage.waitForResponse(
        (response) =>
          response.url().endsWith("/web/session") &&
          response.request().method() === "DELETE",
      );
      await accountPage
        .getByRole("button", { name: "退出登录", exact: true })
        .click();
      await loggedOut;
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.locator("audio").count(), 0);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
