import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { get } from "node:https";
import { createServer, type ViteDevServer } from "vite";

test("development preview refuses private probe artifacts through direct and filesystem URLs", async () => {
  const suffix = randomUUID();
  const paths = [
    `.probe-local/access-${suffix}.txt`,
    `output/pdf/access-${suffix}.txt`,
    `.cache/print-probe/access-${suffix}.txt`,
    `.env.access-${suffix}`,
  ];
  const marker = "synthetic-private-artifact";
  const server = await createServer({
    configFile: "vite.config.mjs",
    logLevel: "silent",
    // A null inline override is discarded when Vite merges a config file.
    // These finite HTTP checks need no file watching or HMR.
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      watch: { ignored: () => true },
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    for (const path of paths) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, marker, { flag: "wx", mode: 0o600 });
    }
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const publicPage = await fetch(origin);
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /<html/i);
    for (const path of paths) {
      for (const url of [`/${path}`, `/@fs/${resolve(path)}`, `/${path}?raw`]) {
        const result = await fetch(origin + url);
        assert.equal(
          result.status,
          403,
          `Private artifact must be denied: ${url}`,
        );
        assert.ok(!(await result.text()).includes(marker));
      }
    }
  } finally {
    await server.close();
    await Promise.all(paths.map((path) => unlink(path).catch(() => {})));
  }
});

test("admin development HTTPS refuses workspace probe files without breaking its public page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t04-vite-access-"));
  const cert = join(directory, "localhost.crt");
  const key = join(directory, "localhost.pem");
  const path = `.probe-local/access-admin-${randomUUID()}.txt`;
  const marker = "synthetic-private-admin-artifact";
  const previousCert = process.env.ADMIN_TLS_CERT;
  const previousKey = process.env.ADMIN_TLS_KEY;
  let server: ViteDevServer | undefined;
  const read = (url: string) =>
    new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = get(url, { rejectUnauthorized: false }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          response.on("error", reject);
        });
        request.setTimeout(5000, () =>
          request.destroy(new Error("Local HTTPS request timed out")),
        );
        request.on("error", reject);
      },
    );
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    process.env.ADMIN_TLS_CERT = cert;
    process.env.ADMIN_TLS_KEY = key;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, marker, { flag: "wx", mode: 0o600 });
    server = await createServer({
      root: resolve("apps/admin"),
      configFile: resolve("apps/admin/vite.config.ts"),
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        watch: { ignored: () => true },
      },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const origin = `https://127.0.0.1:${address.port}/admin`;
    const publicPage = await read(origin + "/");
    assert.equal(publicPage.status, 200);
    assert.match(publicPage.body, /<html/i);
    const result = await read(`${origin}/@fs/${resolve(path)}`);
    assert.equal(result.status, 403);
    assert.ok(!result.body.includes(marker));
  } finally {
    await server?.close();
    await unlink(path).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    if (previousCert === undefined) delete process.env.ADMIN_TLS_CERT;
    else process.env.ADMIN_TLS_CERT = previousCert;
    if (previousKey === undefined) delete process.env.ADMIN_TLS_KEY;
    else process.env.ADMIN_TLS_KEY = previousKey;
  }
});
