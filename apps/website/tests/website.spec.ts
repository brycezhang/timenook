import { expect, test } from "@playwright/test";

test("访客能翻看样书节选并返回前一篇故事", async ({ page }) => {
  await page.goto("/");
  const sample = page.getByRole("region", { name: "样书节选" });
  await expect(
    sample.getByRole("heading", { name: "老屋门前的那棵桂花树" }),
  ).toBeVisible();
  await expect(sample.getByRole("button", { name: "上一篇" })).toBeDisabled();
  await sample.getByRole("button", { name: "下一篇" }).click();
  await expect(
    sample.getByRole("heading", { name: "第一次坐火车去远方" }),
  ).toBeVisible();
  await sample.getByRole("button", { name: "上一篇" }).click();
  await expect(
    sample.getByRole("heading", { name: "老屋门前的那棵桂花树" }),
  ).toBeVisible();
});

test("访客能切换讲述与整理稿，键盘也能操作", async ({ page }) => {
  await page.goto("/");
  const narration = page.getByRole("tab", { name: "示例讲述", exact: true });
  const story = page.getByRole("tab", { name: "整理后的故事", exact: true });
  await expect(narration).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("街坊的招呼声");
  await expect(page.getByRole("tabpanel")).toContainText("一闻到桂花的香味");
  await story.click();
  await expect(story).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("一闻到桂花的香味");
  await story.press("ArrowLeft");
  await expect(narration).toBeFocused();
  await expect(narration).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("我把书包一放");
});

test("下单入口说明尚未开放，关闭与 Escape 都恢复焦点", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const order = page.getByRole("button", { name: "去微信小程序下单" }).first();
  await order.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("暂未开放下单");
  await page.screenshot({
    path: `/tmp/timenook-website-${testInfo.project.name}-dialog.png`,
  });
  await dialog.getByRole("button", { name: "知道了" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(order).toBeFocused();
  await order.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(order).toBeFocused();
});

test("常见问题可以展开并再次收起", async ({ page }) => {
  await page.goto("/");
  const question = page.getByText("爸妈不太会用手机，也能参与吗？", {
    exact: true,
  });
  const answer = page.getByText(
    "可以。爸妈在场并同意时，你可以当面协助操作，录下他们自己的讲述。故事整理后仍由本人确认，再决定是否入书。",
    { exact: true },
  );
  await expect(answer).not.toBeVisible();
  await question.click();
  await expect(answer).toBeVisible();
  await question.click();
  await expect(answer).not.toBeVisible();
});

test("页面品牌、图片和版面完整，没有脚本错误或横向溢出", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page).toHaveTitle(/时光里 · 岁月成书/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "把爸妈的故事",
  );
  await expect(
    page.getByText("© 2026 千言一语文化传媒有限公司. All rights reserved.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /咨询|客服/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /咨询|客服/ })).toHaveCount(0);
  for (const image of await page.getByRole("img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const img = element as HTMLImageElement;
          return img.complete && img.naturalWidth > 0;
        }),
      )
      .toBe(true);
  }
  await page.getByRole("link", { name: "返回时光里首页" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  for (const control of await page
    .getByRole("button")
    .or(page.getByRole("tab"))
    .all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(48);
    expect(box?.height).toBeGreaterThanOrEqual(48);
  }
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `/tmp/timenook-website-${testInfo.project.name}-full.png`,
    fullPage: true,
  });
  await page.screenshot({
    path: `/tmp/timenook-website-${testInfo.project.name}-viewport.png`,
  });
});

test("公开预览保留禁止索引声明与robots文件", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
});
