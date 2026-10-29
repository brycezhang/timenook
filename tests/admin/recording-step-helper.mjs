import { expect } from "@playwright/test";

export async function prepareRecordingStep(page) {
  const start = page.getByRole("button", { name: "开始说", exact: true });
  const prepare = page.getByRole("button", { name: "再说一小段", exact: true });
  await expect
    .poll(async () => (await start.isVisible()) || (await prepare.isVisible()))
    .toBe(true);
  if (!(await start.isVisible())) await prepare.click();
  await expect(page.locator(".step-title")).toHaveText("准备开讲");
}

export async function showProcessingStep(page) {
  const target = page.getByRole("button", {
    name: "请求一条可选追问",
    exact: true,
  });
  const open = page.getByRole("button", {
    name: "查看处理与追问",
    exact: true,
  });
  await expect
    .poll(async () => (await target.isVisible()) || (await open.isVisible()))
    .toBe(true);
  if (!(await target.isVisible())) await open.click();
}
