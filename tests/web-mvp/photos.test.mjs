import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { books, root, storyBrowser } from "./flow-fixture.mjs";
const requireApi = createRequire(`${root}/apps/api/package.json`);
const sharp = requireApi("sharp");

for (const engine of [chromium, webkit])
  test(
    `${engine.name()}: Vue photos upload with retry, retain captions in the story and start a photo interview`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine, { previewPort: 4447 });
      try {
        await flow.context.addInitScript(() => {
          // The device input is synthetic; recording, MP3 encoding and upload remain real.
          if (!navigator.mediaDevices) return;
          navigator.mediaDevices.getUserMedia = async () => {
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const output = context.createMediaStreamDestination();
            oscillator.frequency.value = 220;
            oscillator.connect(output);
            oscillator.start();
            await context.resume();
            return output.stream;
          };
        });
        const p = await books.readyStory();
        const page = await flow.context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(
          `${flow.origin}/app/projects/${p.projectId}/stories/${p.story.id}/photos`,
        );
        await flow.signIn(page, flow.phoneFor(p.narrator));
        await page
          .getByRole("heading", { name: "故事里的照片", exact: true })
          .waitFor();
        const image = await sharp({
          create: {
            width: 960,
            height: 640,
            channels: 3,
            background: "#e54334",
          },
        })
          .jpeg()
          .toBuffer();
        let interrupt = true;
        await page.route("**/api/v1/photos/objects", async (route) => {
          if (interrupt) {
            interrupt = false;
            await route.abort();
          } else await route.continue();
        });
        await page.getByLabel("选择照片", { exact: true }).setInputFiles({
          name: "family.jpg",
          mimeType: "image/jpeg",
          buffer: image,
        });
        await page
          .getByRole("button", { name: "重试上传", exact: true })
          .click();
        await page
          .getByLabel("照片说明 1", { exact: true })
          .fill("小时候一家人在院子里");
        await page
          .getByRole("button", { name: "保存照片说明", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "照片已保存" })
          .waitFor();
        await page.getByRole("link", { name: /返回故事/ }).click();
        await expect(
          page.getByRole("img", { name: "小时候一家人在院子里", exact: true }),
        ).toBeVisible();
        const imageUrl = await page
          .getByRole("img", { name: "小时候一家人在院子里", exact: true })
          .getAttribute("src");
        assert.match(imageUrl, /^blob:/);
        await page
          .getByRole("button", { name: "回听原声", exact: true })
          .click();
        const original = page.locator("audio");
        await expect(original).toBeVisible();
        await expect
          .poll(() => original.evaluate((node) => node.duration))
          .toBeGreaterThan(0);
        await original.evaluate((node) => node.play());
        await expect
          .poll(() => original.evaluate((node) => node.currentTime))
          .toBeGreaterThan(0);
        await page.getByRole("link", { name: "管理照片", exact: true }).click();
        await page
          .getByRole("button", { name: "删除照片 1", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "照片已保存" })
          .waitFor();
        await page.getByRole("link", { name: /返回故事/ }).click();
        await expect(
          page.getByRole("img", { name: "小时候一家人在院子里", exact: true }),
        ).toHaveCount(0);
        await page.goto(`${flow.origin}/app/projects/${p.projectId}/photos`);
        await page
          .getByRole("heading", { name: "从照片说起", exact: true })
          .waitFor();
        await page.getByLabel("选择照片", { exact: true }).setInputFiles([
          { name: "family.jpg", mimeType: "image/jpeg", buffer: image },
          { name: "courtyard.jpg", mimeType: "image/jpeg", buffer: image },
        ]);
        await expect(
          page.getByRole("img", { name: "故事照片 1", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("link", { name: "看着照片讲一讲", exact: true })
          .click();
        await expect(page.getByRole("img", { name: /^故事照片 / })).toHaveCount(
          2,
        );
        await expect(
          page.getByRole("img", { name: "故事照片 1", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "开始录音", exact: true }),
        ).toBeVisible();
        assert.match(page.url(), /\/record\?interviewId=/);
        const interviewId = new URL(page.url()).searchParams.get("interviewId");
        await page.setViewportSize({ width: 320, height: 568 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page
          .getByRole("button", { name: "开始录音", exact: true })
          .click();
        await page
          .getByRole("button", { name: "暂停录音", exact: true })
          .waitFor();
        await expect(
          page.getByRole("img", { name: "故事照片 1", exact: true }),
        ).toBeVisible();
        await page.waitForTimeout(1300);
        await page
          .getByRole("button", { name: "暂停录音", exact: true })
          .click();
        await expect(
          page.getByRole("status").filter({ hasText: "已暂停" }),
        ).toBeVisible();
        await expect(
          page.getByRole("img", { name: "故事照片 1", exact: true }),
        ).toBeVisible();
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: join(root, "output/playwright/web-photo-recording-320.png"),
          fullPage: true,
        });
        const end = await page
          .getByRole("button", { name: "结束录音", exact: true })
          .boundingBox();
        assert.ok(
          end.y + end.height <= 500,
          "recording controls stay above the mobile bottom navigation at 320x568",
        );
        await page
          .getByRole("button", { name: "继续录音", exact: true })
          .click();
        await page.waitForTimeout(1300);
        await page
          .getByRole("button", { name: "结束录音", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "故事已整理好", exact: true })
          .waitFor({ timeout: 30000 });
        await page.getByRole("link", { name: "查看故事", exact: true }).click();
        await expect(
          page.getByRole("img", { name: "故事照片 1", exact: true }),
        ).toBeVisible();
        const storyUrl = page.url();
        await page.goto(
          `${flow.origin}/app/projects/${p.projectId}/photos?interviewId=${interviewId}`,
        );
        await page
          .getByLabel("照片说明 1", { exact: true })
          .fill("老院子里的另一段回忆");
        await page
          .getByRole("button", { name: "保存照片说明", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "照片已保存" })
          .waitFor();
        await page.goto(storyUrl);
        await expect(
          page.getByRole("img", { name: "老院子里的另一段回忆", exact: true }),
        ).toBeVisible();
        const media = await page
          .getByRole("img", { name: "老院子里的另一段回忆", exact: true })
          .getAttribute("src");
        const other = await flow.context.newPage();
        await other.goto(`${flow.origin}/app/account`);
        await other
          .getByRole("button", { name: "退出登录", exact: true })
          .click();
        await expect(
          page.getByRole("img", { name: "老院子里的另一段回忆", exact: true }),
        ).toHaveCount(0);
        assert.equal(
          await page.evaluate(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }, media),
          true,
        );
        assert.deepEqual(flow.errors, []);
      } finally {
        await flow.close();
      }
    },
  );
