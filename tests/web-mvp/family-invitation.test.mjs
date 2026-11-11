import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "@playwright/test";
import { books, storyBrowser } from "./flow-fixture.mjs";

for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(
    `${name}: web invitation requires a narrator-relative relationship and joins the same project`,
    { timeout: 120000 },
    async () => {
      const flow = await storyBrowser(engine, { previewPort: 4454 });
      try {
        const p = await books.project(),
          invited = await books.login();
        const invite = books.data(
          await books.request(
            "POST",
            `/v1/projects/${p.projectId}/invitations`,
            p.buyer.token,
          ),
        );
        const page = await flow.context.newPage();
        await page.goto(`${flow.origin}/app/invite/${invite.token}`);
        await page
          .getByRole("button", { name: "登录后接受邀请", exact: true })
          .click();
        await flow.signIn(page, flow.phoneFor(invited));
        assert.ok(page.url().endsWith(`/invite/${invite.token}`));
        await page.getByRole("checkbox", { name: /同意/ }).check();
        await page
          .getByRole("button", { name: "接受邀请", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "请填写你是主讲人的谁" })
          .waitFor();
        assert.deepEqual(
          books.data(
            await books.request("GET", "/v1/participations", invited.token),
            200,
          ).projects,
          [],
        );
        await page.getByLabel("你是主讲人的谁（必填）").fill("外孙女");
        await page
          .getByRole("button", { name: "接受邀请", exact: true })
          .click();
        await page.waitForURL(`**/app/projects/${p.projectId}`);
        const profile = books.data(
          await books.request(
            "GET",
            `/v1/projects/${p.projectId}/member-profile`,
            invited.token,
          ),
          200,
        );
        assert.equal(profile.relationship, "外孙女");
        const list = books.data(
          await books.request("GET", "/v1/participations", invited.token),
          200,
        ).projects;
        assert.equal(list[0].projectId, p.projectId);
        assert.deepEqual(list[0].categories, ["participating"]);
        assert.equal(
          await page
            .getByRole("button", { name: "邀请家人", exact: true })
            .count(),
          0,
        );
      } finally {
        await flow.close();
      }
    },
  );
}
