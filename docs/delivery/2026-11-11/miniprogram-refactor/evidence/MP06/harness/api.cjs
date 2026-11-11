// Isolated local API for native MP06 verification. Identity, payments and audio/AI
// suppliers use fixtures; projects, questions, relations and saved stories use API commands.
const { randomUUID } = require("node:crypto");
const { mkdirSync, writeFileSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const root = process.env.TIMENOOK_REPO || process.cwd();
const port = Number(process.env.TIMENOOK_MP06_PORT || 3426);
const output =
  process.env.TIMENOOK_MP06_FIXTURE ||
  path.join(root, "test-results/mp06-native/fixture.json");
const f = require(root + "/apps/api/dist-test/test/book-fixture.js");
(async () => {
  for (const key of ["DATABASE_URL", "REDIS_URL"])
    if (
      !["localhost", "127.0.0.1"].includes(new URL(process.env[key]).hostname)
    )
      throw Error("Expected loopback services");
  process.chdir(path.join(root, "apps/api"));
  await f.startBookFixture();
  const empty = await f.joinedProject();
  const active = await f.joinedProject();
  for (const p of [empty, active]) {
    f.data(
      await f.request("POST", "/v1/users/me/profile", p.buyer.token, {
        nickname: "小陈",
      }),
    );
    f.data(
      await f.request("POST", "/v1/users/me/profile", p.narrator.token, {
        nickname: "小林",
      }),
    );
    const overview = f.data(
      await f.request(
        "GET",
        `/v1/projects/${p.projectId}/overview`,
        p.buyer.token,
      ),
      200,
    );
    f.data(
      await f.request(
        "POST",
        `/v1/projects/${p.projectId}/metadata`,
        p.buyer.token,
        {
          expectedVersion: overview.metadataVersion,
          bookTitle: "爸爸的时光故事",
        },
      ),
    );
  }
  const base = `/v1/projects/${active.projectId}`;
  f.data(
    await f.request("POST", `${base}/member-profile`, active.buyer.token, {
      relationship: "女儿",
    }),
  );
  const ask = (text, chapterKey = null) =>
    f
      .request("POST", `${base}/family-questions`, active.buyer.token, {
        clientQuestionId: randomUUID(),
        text,
        chapterKey,
      })
      .then((r) => f.data(r));
  const answered = await ask(
    "你第一次离开家去工作，是什么样的心情？",
    "society",
  );
  const saved = await f.readyStory(active, { familyQuestionId: answered.id });
  const chapterQuestion = await ask(
    "小时候，爷爷奶奶最常对你说的一句话是什么？",
    "childhood",
  );
  const unassigned = await ask(
    "有没有一个一直想告诉我们，却还没来得及讲的故事？",
  );
  const later = await ask("你最喜欢家里人做的哪一道菜？");
  f.data(
    await f.request(
      "POST",
      `${base}/family-questions/${later.id}/state`,
      active.narrator.token,
      { expectedVersion: later.version, state: "later" },
    ),
  );
  const skipped = await ask("有什么想留到以后再说的话？");
  f.data(
    await f.request(
      "POST",
      `${base}/family-questions/${skipped.id}/state`,
      active.narrator.token,
      { expectedVersion: skipped.version, state: "skipped" },
    ),
  );
  const photo = await f.projectPhoto(active);
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(
    output,
    JSON.stringify({
      apiBase: `http://127.0.0.1:${port}/v1`,
      empty: { projectId: empty.projectId, actorCode: empty.buyer.who },
      active: {
        projectId: active.projectId,
        actorCode: active.narrator.who,
        authorCode: active.buyer.who,
        chapterQuestionId: chapterQuestion.id,
        unassignedQuestionId: unassigned.id,
        answeredQuestionId: answered.id,
        storyId: saved.story.id,
        photoId: photo.id,
      },
    }),
    { mode: 0o600 },
  );
  await f.app.listen({ host: "127.0.0.1", port });
  console.log(
    `MP06 isolated API ready at loopback:${port}; private fixture saved outside Git.`,
  );
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    await f.stopBookFixture();
    try {
      unlinkSync(output);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
})().catch(async (error) => {
  console.error(error.message);
  await f.stopBookFixture().catch(() => {});
  process.exit(1);
});
