// Run from repository root after API test compilation. Only loopback services.
// WeChat identity/payment are external fixtures; all project/invitation data uses real API commands.
const { randomUUID } = require("node:crypto");
const { writeFileSync, mkdirSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const root = process.env.TIMENOOK_REPO || process.cwd();
const port = Number(process.env.TIMENOOK_MP04_PORT || 3424);
const fixturePath =
  process.env.TIMENOOK_MP04_FIXTURE ||
  path.join(root, "test-results/mp04-native/fixture.json");
const books = require(root + "/apps/api/dist-test/test/book-fixture.js");
const { callback, paid } = require(
  root + "/apps/api/dist-test/test/payment-fixture.js",
);
const { verifiedPhone } = require(
  root + "/apps/api/dist-test/test/wechat-profile-fixture.js",
);
const { USER_TERMS_VERSION } = require(
  root + "/packages/contracts/dist/index.js",
);
(async () => {
  for (const key of ["DATABASE_URL", "REDIS_URL"])
    if (
      !["127.0.0.1", "localhost"].includes(new URL(process.env[key]).hostname)
    )
      throw Error("Expected loopback services");
  process.chdir(path.join(root, "apps/api"));
  await books.startBookFixture();
  const actor = await books.login("mp04-owner-" + randomUUID());
  const receiver = await books.login("mp04-recipient-" + randomUUID());
  const giver = await books.login("mp04-giver-" + randomUUID());
  const guest = await books.login("mp04-guest-" + randomUUID());
  for (const [user, nickname] of [
    [actor, "小陈"],
    [giver, "小雨"],
    [receiver, "爸爸"],
    [guest, "小林"],
  ])
    books.data(
      await books.request("POST", "/v1/users/me/profile", user.token, {
        nickname,
      }),
    );
  const source = await books.db.packageVersion.findFirstOrThrow();
  async function order(user, title, kind, relation, complete = true) {
    const order = books.data(
      await books.request("POST", "/v1/orders", user.token, {
        packageVersionId: source.id,
        purchaseKind: kind,
        bookTitle: title,
        recipient: {
          typeCode: kind === "self" ? "self" : "mentor",
          relationshipLabel: relation,
        },
      }),
    );
    if (!complete) return order;
    books.data(
      await books.request("POST", `/v1/orders/${order.id}/payment`, user.token),
    );
    const event = await callback(paid(order.outTradeNo));
    const response = await books.app.inject({
      method: "POST",
      url: "/v1/webhooks/wechat-pay/payments",
      headers: { ...event.headers, "content-type": "application/json" },
      payload: event.body,
    });
    if (response.statusCode !== 204) throw Error("Fixture payment failed");
    return books.data(
      await books.request("GET", `/v1/orders/${order.id}`, user.token),
      200,
    );
  }
  async function gift(order, from, to, name) {
    const issued = books.data(
      await books.request(
        "POST",
        `/v1/projects/${order.project.id}/gift`,
        from.token,
        {
          recipientName: name,
          recipientPhone: verifiedPhone("synthetic-timenook", to.who),
        },
      ),
    );
    books.data(
      await books.request("POST", `/v1/gifts/${issued.token}/claim`, to.token, {
        termsVersion: USER_TERMS_VERSION,
      }),
    );
  }
  const sent = await order(actor, "爸爸的故事", "gift", "爸爸");
  await gift(sent, actor, receiver, "爸爸");
  const self = await order(actor, "我的故事", "self", "自己");
  const received = await order(giver, "我的时光故事", "gift", "爷爷");
  await gift(received, giver, actor, "爷爷");
  const participating = await order(giver, "妈妈的故事", "gift", "妈妈");
  const family = books.data(
    await books.request(
      "POST",
      `/v1/projects/${participating.project.id}/invitations`,
      giver.token,
    ),
  );
  books.data(
    await books.request(
      "POST",
      `/v1/invitations/${family.token}/accept`,
      actor.token,
      { termsVersion: USER_TERMS_VERSION, relationship: "女儿" },
    ),
  );
  const pending = await order(actor, "给妈妈的时光书", "gift", "妈妈", false);
  const join = books.data(
    await books.request(
      "POST",
      `/v1/projects/${sent.project.id}/invitations`,
      actor.token,
    ),
  );
  mkdirSync(path.dirname(fixturePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    fixturePath,
    JSON.stringify({
      apiBase: `http://127.0.0.1:${port}/v1`,
      actorCode: actor.who,
      guestCode: guest.who,
      projectId: sent.project.id,
      selfProjectId: self.project.id,
      pendingOrderId: pending.id,
      invitationToken: join.token,
    }),
    { mode: 0o600 },
  );
  await books.app.listen({ host: "127.0.0.1", port });
  console.log(
    `MP04 isolated API ready at loopback:${port}; fixture saved outside Git.`,
  );
  let closing = false;
  async function cleanup() {
    if (closing) return;
    closing = true;
    await books.stopBookFixture();
    try {
      unlinkSync(fixturePath);
    } catch {}
    process.exit(0);
  }
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
})().catch(async (error) => {
  console.error(error.message);
  await books.stopBookFixture().catch(() => {});
  process.exit(1);
});
