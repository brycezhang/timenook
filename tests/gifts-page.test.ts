import assert from "node:assert/strict";
import { test } from "node:test";
import { base, login, purchasePage, respond, tick } from "./purchase-fixture";

const projectId = "55555555-5555-4555-8555-555555555555";
const token = "g".repeat(43);
const gift = {
  state: "unclaimed",
  bookTitle: "爸爸的时光故事",
  recipientName: "爸爸",
  maskedPhone: "138****0628",
};
const owned = {
  ...gift,
  projectId,
  recipientPhone: "13800000628",
  version: 1,
  token,
};
const setup = {
  projectId,
  bookTitle: gift.bookTitle,
  recipientName: "爸爸",
  gift: owned,
};

test("gift setup validates input, generates the real card, and share links open the current recipient token", async () => {
  const h = await purchasePage("gift-recipient");
  h.page.onLoad({ projectId });
  const loading = h.page.onShow();
  respond(h.requests.shift()!, { ...setup, gift: null });
  await loading;
  await h.page.save();
  assert.match(h.page.data.status, /11 位/);
  assert.equal(h.requests.length, 0);
  h.page.setPhone({ detail: { value: "13800000628" } });
  const saving = h.page.save();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].data)), {
    recipientName: "爸爸",
    recipientPhone: "13800000628",
  });
  respond(h.requests.shift()!, owned);
  await saving;
  assert.deepEqual(h.routes, [
    `/pages/gift-share/index?projectId=${projectId}`,
  ]);
  const share = await purchasePage("gift-share", h.storage);
  share.page.onLoad({ projectId });
  const reload = share.page.onShow();
  respond(share.requests.shift()!, setup);
  await reload;
  assert.equal(
    share.page.onShareAppMessage().path,
    `/pages/gift-claim/index?token=${token}`,
  );
  share.page.edit();
  assert.equal(
    share.routes[0],
    `/pages/gift-recipient/index?projectId=${projectId}`,
  );
  share.page.project();
  assert.equal(share.routes[1], "/pages/home/index");
});

test("anonymous gift verification stays in place and successful login never accepts without a separate tap", async () => {
  const h = await purchasePage("gift-claim", new Map());
  h.page.onLoad({ token });
  const loading = h.page.onShow();
  respond(h.requests.shift()!, gift);
  await loading;
  await h.page.verify();
  assert.equal(h.page.data.screen, "verify");
  assert.equal(h.requests.length, 0);
  h.page.closeLogin();
  assert.equal(h.page.data.screen, "open");
  await h.page.verify();
  h.storage.set(`timenook.session.v1:${base}`, login);
  const verification = h.page.loginSucceeded();
  assert.equal(h.requests[0].url, `${base}/gifts/${token}/verification`);
  respond(h.requests.shift()!, {
    state: "ready",
    gift,
    currentMaskedPhone: gift.maskedPhone,
  });
  await verification;
  assert.equal(h.page.data.screen, "accept");
  assert.equal(h.requests.length, 0);
  assert.equal(h.routes.length, 0);
  const claim = h.page.accept();
  assert.equal(h.requests[0].url, `${base}/gifts/${token}/claim`);
  respond(h.requests.shift()!, { projectId, state: "claimed" });
  await claim;
  assert.equal(h.page.data.screen, "claimed");
  assert.equal(h.routes.length, 0);
  h.page.project();
  assert.deepEqual(h.routes, ["/pages/home/index"]);
  assert.equal(
    [...h.storage.entries()].find(([key]) =>
      key.startsWith("timenook.live-project"),
    )?.[1],
    projectId,
  );
});

test("wrong phone cannot claim, switching account returns to verification, and old cards show invalid", async () => {
  const h = await purchasePage("gift-claim");
  h.page.onLoad({ token });
  const loading = h.page.onShow();
  respond(h.requests.shift()!, gift);
  await loading;
  const checking = h.page.verify();
  respond(h.requests.shift()!, {
    state: "mismatch",
    gift,
    currentMaskedPhone: "137****0916",
  });
  await checking;
  assert.equal(h.page.data.screen, "mismatch");
  await h.page.accept();
  assert.equal(h.requests.length, 0);
  const switching = h.page.switchAccount();
  respond(h.requests.shift()!, null);
  await switching;
  assert.equal(h.page.data.screen, "verify");
  assert.equal(h.page.data.currentMaskedPhone, "");
  const reread = h.page.onShow();
  h.requests
    .shift()!
    .success?.({
      statusCode: 404,
      data: { error: { code: "NOT_FOUND" }, meta: {} },
      header: {},
      cookies: [],
      errMsg: "ok",
    } as any);
  await reread;
  assert.equal(h.page.data.screen, "invalid");
  assert.equal(h.page.data.gift, null);
  assert.equal(h.page.data.projectId, "");
});

test("a claimed card reopens the same book for its owner and a changed account cannot receive a late claim result", async () => {
  const h = await purchasePage("gift-claim");
  h.page.onLoad({ token });
  const loading = h.page.onShow();
  respond(h.requests.shift()!, { ...gift, state: "claimed" });
  await tick();
  respond(h.requests.shift()!, {
    state: "claimed",
    gift: { ...gift, state: "claimed" },
    currentMaskedPhone: gift.maskedPhone,
    projectId,
  });
  await loading;
  h.page.project();
  assert.deepEqual(h.routes, ["/pages/home/index"]);
  h.page.showVerification({
    state: "ready",
    gift,
    currentMaskedPhone: gift.maskedPhone,
  });
  const accepting = h.page.accept();
  h.storage.delete(`timenook.session.v1:${base}`);
  respond(h.requests.shift()!, { projectId, state: "claimed" });
  await accepting;
  assert.equal(h.page.data.projectId, "");
  assert.equal(h.page.data.screen, "accept");
});
