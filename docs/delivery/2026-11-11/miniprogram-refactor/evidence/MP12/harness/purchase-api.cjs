// MP02/03 loopback API extracted from the MP03 native harness. Only external
// identity/payment outcomes are synthetic; no business HTTP or DB state mocks.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const root = path.resolve(process.env.TIMENOOK_REPO || process.cwd());
const port = Number(process.env.TIMENOOK_MP12_PURCHASE_PORT || 3429);
const directory = path.join(root, "test-results/mp12-purchase-native");
const output = path.join(directory, "fixture.json");
const providerCommandFile = path.join(directory, "provider-command.json");
const f = require(root + "/apps/api/dist-test/test/book-fixture.js");
const pay = require(root + "/apps/api/dist-test/test/payment-fixture.js");
const { verifiedPhone, phoneLogin } = require(
  root + "/apps/api/dist-test/test/wechat-profile-fixture.js",
);
const { paymentAdmin } = require(
  root + "/apps/api/dist-test/test/payment-admin-fixture.js",
);
let started = false,
  published = false,
  closing = false,
  timer,
  working = false,
  work = Promise.resolve();
const autoActors = new Set();
const settled = new Set();
const request = (
  method,
  route,
  actor,
  body,
  status = method === "GET" ? 200 : 201,
) =>
  f.request(method, route, actor?.token, body).then((r) => f.data(r, status));
function writePrivate(file, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await work.catch(() => {});
  if (started) await f.stopBookFixture();
  if (published)
    for (const file of [output, providerCommandFile]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  process.exit(code);
}
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
async function settle(outTradeNo) {
  assert.ok(
    pay.supplierOrders.has(outTradeNo),
    "Unknown synthetic provider order",
  );
  const event = await pay.callback(pay.paid(outTradeNo));
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/webhooks/wechat-pay/payments",
    headers: { ...event.headers, "content-type": "application/json" },
    payload: event.body,
  });
  assert.equal(r.statusCode, 204);
  settled.add(outTradeNo);
}
function orderScene(actor, order) {
  return {
    actorCode: actor.who,
    orderId: order.id,
    outTradeNo: order.outTradeNo,
    projectId: order.project?.id ?? null,
    state: order.state,
    paymentStatus: order.paymentStatus,
    path: `pages/order/index?id=${order.id}`,
  };
}
async function main() {
  for (const key of ["DATABASE_URL", "REDIS_URL"])
    assert.ok(
      ["localhost", "127.0.0.1"].includes(new URL(process.env[key]).hostname),
      "Expected loopback services",
    );
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  process.chdir(path.join(root, "apps/api"));
  started = true;
  await f.startBookFixture();
  // Ordinary-merchant exercises the native protocol and catalog gates. All keys,
  // signatures, merchant transport and admission data are isolated test fixtures.
  f.config.payments.mode = "ordinary-merchant";
  const headers = await paymentAdmin(f.config, f.app, [
    "catalog:write",
    "catalog:freeze",
  ]);
  const admin = async (url, payload) =>
    f.data(
      await f.app.inject({
        method: "POST",
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload,
      }),
    );
  const snapshot = JSON.parse(
    fs.readFileSync("test/fixtures/catalog-synthetic.json", "utf8"),
  );
  const draft = await admin("/v1/admin/catalog/package-drafts", {
    ...snapshot,
    title: "时光故事",
  });
  const version = await admin(
    `/v1/admin/catalog/package-drafts/${draft.id}/publish`,
    {
      expectedRevision: draft.revision,
      confirmRealParameters: true,
    },
  );
  const offer = await request("GET", "/v1/packages/current");
  assert.equal(offer.purchasable, true);
  assert.equal(offer.version.id, version.id);
  const create = async (actor, title, kind = "gift") =>
    request("POST", "/v1/orders", actor, {
      packageVersionId: version.id,
      purchaseKind: kind,
      bookTitle: title,
      recipient:
        kind === "self"
          ? { typeCode: "self", relationshipLabel: "自己" }
          : { relationshipLabel: "爸爸" },
    });
  const prepare = async (actor, order) => {
    const result = await request(
      "POST",
      `/v1/orders/${order.id}/payment`,
      actor,
      {},
    );
    assert.equal(result.mode, "wechat");
    pay.verifyMini(result.parameters);
  };
  const paidOrder = async (actor, title) => {
    const order = await create(actor, title);
    await prepare(actor, order);
    await settle(order.outTradeNo);
    return request("GET", `/v1/orders/${order.id}`, actor);
  };
  const scenes = {};
  for (const width of [390, 320]) {
    const buyer = await f.login(),
      recipient = await f.login(),
      wrong = await f.login();
    const interactive = await f.login();
    autoActors.add(interactive.who);
    const pending = await create(buyer, "爸爸的时光故事");
    await prepare(buyer, pending);
    const unknown = await create(buyer, "等待确认付款的时光故事");
    await prepare(buyer, unknown);
    pay.supplierOrders.get(unknown.outTradeNo).trade_state = "USERPAYING";
    const unknownView = await request("GET", `/v1/orders/${unknown.id}`, buyer);
    assert.equal(unknownView.paymentStatus, "unknown");
    const ready = await paidOrder(buyer, "爸爸的时光故事");
    const recipientPhone = verifiedPhone("synthetic-timenook", recipient.who);
    const editable = await paidOrder(buyer, "送给爸爸的时光故事");
    const open = await paidOrder(buyer, "爸爸的时光故事");
    const giftBase = `/v1/projects/${open.project.id}/gift`;
    const old = await request("POST", giftBase, buyer, {
      recipientName: "爸爸",
      recipientPhone: verifiedPhone("synthetic-timenook", wrong.who),
    });
    const gift = await request("POST", giftBase, buyer, {
      recipientName: "爸爸",
      recipientPhone,
    });
    assert.equal(
      (await f.request("GET", `/v1/gifts/${old.token}`)).statusCode,
      404,
    );
    assert.equal(
      (await request("GET", `/v1/gifts/${gift.token}/verification`, wrong))
        .state,
      "mismatch",
    );
    assert.equal(
      (await request("GET", `/v1/gifts/${gift.token}/verification`, recipient))
        .state,
      "ready",
    );
    assert.equal(
      (
        await f.request(
          "GET",
          `/v1/projects/${open.project.id}/overview`,
          recipient.token,
        )
      ).statusCode,
      403,
    );
    const claimedOrder = await paidOrder(buyer, "已经收到的时光故事");
    const claimedGift = await request(
      "POST",
      `/v1/projects/${claimedOrder.project.id}/gift`,
      buyer,
      { recipientName: "爸爸", recipientPhone },
    );
    const claim = () =>
      request("POST", `/v1/gifts/${claimedGift.token}/claim`, recipient, {
        termsVersion: phoneLogin().termsVersion,
      });
    const first = await claim(),
      replay = await claim();
    assert.equal(first.projectId, claimedOrder.project.id);
    assert.equal(replay.projectId, first.projectId);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/gifts/${claimedGift.token}/verification`,
          recipient,
        )
      ).state,
      "claimed",
    );
    scenes[width] = {
      purchase: {
        actorCode: buyer.who,
        interactiveActorCode: interactive.who,
        newGiftPath: "pages/new-book/index",
        selfGiftPath: "pages/new-book/index",
        checkoutPath:
          "pages/purchase/index?bookTitle=" +
          encodeURIComponent("爸爸的时光故事") +
          "&relationship=" +
          encodeURIComponent("爸爸") +
          "&purchaseKind=gift",
        selfCheckoutPath:
          "pages/purchase/index?bookTitle=" +
          encodeURIComponent("我的时光故事") +
          "&relationship=" +
          encodeURIComponent("自己") +
          "&purchaseKind=self",
        pending: orderScene(
          buyer,
          await request("GET", `/v1/orders/${pending.id}`, buyer),
        ),
        unknown: orderScene(buyer, unknownView),
        ready: orderScene(buyer, ready),
      },
      gift: {
        buyerCode: buyer.who,
        recipientCode: recipient.who,
        wrongCode: wrong.who,
        recipientPhone,
        recipientName: "爸爸",
        projectId: open.project.id,
        recipientPath: `pages/gift-recipient/index?projectId=${editable.project.id}`,
        sharePath: `pages/gift-share/index?projectId=${open.project.id}`,
        openPath: `pages/gift-claim/index?token=${gift.token}`,
        invalidPath: `pages/gift-claim/index?token=${old.token}`,
        claimedPath: `pages/gift-claim/index?token=${claimedGift.token}`,
        claimedProjectId: claimedOrder.project.id,
      },
    };
  }
  // Only the designated interactive identities settle automatically. A normal
  // native cancellation stays NOTPAY. The optional private command file changes
  // the synthetic provider outcome; business reconciliation stays in the API.
  timer = setInterval(() => {
    if (working || closing) return;
    working = true;
    work = (async () => {
      for (const [no, order] of pay.supplierOrders)
        if (
          !settled.has(no) &&
          autoActors.has(order.payer?.openid) &&
          order.trade_state === "NOTPAY"
        )
          await settle(no);
      if (fs.existsSync(providerCommandFile)) {
        const command = JSON.parse(
          fs.readFileSync(providerCommandFile, "utf8"),
        );
        assert.equal(command.action, "settle");
        await settle(command.outTradeNo);
        fs.unlinkSync(providerCommandFile);
      }
    })()
      .catch((error) =>
        writePrivate(path.join(directory, "provider-error.json"), {
          name: error.name,
          message: error.message,
        }),
      )
      .finally(() => {
        working = false;
      });
  }, 500);
  await f.app.listen({ host: "127.0.0.1", port });
  writePrivate(output, {
    apiBase: `http://127.0.0.1:${port}/v1`,
    pid: process.pid,
    packageVersionId: version.id,
    providerCommandFile,
    scenes,
    evidenceBoundary:
      "Real local API/PostgreSQL/Redis and signed payment callback processing. Identity, merchant transport, payment result and admission parameters are synthetic. No real charge or platform acceptance.",
  });
  published = true;
  console.log(
    `MP02/03 isolated API ready at loopback:${port}; private fixture manifest saved outside Git.`,
  );
}
main().catch(async (error) => {
  console.error(
    `MP02/03 fixture setup failed (${error.code || error.name}); details saved privately.`,
  );
  writePrivate(path.join(directory, "setup-error.json"), {
    stack: String(error.stack || error),
  });
  await cleanup(1);
});
