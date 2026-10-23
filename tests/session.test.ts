import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SessionClient } from "../miniprogram/services/session";
import { list, start } from "../miniprogram/services/store";

const api = "https://example.test/timenook/v1";
const identity = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
let storage: Map<string, unknown>;
let requests: WechatMiniprogram.RequestOption[];
let downloads: WechatMiniprogram.DownloadFileOption[];
let failSessionRemoval: boolean;
let reply: (request: WechatMiniprogram.RequestOption) => void;
const envelope = (data: unknown) => ({
  data,
  meta: { requestId: "33333333-3333-4333-8333-333333333333" },
});
function success(
  request: WechatMiniprogram.RequestOption,
  statusCode: number,
  data: unknown,
) {
  request.success?.({
    statusCode,
    data: data as WechatMiniprogram.RequestSuccessCallbackResult["data"],
    header: {},
    cookies: [],
    errMsg: "request:ok",
  } as unknown as WechatMiniprogram.RequestSuccessCallbackResult);
}
function downloadSuccess(
  options: WechatMiniprogram.DownloadFileOption,
  result: Pick<
    WechatMiniprogram.DownloadFileSuccessCallbackResult,
    "statusCode" | "tempFilePath" | "errMsg"
  >,
) {
  // Device network telemetry is outside this controlled transport fixture.
  options.success?.(
    result as WechatMiniprogram.DownloadFileSuccessCallbackResult,
  );
}
beforeEach(() => {
  storage = new Map([["timenook.frontend.v1", { privateDemo: "unchanged" }]]);
  requests = [];
  downloads = [];
  failSessionRemoval = false;
  reply = (request) => success(request, 201, envelope(identity));
  (globalThis as { wx?: unknown }).wx = {
    getStorageSync: (key: string) => structuredClone(storage.get(key)),
    setStorageSync: (key: string, value: unknown) => {
      storage.set(key, structuredClone(value));
    },
    removeStorageSync: (key: string) => {
      if (failSessionRemoval && key.includes("session.v1"))
        throw Error("device session storage unavailable");
      storage.delete(key);
    },
    login: (options: WechatMiniprogram.LoginOption) =>
      options.success?.({ code: "synthetic-device-code", errMsg: "login:ok" }),
    downloadFile: (options: WechatMiniprogram.DownloadFileOption) => {
      downloads.push(options);
      return {};
    },
    request: (options: WechatMiniprogram.RequestOption) => {
      requests.push(options);
      reply(options);
      return {} as WechatMiniprogram.RequestTask;
    },
  } as unknown as WechatMiniprogram.Wx;
});

test("mini program exchanges wx.login code using the prefixed API and stores identity separately", async () => {
  const client = new SessionClient(api);
  assert.deepEqual(await client.login(), identity);
  assert.equal(requests[0].url, `${api}/sessions/wechat`);
  assert.deepEqual(requests[0].data, { code: "synthetic-device-code" });
  assert.equal(requests[0].header?.authorization, undefined);
  assert.deepEqual(storage.get("timenook.frontend.v1"), {
    privateDemo: "unchanged",
  });
  assert.equal(storage.get("timenook.mode.v1"), "live");
});

test("stored sessions restore through the server and logout invalidates local identity", async () => {
  const client = new SessionClient(api);
  await client.login();
  reply = (request) =>
    success(
      request,
      request.method === "DELETE" ? 204 : 200,
      envelope(identity.user),
    );
  const restarted = new SessionClient(api);
  assert.deepEqual(await restarted.restore(), identity.user);
  assert.equal(
    requests[requests.length - 1]?.header?.authorization,
    `Bearer ${identity.session.token}`,
  );
  await restarted.logout();
  assert.equal(
    requests[requests.length - 1]?.url,
    `${api}/sessions/${identity.session.id}`,
  );
  assert.equal(await restarted.restore(), null);
  await assert.rejects(restarted.request("/users/me"), {
    code: "UNAUTHENTICATED",
  });
  assert.deepEqual(storage.get("timenook.frontend.v1"), {
    privateDemo: "unchanged",
  });
});

test("a late login cannot resurrect a logged out user and an old 401 cannot clear a new account", async () => {
  const client = new SessionClient(api);
  let held!: WechatMiniprogram.RequestOption;
  reply = (request) => {
    held = request;
  };
  const pending = client.login();
  await Promise.resolve();
  await client.logout();
  success(held, 201, envelope(identity));
  await assert.rejects(pending, { code: "STALE_RESPONSE" });
  assert.equal(await client.restore(), null);
  reply = (request) => success(request, 201, envelope(identity));
  await client.login();
  reply = (request) => {
    held = request;
  };
  const oldRequest = client.request("/users/me");
  const old = held;
  const other = {
    ...identity,
    user: { id: "44444444-4444-4444-8444-444444444444" },
    session: { ...identity.session, token: "b".repeat(43) },
  };
  reply = (request) => success(request, 201, envelope(other));
  await client.login();
  success(old, 401, {
    error: { code: "UNAUTHENTICATED", message: "expired", retryable: false },
    meta: envelope(null).meta,
  });
  await assert.rejects(oldRequest);
  reply = (request) => success(request, 200, envelope(other.user));
  assert.deepEqual(await client.restore(), other.user);
});

test("live mode blocks demo reads and simulated purchase even after network failure", async () => {
  const client = new SessionClient(api);
  storage.set("timenook.frontend.v1", {
    version: 2,
    activeProjectId: null,
    projects: [],
  });
  reply = (request) =>
    request.fail?.({
      errMsg: "synthetic offline",
    } as WechatMiniprogram.RequestFailCallbackErr);
  await assert.rejects(client.login(), { code: "NETWORK_ERROR" });
  assert.equal(storage.get("timenook.mode.v1"), "live");
  assert.throws(() => start("妈妈"), /演示/);
  assert.throws(() => list(), /演示/);
  assert.deepEqual(storage.get("timenook.frontend.v1"), {
    version: 2,
    activeProjectId: null,
    projects: [],
  });
});

test("unconfigured, insecure and malformed replies cannot persist a session", async () => {
  for (const base of [
    "",
    "http://example.test/v1",
    "https://example.test/v1?secret=bad",
  ]) {
    await assert.rejects(new SessionClient(base).login(), {
      code: "NOT_CONFIGURED",
    });
  }
  assert.equal(requests.length, 0);
  for (const data of [
    null,
    {},
    { user: identity.user, session: { ...identity.session, token: "short" } },
  ]) {
    reply = (request) => success(request, 201, envelope(data));
    const client = new SessionClient(api);
    await assert.rejects(client.login(), { code: "INVALID_RESPONSE" });
    assert.equal(await client.restore(), null);
  }
});

test("latest concurrent login wins and responses from an old account cannot be consumed", async () => {
  const client = new SessionClient(api);
  const held: WechatMiniprogram.RequestOption[] = [];
  reply = (request) => {
    if (request.method === "DELETE") success(request, 204, null);
    else held.push(request);
  };
  const first = client.login();
  await Promise.resolve();
  const second = client.login();
  await Promise.resolve();
  const other = {
    ...identity,
    user: { id: "44444444-4444-4444-8444-444444444444" },
    session: { ...identity.session, token: "b".repeat(43) },
  };
  success(held[1], 201, envelope(other));
  await second;
  success(held[0], 201, envelope(identity));
  await assert.rejects(first, { code: "STALE_RESPONSE" });
  const pending = client.request("/users/me");
  const old = held[2];
  await client.enterDemo();
  success(old, 200, envelope(other.user));
  await assert.rejects(pending, { code: "STALE_RESPONSE" });
  assert.equal(await client.restore(), null);
  assert.equal(storage.get("timenook.mode.v1"), "demo");
});

test("401 clears the current session while network errors preserve it and never fake success", async () => {
  const client = new SessionClient(api);
  await client.login();
  reply = (request) =>
    request.fail?.({
      errMsg: "synthetic offline",
    } as WechatMiniprogram.RequestFailCallbackErr);
  await assert.rejects(client.restore(), { code: "NETWORK_ERROR" });
  reply = (request) => success(request, 200, envelope(identity.user));
  assert.deepEqual(await client.restore(), identity.user);
  reply = (request) =>
    success(request, 401, {
      error: { code: "UNAUTHENTICATED", message: "expired", retryable: false },
      meta: envelope(null).meta,
    });
  await assert.rejects(client.restore(), { code: "UNAUTHENTICATED" });
  assert.equal(await client.restore(), null);
  assert.equal(
    await new SessionClient("https://another.test/v1").restore(),
    null,
  );
});

test("an unauthorized private photo download clears the current login and preserves its temporary path for cleanup", async () => {
  const client = new SessionClient(api);
  await client.login();
  const photoId = "55555555-5555-4555-8555-555555555555";
  const pending = client.downloadPhoto(
    identity.user.id,
    identity.session.id,
    photoId,
    "66666666-6666-4666-8666-666666666666",
  );
  downloadSuccess(downloads[0], {
    statusCode: 401,
    tempFilePath: "denied-private-photo",
    errMsg: "downloadFile:ok",
  });
  const result = await pending;
  assert.equal(result.tempFilePath, "denied-private-photo");
  assert.equal(client.context(), "");
  assert.equal(storage.has(`timenook.session.v1:${api}`), false);
  assert.equal(await client.restore(), null);
});

test("a previous account's delayed photo-download 401 cannot clear the newer login", async () => {
  const client = new SessionClient(api);
  await client.login();
  const pending = client.downloadPhoto(
    identity.user.id,
    identity.session.id,
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  );
  const other = {
    user: { id: "77777777-7777-4777-8777-777777777777" },
    session: {
      ...identity.session,
      id: "88888888-8888-4888-8888-888888888888",
      token: "b".repeat(43),
    },
  };
  reply = (request) => success(request, 201, envelope(other));
  await client.login();
  failSessionRemoval = true;
  downloadSuccess(downloads[0], {
    statusCode: 401,
    tempFilePath: "previous-account-photo",
    errMsg: "downloadFile:ok",
  });
  await pending;
  reply = (request) => success(request, 200, envelope(other.user));
  assert.deepEqual(await client.restore(), other.user);
  assert.deepEqual(storage.get(`timenook.session.v1:${api}`), other);
});

test("a failed device session removal cannot reuse the rejected token and a successful login recovers cleanup", async () => {
  const client = new SessionClient(api),
    photo = "55555555-5555-4555-8555-555555555555",
    asset = "66666666-6666-4666-8666-666666666666";
  await client.login();
  const pending = client.downloadPhoto(
    identity.user.id,
    identity.session.id,
    photo,
    asset,
  );
  failSessionRemoval = true;
  downloadSuccess(downloads[0], {
    statusCode: 401,
    tempFilePath: "denied-storage-error",
    errMsg: "downloadFile:ok",
  });
  assert.equal((await pending).tempFilePath, "denied-storage-error");
  assert.deepEqual(storage.get(`timenook.session.v1:${api}`), identity);
  assert.equal(client.sessionCleanupPending(), true);
  assert.equal(client.context(), "");
  assert.equal(await client.restore(), null);
  const count = requests.length;
  await assert.rejects(client.request("/users/me"), {
    code: "UNAUTHENTICATED",
    status: 401,
  });
  await assert.rejects(
    client.downloadPhoto(identity.user.id, identity.session.id, photo, asset),
    { code: "UNAUTHENTICATED", status: 401 },
  );
  await assert.rejects(
    client.uploadPhoto(
      {
        url: "/v1/photos/objects",
        storage: "local-simulator",
        fields: {},
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "pending-original",
    ),
    { code: "UNAUTHENTICATED", status: 401 },
  );
  assert.equal(requests.length, count);
  assert.equal(downloads.length, 1);
  await assert.rejects(client.login(), /device session storage unavailable/);
  assert.equal(client.context(), "");
  assert.equal(client.sessionCleanupPending(), true);
  assert.equal(requests.length, count);
  const other = {
    ...identity,
    session: { ...identity.session, token: "b".repeat(43) },
  };
  failSessionRemoval = false;
  await client.logout();
  assert.equal(client.sessionCleanupPending(), false);
  assert.equal(client.context(), "");
  assert.equal(storage.has(`timenook.session.v1:${api}`), false);
  reply = (request) => success(request, 201, envelope(other));
  await client.login();
  assert.equal(client.sessionCleanupPending(), false);
  assert.deepEqual(storage.get(`timenook.session.v1:${api}`), other);
  reply = (request) => success(request, 200, envelope(other.user));
  assert.deepEqual(await client.restore(), other.user);
});
