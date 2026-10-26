import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("scripts/release/package.mjs");
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "timenook-release-test-"));
  const root = join(parent, "source");
  await mkdir(root);
  const files = {
    ".node-version": "22.23.4\n",
    "package.json": JSON.stringify({
      name: "timenook",
      packageManager: "pnpm@10.34.7",
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: [apps/*, packages/*, vendor/vben/*]\n",
    "apps/api/package.json": '{"name":"@timenook/api"}',
    "apps/api/prisma/schema.prisma":
      'generator client { provider = "prisma-client-js" }\n',
    "apps/api/prisma/migrations/migration_lock.toml":
      'provider = "postgresql"\n',
    "apps/api/prisma/migrations/202610260001_test/migration.sql": "SELECT 1;\n",
    "apps/api/dist/main.js": "// built API\n",
    "apps/api/dist/tasks/worker-main.js": "// built Worker\n",
    "apps/api/runtime/bounded-process.mjs": "// bounded renderer\n",
    "packages/contracts/package.json": '{"name":"@timenook/contracts"}',
    "packages/contracts/dist/index.js": "// contracts\n",
    "apps/admin/package.json": '{"name":"@timenook/admin"}',
    "apps/admin/dist/index.html": "<title>TimeNook Admin</title>\n",
    "scripts/print-probe/book-worker.mjs": "// fixed renderer\n",
    "scripts/print-probe/OFL.txt": "font license\n",
    "scripts/release/package.mjs": await readFile(cli).catch(
      () => "// absent CLI before RED\n",
    ),
    "vendor/vben/layout/package.json": '{"name":"@vben/layout"}',
    ".cache/print-probe/NotoSansCJKsc-Regular.otf": "verified-font-fixture\n",
  };
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), bytes);
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture source");
  await writeFile(join(root, ".env"), "DO_NOT_SHIP=private-test-value\n");
  await mkdir(join(root, ".probe-local"));
  await writeFile(join(root, ".probe-local/identity.json"), "private fixture");
  return {
    parent,
    root,
    output: join(parent, "candidate"),
    commit: git("rev-parse", "HEAD"),
  };
}
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}
test("candidate release contains the fixed API/Worker/admin/renderer/migrations and a verifiable inventory without private local files", async () => {
  const f = await fixture();
  try {
    const packaged = run("create", "--root", f.root, "--output", f.output);
    assert.equal(packaged.status, 0, packaged.stderr);
    const manifest = JSON.parse(
      await readFile(join(f.output, "release-manifest.json"), "utf8"),
    );
    assert.equal(manifest.commit, f.commit);
    assert.equal(manifest.scope, "candidate");
    assert.equal(manifest.toolchain.pnpm, "10.34.7");
    assert.equal(manifest.toolchain.node, "22.23.4");
    for (const path of [
      "apps/api/dist/main.js",
      "apps/api/dist/tasks/worker-main.js",
      "apps/api/prisma/migrations/202610260001_test/migration.sql",
      "apps/admin/dist/index.html",
      "scripts/print-probe/book-worker.mjs",
      ".cache/print-probe/NotoSansCJKsc-Regular.otf",
    ]) {
      assert.ok(
        manifest.files.some((file) => file.path === path),
        path,
      );
    }
    assert.ok(
      manifest.files.every(
        (file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0,
      ),
    );
    assert.ok(
      manifest.files.every(
        (file) =>
          !file.path.startsWith(".env") && !file.path.includes(".probe-local"),
      ),
    );
    const verified = run("verify", "--root", f.output);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /verified/i);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
test("packaging refuses a private file accidentally placed in a built output directory", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.root, "apps/api/dist/.env"),
      "DO_NOT_SHIP=private-test-value\n",
    );
    const result = run("create", "--root", f.root, "--output", f.output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELEASE_UNEXPECTED_FILE/);
    assert.doesNotMatch(result.stderr, /private-test-value/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
test("the archived candidate extracts independently and detects a changed migration before deployment", async () => {
  const f = await fixture();
  try {
    const result = run("create", "--root", f.root, "--output", f.output);
    assert.equal(result.status, 0, result.stderr);
    const archive = await readFile(f.output + ".tgz");
    const checksum = await readFile(f.output + ".tgz.sha256", "utf8");
    assert.match(
      checksum,
      new RegExp(
        "^" +
          createHash("sha256").update(archive).digest("hex") +
          "  candidate\\.tgz\\n$",
      ),
    );
    const extracted = join(f.parent, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", f.output + ".tgz", "-C", extracted]);
    assert.equal(run("verify", "--root", extracted).status, 0);
    await writeFile(
      join(
        extracted,
        "apps/api/prisma/migrations/202610260001_test/migration.sql",
      ),
      "SELECT 2;\n",
    );
    const corrupted = run("verify", "--root", extracted);
    assert.equal(corrupted.status, 1);
    assert.match(corrupted.stderr, /RELEASE_INTEGRITY_FAILED/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
test("a candidate cannot be packaged for a platform other than the actual build host", async () => {
  const f = await fixture();
  try {
    const result = run(
      "create",
      "--root",
      f.root,
      "--output",
      f.output,
      "--platform",
      process.platform === "linux" ? "darwin" : "linux",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELEASE_PLATFORM_MISMATCH/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
test("verification rejects an unlisted file and does not accept the original manifest as proof of a changed directory", async () => {
  const f = await fixture();
  try {
    assert.equal(
      run("create", "--root", f.root, "--output", f.output).status,
      0,
    );
    await writeFile(join(f.output, "unexpected.json"), "{}\n");
    const result = run("verify", "--root", f.output);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELEASE_INVENTORY_MISMATCH/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
test("a release refuses an uncommitted source or a Node version different from the pinned toolchain", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".node-version"), "1.0.0\n");
    assert.match(
      run("create", "--root", f.root, "--output", f.output).stderr,
      /RELEASE_SOURCE_NOT_COMMITTED/,
    );
    execFileSync("git", ["add", ".node-version"], { cwd: f.root });
    execFileSync("git", ["commit", "-m", "different pinned runtime"], {
      cwd: f.root,
      stdio: "pipe",
    });
    const mismatch = run("create", "--root", f.root, "--output", f.output);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /RELEASE_NODE_MISMATCH/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});
