import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base,
  pendingOrder,
  paidOrder,
  parameters,
  purchasePage,
  respond,
  timeout,
  tick,
} from "./purchase-fixture";
test("pending order restores by ID and continues the same payment after cancellation", async () => {
  const h = await purchasePage("order");
  h.page.onLoad({ id: pendingOrder.id });
  const load = h.page.onShow();
  respond(h.requests.shift()!, pendingOrder);
  await load;
  const paying = h.page.retryPayment();
  assert.equal(h.requests[0].url, `${base}/orders/${pendingOrder.id}/payment`);
  respond(h.requests.shift()!, {
    mode: "wechat",
    status: "prepared",
    parameters,
  });
  await tick();
  h.payments[0].fail?.({ errMsg: "requestPayment:fail cancel" });
  await tick();
  respond(h.requests.shift()!, pendingOrder);
  await paying;
  assert.equal(h.page.data.title, "待付款");
  assert.equal(h.page.data.activeOrder.id, pendingOrder.id);
});
test("unknown payment only queries the original order, then gift success opens recipient setup for that project", async () => {
  const h = await purchasePage("order");
  h.page.onLoad({
    id: pendingOrder.id,
    bookTitle: encodeURIComponent(pendingOrder.bookTitle),
  });
  const load = h.page.onShow();
  respond(h.requests.shift()!, { ...pendingOrder, paymentStatus: "unknown" });
  await load;
  await h.page.retryPayment();
  assert.equal(h.requests.length, 0);
  assert.equal(h.page.data.title, "确认付款结果");
  const query = h.page.restoreOrders();
  respond(h.requests.shift()!, paidOrder);
  await query;
  assert.equal(h.page.data.title, "购买成功");
  h.page.giftRecipient();
  assert.equal(
    h.routes[0],
    `/pages/gift-recipient/index?projectId=${paidOrder.project.id}`,
  );
});
test("self order restores into its book and an unavailable query keeps the prior title with a query action", async () => {
  const h = await purchasePage("order");
  h.page.onLoad({
    id: pendingOrder.id,
    bookTitle: encodeURIComponent(pendingOrder.bookTitle),
  });
  const load = h.page.onShow();
  timeout(h.requests.shift()!);
  await load;
  assert.equal(h.page.data.unknown, true);
  assert.equal(h.page.data.bookTitle, pendingOrder.bookTitle);
  const query = h.page.restoreOrders();
  respond(h.requests.shift()!, { ...paidOrder, purchaseKind: "self" });
  await query;
  assert.deepEqual(h.routes, ["/pages/home/index"]);
});
test("late order responses cannot navigate after the page is left", async () => {
  const h = await purchasePage("order");
  h.page.onLoad({ id: pendingOrder.id });
  const load = h.page.onShow();
  h.page.onHide();
  respond(h.requests.shift()!, { ...paidOrder, purchaseKind: "self" });
  await load;
  assert.equal(h.page.data.activeOrder, null);
  assert.equal(h.routes.length, 0);
});
