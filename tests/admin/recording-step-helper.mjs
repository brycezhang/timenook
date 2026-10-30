import { expect } from "@playwright/test";

export async function chooseDefaultQuestion(page) {
  await page.getByRole("button", { name: "换个问题", exact: true }).click();
  await page
    .getByRole("button", { name: "就从这个问题开始", exact: true })
    .click();
}
export async function prepareRecordingStep(page) {
  const start = page.getByRole("button", { name: "开始说", exact: true });
  const prepare = page.getByRole("button", { name: "再说一小段", exact: true });
  const answer = page.getByRole("button", {
    name: "回答这个问题",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        ((await start.isVisible()) && (await start.isEnabled())) ||
        (await prepare.isVisible()) ||
        (await answer.isVisible()) ||
        (await page.locator(".review-player").isVisible()),
    )
    .toBe(true);
  if (await page.locator(".review-player").isVisible()) {
    await page
      .getByRole("button", { name: "更多讲述操作", exact: true })
      .click();
    await page.getByRole("button", { name: "再补充一段", exact: true }).click();
  } else if (!((await start.isVisible()) && (await start.isEnabled()))) {
    if (await answer.isVisible()) await answer.click();
    else await prepare.click();
  }
  await expect(start).toBeVisible();
}
export async function showProcessingStep(page) {
  const more = page.getByRole("button", { name: "更多讲述操作", exact: true });
  const choose = page.getByRole("button", { name: "换个问题", exact: true });
  const back = page.getByRole("button", { name: "返回保存进度", exact: true });
  await expect
    .poll(
      async () =>
        (await page.locator(".processing-step").isVisible()) ||
        ((await more.isVisible()) && (await more.isEnabled())) ||
        ((await choose.isVisible()) && (await choose.isEnabled())) ||
        (await back.isVisible()),
    )
    .toBe(true);
  if (await page.locator(".processing-step").isVisible()) return;
  if (await page.locator(".review-player").isVisible()) {
    await page
      .getByRole("button", { name: "更多讲述操作", exact: true })
      .click();
    await page
      .getByRole("button", { name: "查看保存进度", exact: true })
      .click();
    return;
  }
  if (await back.isVisible()) {
    await back.click();
    return;
  }
  await page.getByRole("button", { name: "换个问题", exact: true }).click();
  await page
    .getByRole("button", { name: "查看已保存的讲述", exact: true })
    .click();
}

export async function openInterviewPhotos(page) {
  const more = page.getByRole("button", { name: "更多讲述操作", exact: true });
  const choose = page.getByRole("button", { name: "换个问题", exact: true });
  await expect
    .poll(
      async () =>
        ((await more.isVisible()) && (await more.isEnabled())) ||
        ((await choose.isVisible()) && (await choose.isEnabled())),
    )
    .toBe(true);
  if (await more.isVisible()) await more.click();
  else
    await page.getByRole("button", { name: "换个问题", exact: true }).click();
  await page
    .getByRole("button", { name: "查看照片或事后补图", exact: true })
    .click();
}
export async function storyAction(page, name) {
  await page
    .getByRole("button", { name: "修改、照片与原声", exact: true })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}

export async function showSavedRecording(page) {
  await page.getByRole("button", { name: "更多讲述操作", exact: true }).click();
  await page
    .getByRole("button", { name: "回听已保存片段", exact: true })
    .click();
}

export async function resumeVisiblePage(page) {
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
}
