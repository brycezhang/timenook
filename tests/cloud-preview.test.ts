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
  process.env.TIMENOOK_PREVIEW_API_TARGET = `${target}/timenook`;
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
      "/timenook/health/ready",
      "/timenook/v1/probes/audio/clips",
      "/timenook/v1/probes/ai/metrics",
      "/timenook/v1/users/me",
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
