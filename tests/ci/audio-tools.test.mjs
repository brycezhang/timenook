import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../../scripts/setup-audio-tools.sh", import.meta.url),
);
const primary = Buffer.from("synthetic pinned release source archive");
const mirror = Buffer.from("synthetic pinned official mirror archive");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, modes = {}) {
  const directory = mkdtempSync(join(tmpdir(), "timenook-audio-source-"));
  const requests = [];
  const server = createServer((request, response) => {
    const source = request.url === "/primary" ? "primary" : "mirror";
    requests.push(source);
    const mode = modes[source] ?? "valid";
    if (mode === "network") return response.destroy();
    if (mode === "http") {
      response.writeHead(503);
      return response.end();
    }
    const bytes = source === "primary" ? primary : mirror;
    if (mode === "truncated") {
      response.writeHead(200, {
        "Content-Length": bytes.length + 10,
        Connection: "close",
      });
      response.end(bytes);
      return;
    }
    response.end(mode === "corrupt" ? "synthetic wrong archive" : bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    "bash",
    [
      "-c",
      'source "$1"; download_audio_archive "$2" "$3" "$4" "$5" "$6"',
      "--",
      script,
      directory,
      `${base}/primary`,
      digest(primary),
      `${base}/mirror`,
      digest(mirror),
    ],
    { env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" } },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  return { code, stdout, stderr, requests, directory };
}

test("audio source uses and verifies the primary archive without requesting its mirror", async (t) => {
  const result = await fixture(t);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests, ["primary"]);
  assert.deepEqual(readFileSync(result.stdout.trim()), primary);
});

for (const mode of ["network", "truncated"]) {
  test(`audio source falls back after ${mode} transport failure and verifies the mirror independently`, async (t) => {
    const result = await fixture(t, { primary: mode });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests, ["primary", "mirror"]);
    assert.deepEqual(readFileSync(result.stdout.trim()), mirror);
  });
}

for (const mode of ["corrupt", "http"]) {
  test(`audio source blocks ${mode} primary data without masking it through fallback`, async (t) => {
    const result = await fixture(t, { primary: mode });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.requests, ["primary"]);
    assert.equal(result.stdout, "");
  });
}

for (const mode of ["network", "truncated", "corrupt"]) {
  test(`audio source blocks ${mode} fallback and never returns an unverified archive`, async (t) => {
    const result = await fixture(t, { primary: "network", mirror: mode });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.requests, ["primary", "mirror"]);
    assert.equal(result.stdout, "");
  });
}
