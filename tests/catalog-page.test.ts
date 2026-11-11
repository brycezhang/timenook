import assert from "node:assert/strict";
import { test } from "node:test";
import { purchasePage, login, base } from "./purchase-fixture";
const choose = (relationship: string) => ({
  currentTarget: { dataset: { relationship } },
});
const input = (field: string, value: string) => ({
  currentTarget: { dataset: { field } },
  detail: { value },
});
test("unified new gift requires relationship and title and self selection keeps an explicitly edited title", async () => {
  const h = await purchasePage("new-book");
  h.page.next();
  assert.match(h.page.data.error, /关系/);
  assert.equal(h.routes.length, 0);
  h.page.chooseRelationship(choose("妈妈"));
  assert.equal(h.page.data.bookTitle, "妈妈的故事");
  h.page.input(input("bookTitle", "我的远行 & 归来"));
  h.page.chooseRelationship(choose("自己"));
  h.page.next();
  const route = new URL(h.routes[0], "https://example.test");
  assert.equal(route.pathname, "/pages/purchase/index");
  assert.equal(route.searchParams.get("bookTitle"), "我的远行 & 归来");
  assert.equal(route.searchParams.get("purchaseKind"), "self");
  assert.equal(route.searchParams.get("relationship"), "自己");
  assert.equal(h.requests.length, 0);
});
test("custom relationship stays a gift even when its display name is self", async () => {
  const h = await purchasePage("new-book");
  h.page.chooseRelationship(choose("自定义"));
  h.page.next();
  assert.match(h.page.data.error, /关系/);
  h.page.input(input("customRelationship", "自己"));
  h.page.next();
  assert.match(h.routes[0], /purchaseKind=gift/);
});
test("direct purchase login stays on the draft and resumes only after the common login succeeds", async () => {
  const h = await purchasePage("new-book", new Map());
  h.page.chooseRelationship(choose("爷爷"));
  h.page.input(input("bookTitle", "爷爷的纸船"));
  h.page.next();
  assert.equal(h.page.data.loginVisible, true);
  assert.equal(h.routes.length, 0);
  h.page.closeLogin();
  assert.equal(h.page.data.bookTitle, "爷爷的纸船");
  h.page.next();
  h.storage.set(`timenook.session.v1:${base}`, login);
  h.page.loginSucceeded();
  assert.equal(
    new URL(h.routes[0], "https://example.test").searchParams.get("bookTitle"),
    "爷爷的纸船",
  );
});
