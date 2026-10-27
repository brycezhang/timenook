import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
const base = "https://example.test/timenook/v1";
const entryId = "abcdefghijklmnopqrstuv";
const clipId = "44444444-4444-4444-8444-444444444444";
const login = {
  user: { id: "11111111-1111-4111-8111-111111111111" },
  session: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "a".repeat(43),
    expiresAt: "2099-01-01T00:00:00Z",
  },
};
const source = (
  await build({
    entryPoints: ["miniprogram/pages/original-audio/index.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    define: { __TIMENOOK_API_BASE_URL__: JSON.stringify(base) },
  })
).outputFiles[0].text;
function view(): any {
  return {
    id: entryId,
    projectId: "33333333-3333-4333-8333-333333333333",
    story: {
      id: "55555555-5555-4555-8555-555555555555",
      revisionId: "66666666-6666-4666-8666-666666666666",
      version: 2,
      title: "纸书上的那条小路",
    },
    clips: [
      {
        clipId,
        sequence: 0,
        assetId: "77777777-7777-4777-8777-777777777777",
        sha256: "f".repeat(64),
        bytes: 4567,
        durationMs: 18000,
      },
    ],
    accessEpoch: 3,
    accessExpiresAt: null,
  };
}
function harness(authenticated = true) {
  const storage = new Map<string, any>([["timenook.mode.v1", "demo"]]);
  if (authenticated)
    storage.set(`timenook.session.v1:${base}`, structuredClone(login));
  const requests: any[] = [],
    downloads: any[] = [],
    removed: string[] = [],
    players: any[] = [],
    timers: any[] = [],
    loginCalls: any[] = [];
  const clock = { now: Date.now() };
  const faults = {
    unlink: false,
    sessionRemoval: false,
    digest: "f".repeat(64),
    bytes: 4567,
  };
  let page: any;
  runInNewContext(source, {
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    setTimeout(callback: () => void, delay: number) {
      const t = { callback, delay, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout(t: any) {
      if (t) t.cleared = true;
    },
    Page(value: any) {
      page = value;
      page.setData = (patch: any) => Object.assign(page.data, patch);
    },
    wx: {
      getStorageSync(key: string) {
        assert.notEqual(key, "timenook.frontend.v1");
        return structuredClone(storage.get(key));
      },
      setStorageSync(key: string, value: any) {
        storage.set(key, structuredClone(value));
      },
      removeStorageSync(key: string) {
        if (faults.sessionRemoval && key.startsWith("timenook.session.v1:"))
          throw Error("device storage removal failed");
        storage.delete(key);
      },
      request(o: any) {
        requests.push(o);
      },
      downloadFile(o: any) {
        downloads.push(o);
      },
      login(o: any) {
        loginCalls.push(o);
      },
      getFileSystemManager() {
        return {
          unlink(o: any) {
            if (faults.unlink) o.fail({ errCode: 1 });
            else {
              removed.push(o.filePath);
              o.success?.({});
            }
          },
          getFileInfo(o: any) {
            o.success({ size: faults.bytes, digest: faults.digest });
          },
        };
      },
      createInnerAudioContext() {
        const p: any = {
          src: "",
          played: false,
          destroyed: false,
          play() {
            p.played = true;
          },
          stop() {},
          pause() {},
          destroy() {
            p.destroyed = true;
          },
          onEnded(fn: any) {
            p.ended = fn;
          },
          onError(fn: any) {
            p.error = fn;
          },
          onPlay(fn: any) {
            p.onplay = fn;
          },
        };
        players.push(p);
        return p;
      },
      showToast() {},
    },
  });
  return {
    page,
    storage,
    requests,
    downloads,
    removed,
    players,
    timers,
    loginCalls,
    clock,
    faults,
    respond(index: number, data: any, statusCode = 200) {
      assert.ok(requests[index], `HTTP ${index}`);
      requests[index].success({
        statusCode,
        data:
          statusCode < 400
            ? { data, meta: { requestId: "synthetic" } }
            : {
                error: {
                  code: statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
                },
                meta: { requestId: "synthetic" },
              },
      });
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function shown(h: ReturnType<typeof harness>, q: any = { entryId }) {
  h.page.onLoad(q);
  const pending = h.page.onShow();
  await tick();
  h.respond(0, view());
  await pending;
}

test("a scanned stable ID opens live mode and keeps private metadata hidden until authorized", async () => {
  const h = harness(false);
  h.page.onLoad({ scene: encodeURIComponent(entryId) });
  await h.page.onShow();
  assert.equal(h.storage.get("timenook.mode.v1"), "live");
  assert.equal(h.page.data.entry, null);
  assert.equal(h.page.data.loggedIn, false);
  assert.equal(h.requests.length, 0);
  assert.match(h.page.data.status, /登录/);
});

test("authorized readers resolve the exact printed story and ordered original clips", async () => {
  const h = harness();
  await shown(h);
  assert.equal(h.requests[0].url, `${base}/book-audio/${entryId}`);
  assert.equal(
    h.requests[0].header.authorization,
    `Bearer ${login.session.token}`,
  );
  assert.equal(h.page.data.entry.story.title, "纸书上的那条小路");
  assert.equal(h.page.data.entry.story.version, 2);
  assert.equal(h.page.data.entry.clips[0].clipId, clipId);
  h.page.onHide();
});

async function playing(h: ReturnType<typeof harness>) {
  const pending = h.page.play({ currentTarget: { dataset: { id: clipId } } });
  await tick();
  h.respond(1, view());
  await tick();
  assert.equal(
    h.downloads[0].url,
    `${base}/book-audio/${entryId}/clips/${clipId}/content?epoch=3`,
  );
  assert.equal(
    h.downloads[0].header.authorization,
    `Bearer ${login.session.token}`,
  );
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://private-t21.mp3",
  });
  await tick();
  h.respond(2, view());
  await pending;
}
test("playback verifies gateway bytes and current authorization before playing; end removes temporary audio", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  assert.equal(h.players.length, 1);
  assert.equal(h.players[0].src, "wxfile://private-t21.mp3");
  assert.equal(h.players[0].played, true);
  h.players[0].ended();
  await tick();
  assert.equal(h.players[0].destroyed, true);
  assert.ok(h.removed.includes("wxfile://private-t21.mp3"));
  assert.equal(h.page.data.playingClipId, "");
  h.page.onHide();
});

test("login preserves scanned ID through a native foreground event and resolves only after the account is restored", async () => {
  const h = harness(false);
  h.page.onLoad({
    q: encodeURIComponent(`https://example.test/timenook/audio/${entryId}`),
  });
  await h.page.onShow();
  const pending = h.page.login();
  await tick();
  h.loginCalls[0].success({ code: "synthetic-login-code" });
  await tick();
  await h.page.onShow();
  assert.equal(h.page.data.entry, null);
  h.respond(0, login);
  await tick();
  assert.equal(h.requests[1].url, `${base}/book-audio/${entryId}`);
  h.respond(1, view());
  await pending;
  assert.equal(h.page.data.entry.id, entryId);
  h.page.onHide();
});

test("logout removes local identity even when temporary audio cleanup needs a retry", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  h.faults.unlink = true;
  const pending = h.page.logout();
  await tick();
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players[0].destroyed, true);
  h.respond(3, undefined, 204);
  await pending;
  assert.match(h.page.data.status, /清理|重试/);
  h.faults.unlink = false;
  const refresh = h.page.refresh();
  await refresh;
  assert.ok(h.removed.includes("wxfile://private-t21.mp3"));
  h.page.onHide();
});

test("hiding while the gateway download is late removes its file and never starts playback", async () => {
  const h = harness();
  await shown(h);
  const pending = h.page.play({ currentTarget: { dataset: { id: clipId } } });
  await tick();
  h.respond(1, view());
  await tick();
  h.page.onHide();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://late.mp3",
  });
  await pending;
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("wxfile://late.mp3"));
});

test("a changed epoch after a download refuses playback and removes the downloaded private file", async () => {
  const h = harness();
  await shown(h);
  const pending = h.page.play({ currentTarget: { dataset: { id: clipId } } });
  await tick();
  h.respond(1, view());
  await tick();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://stale.mp3",
  });
  await tick();
  h.respond(2, { ...view(), accessEpoch: 4 });
  await pending;
  await tick();
  assert.equal(h.players.length, 0);
  assert.equal(h.page.data.entry, null);
  assert.ok(h.removed.includes("wxfile://stale.mp3"));
  assert.doesNotMatch(h.page.data.status, /已删除|已移除/);
  h.page.onHide();
});

test("mismatched gateway bytes never reach the player and remain scheduled for cleanup", async () => {
  const h = harness();
  await shown(h);
  h.faults.digest = "e".repeat(64);
  const pending = h.page.play({ currentTarget: { dataset: { id: clipId } } });
  await tick();
  h.respond(1, view());
  await tick();
  h.downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://mismatch.mp3",
  });
  await pending;
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("wxfile://mismatch.mp3"));
  assert.match(h.page.data.status, /校验/);
  h.page.onHide();
});

test("the exact online expiry clears the story and destroys temporary playback without claiming deletion", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  h.page.data.entry.accessExpiresAt = new Date(h.clock.now + 1).toISOString();
  h.clock.now += 1;
  h.timers
    .filter((t) => !t.cleared)
    .slice(-1)[0]
    .callback();
  await tick();
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players[0].destroyed, true);
  assert.ok(h.removed.includes("wxfile://private-t21.mp3"));
  assert.doesNotMatch(h.page.data.status, /已删除|已移除/);
  h.page.onHide();
});

test("a local account switch clears the printed-story metadata and downloaded playback", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  const next = structuredClone(login);
  next.user.id = "88888888-8888-4888-8888-888888888888";
  h.storage.set(`timenook.session.v1:${base}`, next);
  h.timers
    .filter((t) => !t.cleared)
    .slice(-1)[0]
    .callback();
  await tick();
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players[0].destroyed, true);
  assert.ok(h.removed.includes("wxfile://private-t21.mp3"));
  h.page.onHide();
});

test("anonymous or unknown access never exposes private titles and late authorized responses cannot restore a hidden page", async () => {
  const h = harness();
  h.page.onLoad({ entryId });
  const pending = h.page.onShow();
  await tick();
  h.respond(0, null, 403);
  await pending;
  assert.equal(h.page.data.entry, null);
  assert.doesNotMatch(h.page.data.status, /已删除|已移除/);
  const refreshed = h.page.refresh();
  await tick();
  h.page.onHide();
  h.respond(1, view());
  await refreshed;
  assert.equal(h.page.data.entry, null);
});

test("malformed scans never issue a request or display private content", async () => {
  for (const q of [
    { entryId: "../secret" },
    { scene: "%" },
    {
      q: encodeURIComponent(
        `https://user:secret@example.test/audio/${entryId}`,
      ),
    },
    {
      q: encodeURIComponent(
        `https://example.test/audio/${entryId}?token=secret`,
      ),
    },
  ]) {
    const h = harness(false);
    h.page.onLoad(q);
    await h.page.onShow();
    assert.equal(h.requests.length, 0);
    assert.equal(h.page.data.entry, null);
    assert.match(h.page.data.status, /无效/);
    h.page.onHide();
  }
});

test("the session is invalidated and a denied gateway file removed after a 401", async () => {
  const h = harness();
  await shown(h);
  const pending = h.page.play({ currentTarget: { dataset: { id: clipId } } });
  await tick();
  h.respond(1, view());
  await tick();
  h.downloads[0].success({
    statusCode: 401,
    tempFilePath: "wxfile://denied.mp3",
  });
  await pending;
  assert.equal(h.storage.has(`timenook.session.v1:${base}`), false);
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players.length, 0);
  assert.ok(h.removed.includes("wxfile://denied.mp3"));
  h.page.onHide();
});

test("a stale expiry callback cannot clear a newer successful entry query", async () => {
  const h = harness();
  await shown(h);
  const oldTimer = h.timers.filter((t) => !t.cleared).slice(-1)[0];
  const pending = h.page.refresh();
  await tick();
  h.respond(1, view());
  await pending;
  oldTimer.callback();
  assert.equal(h.page.data.entry?.story.title, "纸书上的那条小路");
  h.page.onHide();
});

test("a device session-removal failure stops playback and reports that logout is incomplete", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  h.faults.sessionRemoval = true;
  await h.page.logout();
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players[0].destroyed, true);
  assert.match(h.page.data.status, /退出登录尚未完成/);
  assert.equal(h.page.data.loggedIn, true);
  h.page.onHide();
});

for (const oldResult of [200, 403]) {
  test(`a late post-download resolver ${oldResult} cannot stop a newer page playback`, async () => {
    const h = harness();
    await shown(h);
    const first = h.page.play({ currentTarget: { dataset: { id: clipId } } });
    await tick();
    h.respond(1, view());
    await tick();
    h.downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://first-owner.mp3",
    });
    await tick();
    assert.equal(
      h.requests.length,
      3,
      "first playback awaits its second authorization read",
    );
    h.page.onHide();
    const show = h.page.onShow();
    await tick();
    h.respond(3, view());
    await show;
    const second = h.page.play({ currentTarget: { dataset: { id: clipId } } });
    await tick();
    h.respond(4, view());
    await tick();
    h.downloads[1].success({
      statusCode: 200,
      tempFilePath: "wxfile://second-owner.mp3",
    });
    await tick();
    h.respond(5, view());
    await second;
    const currentPlayer = h.players[0];
    assert.equal(currentPlayer.src, "wxfile://second-owner.mp3");
    assert.equal(currentPlayer.played, true);
    h.respond(2, oldResult === 200 ? view() : null, oldResult);
    await first;
    assert.equal(currentPlayer.destroyed, false);
    assert.equal(h.page.data.playingClipId, clipId);
    assert.equal(h.page.data.entry?.story.title, "纸书上的那条小路");
    assert.equal(h.removed.includes("wxfile://second-owner.mp3"), false);
    assert.equal(h.removed.includes("wxfile://first-owner.mp3"), true);
    h.page.onHide();
  });
}

test("server withdrawal while the printed original is playing clears the local file without another user action", async () => {
  const h = harness();
  await shown(h);
  await playing(h);
  const before = h.requests.length;
  h.timers
    .filter((t) => !t.cleared)
    .slice(-1)[0]
    .callback();
  await tick();
  assert.equal(h.requests.length, before + 1);
  h.respond(before, undefined, 403);
  await tick();
  assert.equal(h.page.data.entry, null);
  assert.equal(h.players[0].destroyed, true);
  assert.ok(h.removed.includes("wxfile://private-t21.mp3"));
  h.page.onHide();
});
