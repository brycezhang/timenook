import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base,
  login,
  pendingOrder,
  paidOrder,
  parameters,
  offer,
  checkoutPage,
  purchasePage,
  respond,
  timeout,
  tick,
} from "./purchase-fixture";
test("checkout uses the loaded offer, submits required gift details without address, and native cancellation queries the original order", async () => {
  const h = await checkoutPage();
  assert.equal(h.page.data.packagePrice, "999.00");
  const paying = h.page.pay();
  assert.equal(h.requests[0].url, base + "/orders");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].data)), {
    packageVersionId: offer.version.id,
    purchaseKind: "gift",
    bookTitle: "妈妈的故事",
    recipient: { relationshipLabel: "妈妈" },
  });
  respond(h.requests.shift()!, pendingOrder);
  await tick();
  respond(h.requests.shift()!, {
    mode: "wechat",
    status: "prepared",
    parameters,
  });
  await tick();
  h.payments[0].fail?.({ errMsg: "requestPayment:fail cancel" });
  await tick();
  assert.equal(h.requests[0].url, base + "/orders/" + pendingOrder.id);
  respond(h.requests.shift()!, pendingOrder);
  await paying;
  assert.match(h.routes[0], /pages\/order\/index\?id=/);
  assert.equal(
    [...h.storage.keys()].some((k) => k.startsWith("timenook.live-project")),
    false,
  );
});
test("self payment enters the server-created book only after authoritative confirmation", async () => {
  const h = await checkoutPage(undefined, "self");
  const paying = h.page.pay();
  assert.equal((h.requests[0].data as any).purchaseKind, "self");
  assert.equal((h.requests[0].data as any).recipient.typeCode, "self");
  respond(h.requests.shift()!, { ...pendingOrder, purchaseKind: "self" });
  await tick();
  respond(h.requests.shift()!, {
    mode: "wechat",
    status: "prepared",
    parameters,
  });
  await tick();
  h.payments[0].success?.({ errMsg: "ok" });
  await tick();
  assert.equal(h.routes.length, 0);
  respond(h.requests.shift()!, { ...paidOrder, purchaseKind: "self" });
  await paying;
  assert.deepEqual(h.routes, ["/pages/home/index"]);
  assert.equal(
    [...h.storage.entries()].find(([k]) =>
      k.startsWith("timenook.live-project"),
    )?.[1],
    paidOrder.project.id,
  );
});
test("unknown create result survives re-entry and retries the exact command before querying that order", async () => {
  const h = await checkoutPage();
  const paying = h.page.pay(),
    first = h.requests.shift()!;
  timeout(first);
  await paying;
  const again = await checkoutPage(h.storage, "self");
  assert.equal(again.page.data.purchaseKind, "gift");
  const retry = again.page.pay(),
    request = again.requests.shift()!;
  assert.equal(
    request.header?.["Idempotency-Key"],
    first.header?.["Idempotency-Key"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(request.data)),
    JSON.parse(JSON.stringify(first.data)),
  );
  respond(request, pendingOrder);
  await tick();
  assert.equal(again.requests[0].method, "GET");
  respond(again.requests.shift()!, pendingOrder);
  await retry;
  assert.equal(again.payments.length, 0);
});
test("a confirmed order never occupies the next new purchase and the current book remains selected", async () => {
  const h = await checkoutPage();
  h.storage.set("timenook.live-project.v1:existing", "existing-project");
  const paying = h.page.pay();
  const first = h.requests.shift()!;
  respond(first, pendingOrder);
  await tick();
  respond(h.requests.shift()!, {
    mode: "wechat",
    status: "unknown",
    parameters: null,
  });
  await tick();
  respond(h.requests.shift()!, { ...pendingOrder, paymentStatus: "unknown" });
  await paying;
  const fresh = await checkoutPage(h.storage);
  const next = fresh.page.pay();
  const req = fresh.requests.shift()!;
  assert.equal(req.url, base + "/orders");
  assert.notEqual(
    req.header?.["Idempotency-Key"],
    first.header?.["Idempotency-Key"],
  );
  assert.equal(
    fresh.storage.get("timenook.live-project.v1:existing"),
    "existing-project",
  );
  timeout(req);
  await next;
});
test("account changes discard a late create result and keep the old account's unresolved intent", async () => {
  const h = await checkoutPage();
  const paying = h.page.pay();
  const req = h.requests.shift()!;
  h.storage.delete(`timenook.session.v1:${base}`);
  respond(req, pendingOrder);
  await paying;
  assert.equal(h.routes.length, 0);
  assert.equal(h.payments.length, 0);
  assert.ok(
    [...h.storage.keys()].find((k) =>
      k.startsWith("timenook.purchase-intent.v2"),
    ),
  );
});
test("checkout reloads the current catalog version and never creates an order from an unavailable offer", async () => {
  const h = await checkoutPage();
  h.page.onHide();
  const loading = h.page.onShow();
  respond(h.requests.shift()!, {
    purchasable: false,
    reason: "PACKAGE_PREPARING",
    checkout: null,
    version: null,
  });
  await loading;
  await h.page.pay();
  assert.equal(h.requests.length, 0);
  assert.match(h.page.data.error, /暂未开放/);
});
