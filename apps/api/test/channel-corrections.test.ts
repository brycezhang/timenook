import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import {
  startBookFixture,
  stopBookFixture,
  app,
  config,
  login,
  request,
  data,
} from "./book-fixture";
import { authenticateFeishu, adminCookie } from "./admin-feishu-fixture";
import { verifiedPhone } from "./wechat-profile-fixture";
type Auth = { cookie: string; csrf: string };
let owner: Auth;
before(async () => {
  await startBookFixture();
  owner = await authenticateFeishu(config, app);
});
after(stopBookFixture);
const phone = (who: string) => verifiedPhone("synthetic-timenook", who);
const headers = (auth: Auth) => ({
  cookie: auth.cookie,
  origin: config.admin!.origin,
  "x-csrf-token": auth.csrf,
});
const admin = (
  method: "GET" | "POST",
  path: string,
  payload?: object,
  actor = owner,
) =>
  app.inject({
    method,
    url: "/v1/admin" + path,
    headers: { ...headers(actor), "idempotency-key": randomUUID() },
    ...(payload ? { payload } : {}),
  });
const create = async (who: string, actor = owner) =>
  data(
    await admin("POST", "/channel-gifts", { buyerPhone: phone(who) }, actor),
  );
const correct = (
  id: string,
  who: string,
  actor = owner,
  reason = "购买者号码录入错误",
) =>
  admin(
    "POST",
    `/channel-gifts/${id}/correct`,
    { buyerPhone: phone(who), reason },
    actor,
  );
const detail = async (id: string, actor = owner) =>
  data(await admin("GET", `/channel-gifts/${id}`, undefined, actor), 200);
const mine = async (token: string) =>
  data(await request("GET", "/v1/channel-gifts", token), 200);
const reminders = async (token: string) =>
  data(await request("GET", "/v1/channel-gifts/reminders", token), 200);
const activate = (id: string, token: string) =>
  request("POST", `/v1/channel-gifts/${id}/activate`, token, {
    purchaseKind: "self",
    recipient: { typeCode: "self", relationshipLabel: "自己" },
    bookTitle: "我的故事",
  });

test("correcting an unopened gift moves ownership, resets reminders and retains a reasoned operation in detail", async () => {
  const old = await login(),
    next = await login(),
    gift = await create(old.who);
  data(
    await request("POST", "/v1/channel-gifts/reminders/handle", old.token, {
      ids: [gift.id],
    }),
  );
  assert.equal((await reminders(old.token)).newCount, 0);
  assert.equal((await correct(gift.id, next.who, owner, " ")).statusCode, 400);
  data(await correct(gift.id, next.who));
  assert.deepEqual(await mine(old.token), []);
  assert.equal((await reminders(old.token)).pendingCount, 0);
  assert.equal((await activate(gift.id, old.token)).statusCode, 404);
  assert.equal((await mine(next.token))[0].id, gift.id);
  assert.equal((await reminders(next.token)).newCount, 1);
  const current = await detail(gift.id);
  assert.equal(current.buyerId, next.id);
  assert.equal(current.projectId, null);
  assert.equal(current.operations.length, 1);
  assert.equal(current.operations[0].reason, "购买者号码录入错误");
  assert.equal(current.operations[0].action, "correct");
  assert.equal(current.operations[0].beforePhone, "+86" + phone(old.who));
  assert.equal(current.operations[0].afterPhone, "+86" + phone(next.who));
  assert.ok(current.operations[0].operatorId);
  assert.ok(current.operations[0].createdAt);
});

test("unregistered correction is associated on verified login and void remains visible but cannot activate or remind", async () => {
  const old = await login(),
    future = randomUUID(),
    gift = await create(old.who);
  const changed = data(await correct(gift.id, future));
  assert.equal(changed.buyerId, null);
  assert.equal(changed.associatedAt, null);
  const buyer = await login(future);
  assert.equal((await mine(buyer.token))[0].id, gift.id);
  assert.equal((await reminders(buyer.token)).newCount, 1);
  assert.equal(
    (await admin("POST", `/channel-gifts/${gift.id}/void`, { reason: "" }))
      .statusCode,
    400,
  );
  const result = data(
    await admin("POST", `/channel-gifts/${gift.id}/void`, {
      reason: "重复录入",
    }),
  );
  assert.equal(result.state, "void");
  assert.equal(result.operations[1].action, "void");
  assert.equal(result.operations[1].reason, "重复录入");
  assert.equal((await mine(buyer.token))[0].state, "void");
  assert.deepEqual(await reminders(buyer.token), {
    newGiftIds: [],
    newCount: 0,
    pendingCount: 0,
  });
  assert.equal((await activate(gift.id, buyer.token)).statusCode, 409);
  assert.equal((await correct(gift.id, old.who)).statusCode, 409);
});

async function partner() {
  const credentials = data(await admin("POST", "/partners", {}));
  const bootstrap = await app.inject({
    method: "GET",
    url: "/v1/admin/session",
  });
  const initial = {
    cookie: adminCookie(bootstrap),
    csrf: bootstrap.json().data.csrfToken,
  };
  const response = await admin(
    "POST",
    "/partner/login",
    { username: credentials.username, password: credentials.password },
    initial,
  );
  assert.equal(response.statusCode, 200, response.body);
  return {
    id: credentials.id,
    cookie: adminCookie(response),
    csrf: response.json().data.csrfToken,
  };
}
test("partner correction and void are owner scoped and redacted; revocation rejects the existing session", async () => {
  const sales = await partner(),
    other = await partner(),
    buyer = await login(),
    next = await login();
  const gift = await create(buyer.who, sales),
    foreign = await create(buyer.who, other);
  for (const action of ["correct", "void"])
    assert.equal(
      (
        await admin(
          "POST",
          `/channel-gifts/${foreign.id}/${action}`,
          {
            reason: "错误",
            ...(action === "correct" ? { buyerPhone: phone(next.who) } : {}),
          },
          sales,
        )
      ).statusCode,
      404,
    );
  assert.equal(
    (await admin("GET", `/channel-gifts/${foreign.id}`, undefined, sales))
      .statusCode,
    404,
  );
  const result = data(await correct(gift.id, next.who, sales));
  assert.equal(result.buyerPhone, null);
  assert.equal(result.buyerId, null);
  assert.ok(!JSON.stringify(result).includes(phone(buyer.who)));
  assert.ok(!JSON.stringify(result).includes(phone(next.who)));
  assert.equal(
    (await correct(gift.id, buyer.who, { ...sales, csrf: "wrong" })).statusCode,
    403,
  );
  data(
    await admin(
      "POST",
      `/channel-gifts/${gift.id}/void`,
      { reason: "错误重复录入" },
      sales,
    ),
  );
  data(await correct(foreign.id, next.who)); // Super admin can handle another operator's record.
  assert.equal(
    (await admin("POST", `/partners/${sales.id}/revoke`, {})).statusCode,
    200,
  );
  for (const path of ["", `/${gift.id}`])
    assert.equal(
      (await admin("GET", `/channel-gifts${path}`, undefined, sales))
        .statusCode,
      401,
    );
  for (const action of ["correct", "void"])
    assert.equal(
      (
        await admin(
          "POST",
          `/channel-gifts/${gift.id}/${action}`,
          {
            reason: "错误",
            ...(action === "correct" ? { buyerPhone: phone(buyer.who) } : {}),
          },
          sales,
        )
      ).statusCode,
      401,
    );
  assert.equal(
    (
      await admin(
        "POST",
        "/channel-gifts",
        { buyerPhone: phone(buyer.who) },
        sales,
      )
    ).statusCode,
    401,
  );
  assert.equal((await detail(gift.id)).state, "void");
});

test("activation excludes correction and void; concurrent losers read back one authoritative result", async () => {
  for (const action of ["correct", "void"] as const) {
    const buyer = await login(),
      next = await login(),
      gift = await create(buyer.who);
    await mine(buyer.token); // Reading/opening the form leaves mutation available.
    const change = () =>
      action === "correct"
        ? correct(gift.id, next.who)
        : admin("POST", `/channel-gifts/${gift.id}/void`, {
            reason: "重复录入",
          });
    const [opened, changed] = await Promise.all([
      activate(gift.id, buyer.token),
      change(),
    ]);
    const current = await detail(gift.id);
    if (opened.statusCode === 201) {
      assert.equal(changed.statusCode, 409, changed.body);
      assert.equal(current.projectId, opened.json().data.projectId);
      assert.equal(current.buyerId, buyer.id);
      assert.equal(current.operations.length, 0);
      assert.equal((await change()).statusCode, 409);
      assert.equal(
        (
          await admin("POST", `/channel-gifts/${gift.id}/void`, {
            reason: "错误",
          })
        ).statusCode,
        409,
      );
      assert.equal((await correct(gift.id, next.who)).statusCode, 409);
      assert.equal(
        data(await request("GET", "/v1/participations", buyer.token), 200)
          .projects.length,
        1,
      );
    } else {
      assert.equal(changed.statusCode, 201, changed.body);
      assert.equal(
        opened.statusCode,
        action === "correct" ? 404 : 409,
        opened.body,
      );
      assert.equal(current.projectId, null);
      assert.equal(current.operations.length, 1);
      assert.equal(
        data(await request("GET", "/v1/participations", buyer.token), 200)
          .projects.length,
        0,
      );
      if (action === "correct") {
        const activated = data(await activate(gift.id, next.token));
        assert.equal(
          data(await activate(gift.id, next.token)).projectId,
          activated.projectId,
        );
      }
    }
  }
});

test("a confirmed book refuses both administrative changes, while correction racing registration finds its verified buyer", async () => {
  const buyer = await login(),
    gift = await create(buyer.who),
    future = randomUUID();
  const activated = data(await activate(gift.id, buyer.token));
  assert.equal((await correct(gift.id, future)).statusCode, 409);
  assert.equal(
    (await admin("POST", `/channel-gifts/${gift.id}/void`, { reason: "错误" }))
      .statusCode,
    409,
  );
  assert.equal((await detail(gift.id)).projectId, activated.projectId);
  const second = await create(buyer.who);
  const [corrected, newcomer] = await Promise.all([
    correct(second.id, future),
    login(future),
  ]);
  assert.equal(corrected.statusCode, 201, corrected.body);
  assert.equal((await detail(second.id)).buyerId, newcomer.id);
  assert.equal((await mine(newcomer.token))[0].id, second.id);
  assert.equal((await reminders(newcomer.token)).newCount, 1);
});
