import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const script = resolve("scripts/ci/check.mjs");
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "timenook-ci-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI fixture");
  const put = (path, body) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { cwd, git, put, commit, run };
}
test("explanatory Markdown routes to docs and mixed implementation changes route to full", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Example\n");
  const base = f.commit();
  f.put("docs/guide.md", "# Guide\n");
  assert.equal(f.run("classify", base, base).stdout.trim(), "full");
  const docs = f.commit();
  let result = f.run("classify", base, docs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "docs");
  f.put("apps/api/order.ts", "export const value = 1;\n");
  result = f.run("classify", docs, f.commit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "full");
});
test("renamed or deleted code, executable Markdown and fixtures under docs require full checks", (t) => {
  const f = fixture(t);
  f.put("app.ts", "export const value = 1;\n");
  f.put("docs/guide.md", "# Guide\n");
  const base = f.commit();
  f.git("mv", "app.ts", "docs/renamed.md");
  const renamed = f.commit();
  assert.equal(f.run("classify", base, renamed).stdout.trim(), "full");
  f.git("rm", "docs/renamed.md");
  f.put("docs/decision.json", "{}\n");
  assert.equal(f.run("classify", renamed, f.commit()).stdout.trim(), "full");
  const beforeMode = f.git("rev-parse", "HEAD");
  f.git("update-index", "--chmod=+x", "docs/guide.md");
  f.git("commit", "-qm", "executable markdown");
  assert.equal(f.run("classify", beforeMode, "HEAD").stdout.trim(), "full");
  const beforeLink = f.git("rev-parse", "HEAD");
  symlinkSync("../app.ts", join(f.cwd, "docs/link.md"));
  assert.equal(f.run("classify", beforeLink, f.commit()).stdout.trim(), "full");
  f.put("delete-me.ts", "export {};\n");
  const beforeDelete = f.commit();
  f.git("rm", "delete-me.ts");
  assert.equal(
    f.run("classify", beforeDelete, f.commit()).stdout.trim(),
    "full",
  );
  assert.notEqual(f.run("classify", "missing-ref", "HEAD").status, 0);
});
test("docs check rejects newly broken local links and deletion of a linked document", (t) => {
  const f = fixture(t);
  f.put("README.md", "[Guide](docs/guide.md)\n");
  f.put("docs/guide.md", "# Guide\n");
  const base = f.commit();
  f.put("docs/guide.md", "# Guide\n[Missing](missing.md)\n");
  let head = f.commit();
  let result = f.run("docs", base, head);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.md/);
  f.put("docs/guide.md", "# Guide\n[Home](../README.md)\n");
  head = f.commit();
  result = f.run("docs", base, head);
  assert.equal(result.status, 0, result.stderr);
  f.git("rm", "docs/guide.md");
  result = f.run("docs", head, f.commit());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /README\.md.*docs\/guide\.md/);
});
test("ticket structure rejects missing acceptance and unknown blockers without hard-coding graph counts", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Example\n");
  const base = f.commit();
  const ticket = {
    id: "T01",
    title: "Example",
    stage: "S0",
    file: "tickets/01-example.md",
    blockedBy: [],
    issueUrl: "https://github.com/brycezhang/timenook/issues/2",
  };
  f.put("docs/delivery/example/tickets.json", JSON.stringify([ticket]));
  const body =
    "# T01 · Example\n\nGitHub: https://github.com/brycezhang/timenook/issues/2\n\n## 交付结果\nDone\n\n## 验收条件\n- [ ] Observable result\n\n## 测试决策\nCLI\n\n## 阻塞依赖\n无\n";
  f.put(
    "docs/delivery/example/tickets/01-example.md",
    body.replace("## 验收条件", "## Missing"),
  );
  let result = f.run("docs", base, f.commit());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /T01.*验收条件/);
  f.put("docs/delivery/example/tickets/01-example.md", body);
  result = f.run("docs", base, f.commit());
  assert.equal(result.status, 0, result.stderr);
  ticket.blockedBy = ["T99"];
  f.put("docs/delivery/example/tickets.json", JSON.stringify([ticket]));
  result = f.run("docs", base, f.commit());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /T01.*T99/);
});
test("stable check gate accepts only its selected successful check and fails closed on missing or failed classification", (t) => {
  const f = fixture(t);
  const run = (needs) =>
    spawnSync(process.execPath, [script, "gate"], {
      cwd: f.cwd,
      encoding: "utf8",
      env: { ...process.env, CHECK_NEEDS: JSON.stringify(needs) },
    });
  const needs = {
    changes: { result: "success", outputs: { mode: "docs" } },
    docs: { result: "success" },
    full: { result: "skipped" },
  };
  assert.equal(run(needs).status, 0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.notEqual(run({ ...needs, docs: { result } }).status, 0);
  }
  assert.notEqual(
    run({ ...needs, changes: { result: "failure", outputs: { mode: "docs" } } })
      .status,
    0,
  );
  assert.notEqual(
    run({ ...needs, changes: { result: "success", outputs: {} } }).status,
    0,
  );
  assert.notEqual(run({}).status, 0);
  assert.notEqual(run({ ...needs, full: { result: "failure" } }).status, 0);
  assert.equal(
    run({
      ...needs,
      changes: { result: "success", outputs: { mode: "full" } },
      docs: { result: "skipped" },
      full: { result: "success" },
    }).status,
    0,
  );
});

test("docs check preserves historical unresolved links and Git-excluded evidence but rejects added diff errors", (t) => {
  const f = fixture(t);
  f.put(".gitignore", "output/\n");
  f.put("README.md", "# Example\n[Historical](missing.md)\n");
  const base = f.commit();
  f.put(
    "README.md",
    "# Example updated\n[Historical](missing.md)\n[Local evidence](output/proof.txt)\n[Personal](/Users/example/proof.txt)\n",
  );
  let result = f.run("docs", base, f.commit());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 pre-existing/);
  f.put("docs/guide.md", "# Bad trailing whitespace  \n");
  result = f.run("docs", base, f.commit());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trailing whitespace/);
});
