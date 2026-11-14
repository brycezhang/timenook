// Cold Vite startup can compile the authenticated route after the HTML loads.
// Fail script errors immediately while the caller waits for its actual page.
export async function waitForAdminStartup(page, ready) {
  let fail;
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  const onPageError = (error) => fail(error);
  page.on("pageerror", onPageError);
  try {
    await Promise.race([ready(), failed]);
  } finally {
    page.off("pageerror", onPageError);
  }
}

export async function logoutAdmin(page) {
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
}
