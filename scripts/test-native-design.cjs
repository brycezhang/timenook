const { createRun } = require("./native-automation.cjs");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
(async () => {
  const run = await createRun("design");
  let failure;
  try {
    await run.start();
    await run.step(
      "unpaid homepage image and benefits fit above purchase dock",
      async () => {
        const rects = await run.evaluate(
          () =>
            new Promise((resolve) =>
              wx
                .createSelectorQuery()
                .select(".landing-hero")
                .boundingClientRect()
                .select(".benefits")
                .boundingClientRect()
                .select(".purchase-dock")
                .boundingClientRect()
                .exec(resolve),
            ),
        );
        assert.ok(rects[0].height <= 410);
        assert.ok(rects[1].bottom <= rects[2].top);
        await promisify(execFile)("wechatide", [
          "-c",
          "Codex",
          "simulator_screenshot",
          "--project",
          run.fixture,
          "--path",
          run.output + "/home.png",
          "--wait-for-selector",
          ".landing",
        ]);
      },
    );
    const id = "33333333-3333-4333-8333-333333333333",
      vid = "44444444-4444-4444-8444-444444444444",
      sid = "55555555-5555-4555-8555-555555555555";
    const book = {
      projectId: id,
      inputHash: "a".repeat(64),
      cover: { version: 0, salutation: "", photoAssetId: null },
      coverPhotoOptions: [],
      directory: {
        version: 1,
        chapters: [
          { key: "childhood", title: "童年的日子", storyRefs: [] },
          { key: "growing", title: "慢慢长大", storyRefs: [] },
        ],
      },
      eligibleStories: [{ id: sid, title: "老屋门前的那棵树" }],
      current: null,
      accessExpiresAt: null,
      draftAccess: { allowed: true, expiresAt: null },
    };
    const overview = {
      projectId: id,
      bookTitle: "妈妈的一生",
      metadataVersion: 1,
      canInvite: true,
      canRecord: true,
      canDecide: true,
      stories: [],
      interviews: [],
      tasks: [],
      summary: {},
      nextStep: "record",
    };
    await run.evaluate(
      function (fixtures) {
        wx.request = function (options) {
          const path = options.url.split("/v1")[1];
          let data;
          let statusCode = 200;
          if (path === "/users/me")
            data = { id: "11111111-1111-4111-8111-111111111111" };
          else if (path === "/participations")
            data = {
              projects: [
                {
                  projectId: fixtures.id,
                  bookTitle: fixtures.overview.bookTitle,
                  origin: "purchased",
                  state: "active",
                },
              ],
            };
          else if (path.endsWith("/overview")) data = fixtures.overview;
          else if (path.endsWith("/participation"))
            data = { canRead: true, accessEpoch: 0 };
          else if (path.endsWith("/book")) data = fixtures.book;
          else if (path.endsWith("/book/directory")) {
            fixtures.book.directory = {
              version: fixtures.book.directory.version + 1,
              chapters: options.data.chapters,
            };
            data = fixtures.book;
          } else if (path.endsWith("/book/cover")) {
            fixtures.book.cover = {
              ...options.data,
              version: fixtures.book.cover.version + 1,
            };
            data = fixtures.book;
          } else if (path === "/orders") data = { orders: [] };
          else {
            statusCode = 404;
            data = {};
          }
          setTimeout(
            () =>
              options.success({
                statusCode,
                data:
                  statusCode === 200
                    ? {
                        data: JSON.parse(JSON.stringify(data)),
                        meta: { requestId: "ui-fixture" },
                      }
                    : {
                        error: { code: "NOT_FOUND" },
                        meta: { requestId: "ui-fixture" },
                      },
              }),
            0,
          );
          return { abort() {} };
        };
      },
      { id, book, overview },
    );
    await run.evaluate(() => {
      wx.setStorageSync(
        "timenook.session.v1:https://timenookapi.threeminreading.com/api/v1",
        {
          user: { id: "11111111-1111-4111-8111-111111111111" },
          session: {
            id: "22222222-2222-4222-8222-222222222222",
            token: "a".repeat(43),
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
      );
    });
    await run.step("paid home shows current project", async () => {
      await run.call("refresh");
      const p = await run.page("home", (d) => !!d.overview);
      assert.equal(p.overview.bookTitle, "妈妈的一生");
    });
    await run.step("home project switch responds to a native tap", async () => {
      const p = await run.mp.currentPage();
      await (await p.$(".project-heading .s-link")).tap();
      await run.page("projects", (d) => d.rows.length === 1);
      const projects = await run.mp.currentPage();
      await (await projects.$(".s-card")).tap();
      await run.page("home", (d) => d.overview?.projectId === id);
    });
    await run.step(
      "book directory opens directly editable chapter",
      async () => {
        await run.navigate(
          "navigateTo",
          "/pages/directory/index?projectId=" + id,
        );
        await run.page("directory", (d) => d.rows.length === 2);
        await promisify(execFile)("wechatide", [
          "-c",
          "Codex",
          "simulator_screenshot",
          "--project",
          run.fixture,
          "--path",
          run.output + "/directory.png",
          "--wait-for-selector",
          ".s-page",
        ]);
        const p = await run.mp.currentPage();
        const list = await p.$("#chapters");
        assert.ok(list);
        const handles = await list.$$(".sort-handle");
        assert.equal(handles.length, 2);
        const rects = await run.evaluate(
          () =>
            new Promise((resolve) =>
              getCurrentPages()
                .slice(-1)[0]
                .selectComponent("#chapters")
                .createSelectorQuery()
                .selectAll(".sort-row")
                .boundingClientRect(resolve)
                .exec(),
            ),
        );
        await handles[0].touchstart({
          touches: [
            {
              identifier: 0,
              clientX: 330,
              clientY: (rects[0].top + rects[0].bottom) / 2,
            },
          ],
        });
        await handles[0].touchmove({
          touches: [
            {
              identifier: 0,
              clientX: 330,
              clientY: (rects[1].top + rects[1].bottom) / 2,
            },
          ],
        });
        await handles[0].touchend({ touches: [] });
        await run.page("directory", (d) => d.rows[0].id === "growing");
        const rows = await list.$$(".sort-content");
        await rows[1].tap();
        await run.page("chapter");
        const chapter = await run.mp.currentPage();
        assert.ok(await chapter.$("input"));
        assert.equal((await chapter.data()).title, "童年的日子");
      },
    );
    await run.step(
      "story selection separates selected and available",
      async () => {
        await run.call("choose");
        let p = await run.page("chapter-stories");
        assert.equal(p.available.length, 1);
        await run.call("add", { currentTarget: { dataset: { id: sid } } });
        p = await run.page("chapter-stories", (d) => d.selected.length === 1);
        assert.equal(p.available.length, 0);
      },
    );
    await run.step("cover and independent photo selection", async () => {
      await run.navigate("navigateTo", "/pages/cover/index?projectId=" + id);
      await run.page("cover", (d) => d.title === "妈妈的一生");
      await run.call("choose");
      await run.page("cover-photos");
    });
    await run.step("terms exposes native WeChat customer service", async () => {
      await run.navigate("navigateTo", "/pages/terms/index");
      await run.page("terms");
      const p = await run.mp.currentPage();
      assert.ok(await p.$('button[open-type="contact"]'));
    });
    await run.step("personal page is second native tab", async () => {
      await run.navigate("switchTab", "/pages/account/index");
      const p = await run.page("account", (d) => d.loggedIn);
      assert.equal(p.loggedIn, true);
    });
  } catch (e) {
    failure = e;
    console.error(e.message);
  }
  await run.finish(failure);
  process.exitCode = failure ? 1 : 0;
})();
