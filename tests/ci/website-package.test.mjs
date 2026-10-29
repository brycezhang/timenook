import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../../scripts/ci/verify-website.mjs", import.meta.url),
);
const sha = "a".repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "timenook-website-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output");
  const dist = join(root, "dist");
  mkdirSync(output);
  mkdirSync(dist);
  writeFileSync(
    join(dist, "index.html"),
    "<title>Public website fixture</title>\n",
  );
  execFileSync("tar", ["-czf", join(output, "website.tgz"), "-C", dist, "."]);
  const digest = createHash("sha256")
    .update(readFileSync(join(output, "website.tgz")))
    .digest("hex");
  writeFileSync(join(output, "website.tgz.sha256"), `${digest}  website.tgz\n`);
  const manifest = {
    application: "timenook-website",
    revision: sha,
    workingTreeDirty: false,
    previewOnly: true,
    archive: "website.tgz",
    sha256: digest,
  };
  const write = (value) =>
    writeFileSync(join(output, "website-release.json"), JSON.stringify(value));
  write(manifest);
  return { output, manifest, write, root };
}
const verify = (dir, revision = sha) =>
  spawnSync(process.execPath, [script, dir, revision], { encoding: "utf8" });

test("website candidate verifier accepts a real tar archive bound to a clean candidate SHA", (t) => {
  const f = fixture(t);
  const result = verify(f.output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified/i);
});

for (const failure of [
  "archive-tampered",
  "checksum-tampered",
  "checksum-format",
  "wrong-sha",
  "dirty",
  "application",
  "preview-only",
  "archive-name",
  "manifest-digest",
  "missing-file",
  "symlink-archive",
  "symlink-checksum",
  "symlink-manifest",
  "malformed-manifest",
]) {
  test(`website candidate verifier rejects ${failure} without printing private input`, (t) => {
    const f = fixture(t);
    const secret = "PRIVATE_WEBSITE_FIXTURE_MUST_NOT_PRINT";
    if (failure === "archive-tampered")
      writeFileSync(join(f.output, "website.tgz"), secret);
    if (failure === "checksum-tampered")
      writeFileSync(
        join(f.output, "website.tgz.sha256"),
        `${"0".repeat(64)}  website.tgz\n`,
      );
    if (failure === "checksum-format")
      writeFileSync(join(f.output, "website.tgz.sha256"), secret);
    if (failure === "dirty") {
      f.manifest.workingTreeDirty = true;
      f.write(f.manifest);
    }
    if (failure === "application") {
      f.manifest.application = secret;
      f.write(f.manifest);
    }
    if (failure === "preview-only") {
      f.manifest.previewOnly = false;
      f.write(f.manifest);
    }
    if (failure === "archive-name") {
      f.manifest.archive = secret;
      f.write(f.manifest);
    }
    if (failure === "manifest-digest") {
      f.manifest.sha256 = "0".repeat(64);
      f.write(f.manifest);
    }
    if (failure === "missing-file")
      rmSync(join(f.output, "website.tgz.sha256"));
    if (failure.startsWith("symlink-")) {
      const name =
        failure === "symlink-archive"
          ? "website.tgz"
          : failure === "symlink-checksum"
            ? "website.tgz.sha256"
            : "website-release.json";
      const target = join(f.root, "outside");
      writeFileSync(target, readFileSync(join(f.output, name)));
      rmSync(join(f.output, name));
      symlinkSync(target, join(f.output, name));
    }
    if (failure === "malformed-manifest")
      writeFileSync(join(f.output, "website-release.json"), secret);
    const result = verify(
      f.output,
      failure === "wrong-sha" ? "b".repeat(40) : sha,
    );
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  });
}
