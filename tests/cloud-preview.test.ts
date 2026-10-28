import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";

test("local preview forwards cloud health and probe requests with exactly one public prefix", async () => {
  const backend = createHttpServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ path: request.url, host: request.headers.host }),
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address === "object");
  const target = `http://127.0.0.1:${address.port}`;
  const reservation = createHttpServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const previewAddress = reservation.address();
  assert.ok(previewAddress && typeof previewAddress === "object");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const previous = process.env.TIMENOOK_PREVIEW_API_TARGET;
  process.env.TIMENOOK_PREVIEW_API_TARGET = `${target}/api`;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({
      configFile: "vite.config.mjs",
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: previewAddress.port,
        strictPort: true,
        watch: { ignored: () => true },
      },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const local = server.httpServer!.address();
    assert.ok(local && typeof local === "object");
    for (const path of [
      "/api/health/ready",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/exports",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/exports/44444444-4444-4444-8444-444444444444/download",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/exports/44444444-4444-4444-8444-444444444444/receipt",
      "/api/v1/probes/audio/clips",
      "/api/v1/probes/ai/metrics",
      "/api/v1/users/me",
      "/api/v1/book-audio/abcdefghijklmnopqrstuv",
      "/api/v1/book-audio/abcdefghijklmnopqrstuv/clips/44444444-4444-4444-8444-444444444444/content?epoch=3",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/fulfillment",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/fulfillment/grants",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/first-copy",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/first-copy/address",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/first-copy/confirmations",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/first-copy/submit",
      "/api/v1/projects/33333333-3333-4333-8333-333333333333/first-copy/expiry-review",
    ]) {
      const response: Response = await fetch(
        `http://127.0.0.1:${local.port}${path}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        path,
        host: `127.0.0.1:${address.port}`,
      });
    }
  } finally {
    if (previous === undefined) delete process.env.TIMENOOK_PREVIEW_API_TARGET;
    else process.env.TIMENOOK_PREVIEW_API_TARGET = previous;
    await server?.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
