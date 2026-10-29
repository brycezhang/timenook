import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
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
  const runWithEnv = (env, ...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CHECK_EVENT_NAME: "", CHECK_REF: "", ...env },
    });
  const run = (...args) => runWithEnv({}, ...args);
  return { cwd, git, put, commit, run, runWithEnv };
}

const pullRequest = {
  CHECK_EVENT_NAME: "pull_request",
  CHECK_REF: "refs/pull/76/merge",
};

test("website PR source, fixtures and declared standalone configuration route to website", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Project\n");
  let base = f.commit();
  for (const path of [
    "apps/website/index.html",
    "apps/website/src/main.ts",
    "apps/website/src/view.tsx",
    "apps/website/src/main.js",
    "apps/website/src/view.jsx",
    "apps/website/src/config.mjs",
    "apps/website/tests/fixture.cjs",
    "apps/website/src/style.css",
    "apps/website/src/assets/logo.svg",
    "apps/website/src/assets/photo.png",
    "apps/website/src/assets/photo.jpg",
    "apps/website/src/assets/photo.jpeg",
    "apps/website/src/assets/photo.webp",
    "apps/website/src/assets/photo.gif",
    "apps/website/src/assets/photo.avif",
    "apps/website/src/assets/favicon.ico",
    "apps/website/src/assets/font.woff",
    "apps/website/src/assets/font.woff2",
    "apps/website/src/assets/font.ttf",
    "apps/website/src/assets/font.otf",
    "apps/website/tests/fixtures/content.json",
    "apps/website/tests/nested/website.spec.ts",
    "apps/website/vite.config.ts",
    "apps/website/playwright.config.ts",
    "apps/website/tsconfig.json",
    "apps/website/scripts/prepare-assets.mjs",
    "apps/website/scripts/package.mjs",
  ]) {
    f.put(path, "fixture\n");
    const head = f.commit();
    const result = f.runWithEnv(pullRequest, "classify", base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "website", path);
    base = head;
  }
});

test("website with explanatory docs routes to website while docs alone stay docs", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Project\n");
  const base = f.commit();
  f.put("apps/website/README.md", "# Website\n");
  f.put("docs/website.md", "# Website development\n");
  const docs = f.commit();
  assert.equal(
    f.runWithEnv(pullRequest, "classify", base, docs).stdout.trim(),
    "docs",
  );
  f.put("apps/website/src/main.ts", "export {};\n");
  assert.equal(
    f.runWithEnv(pullRequest, "classify", base, f.commit()).stdout.trim(),
    "website",
  );
});

test("website PR rejects dependency manifests, any lock files and undeclared inputs", (t) => {
  for (const path of [
    "apps/website/package.json",
    "apps/website/pnpm-lock.yaml",
    "apps/website/src/package.json",
    "apps/website/tests/fixtures/package.json",
    "apps/website/src/bower.json",
    "apps/website/src/composer.json",
    "apps/website/src/deno.json",
    "apps/website/tests/jsr.json",
    "apps/website/tests/npm-shrinkwrap.json",
    "apps/website/src/package-lock.json",
    "apps/website/tests/fixtures/lock.json",
    "apps/website/src/yarn.lock",
    "apps/website/src/bun.lockb",
    "apps/website/tests/fixtures/service-lockfile.json",
    "apps/website/src/migrations/001.ts",
    "apps/website/tests/fixtures/migration/001.json",
    "apps/website/scripts/new-tool.mjs",
    "apps/website/public/logo.svg",
    "apps/website/src/template.md",
    "apps/website/tests/fixtures/arbitrary.html",
    "apps/website/unknown.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "packages/contracts/src/index.ts",
    "apps/api/prisma/schema.prisma",
    "apps/admin/src/app.vue",
    "miniprogram/domain/model.ts",
    "miniprogram/assets/book.jpg",
    "design/brand/shiguangli-logo-original.jpg",
    "tools/vite-private-artifacts.ts",
    "scripts/ci/tests.mjs",
    ".github/workflows/check.yml",
  ]) {
    const f = fixture(t);
    f.put("apps/website/src/main.ts", "export {};\n");
    const base = f.commit();
    f.put("apps/website/src/main.ts", "export const changed = true;\n");
    f.put(path, "fixture\n");
    const result = f.runWithEnv(pullRequest, "classify", base, f.commit());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "full", path);
  }
});

test("every main push and unknown event require full including documentation", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Project\n");
  const base = f.commit();
  f.put("docs/guide.md", "# Guide\n");
  const docs = f.commit();
  f.put("apps/website/src/main.ts", "export {};\n");
  const website = f.commit();
  for (const env of [
    { CHECK_EVENT_NAME: "push", CHECK_REF: "refs/heads/main" },
    { CHECK_EVENT_NAME: "push", CHECK_REF: "refs/heads/another" },
    { CHECK_EVENT_NAME: "workflow_dispatch", CHECK_REF: "refs/heads/main" },
    { CHECK_EVENT_NAME: "schedule" },
    {
      CHECK_EVENT_NAME: "pull_request_target",
      CHECK_REF: "refs/pull/76/merge",
    },
    { CHECK_EVENT_NAME: "unknown" },
    { CHECK_REF: "refs/heads/main" },
  ]) {
    for (const head of [docs, website])
      assert.equal(
        f.runWithEnv(env, "classify", base, head).stdout.trim(),
        "full",
        JSON.stringify(env),
      );
  }
  assert.equal(f.run("classify", base, docs).stdout.trim(), "docs");
  assert.equal(f.run("classify", docs, website).stdout.trim(), "full");
  assert.equal(
    f.runWithEnv(pullRequest, "classify", website, website).stdout.trim(),
    "full",
  );
  for (const env of [
    pullRequest,
    { CHECK_EVENT_NAME: "push", CHECK_REF: "refs/heads/main" },
  ])
    assert.notEqual(
      f.runWithEnv(env, "classify", "missing-ref", website).status,
      0,
    );
});

test("website deletion, rename and permission checks include both old and new paths", (t) => {
  for (const kind of [
    "delete-website",
    "delete-shared",
    "rename-website",
    "rename-from-shared",
    "rename-to-shared",
    "executable",
    "remove-executable",
    "symlink",
    "remove-symlink",
  ]) {
    const f = fixture(t);
    f.put("apps/website/src/main.ts", "export {};\n");
    f.put("miniprogram/domain/model.ts", "export {};\n");
    if (kind === "remove-executable")
      chmodSync(join(f.cwd, "apps/website/src/main.ts"), 0o755);
    if (kind === "remove-symlink") {
      rmSync(join(f.cwd, "apps/website/src/main.ts"));
      symlinkSync(
        "../../../miniprogram/domain/model.ts",
        join(f.cwd, "apps/website/src/main.ts"),
      );
    }
    const base = f.commit();
    if (kind === "delete-website") f.git("rm", "apps/website/src/main.ts");
    if (kind === "delete-shared") f.git("rm", "miniprogram/domain/model.ts");
    if (kind === "rename-website")
      f.git("mv", "apps/website/src/main.ts", "apps/website/src/renamed.ts");
    if (kind === "rename-from-shared")
      f.git("mv", "miniprogram/domain/model.ts", "apps/website/src/shared.ts");
    if (kind === "rename-to-shared")
      f.git("mv", "apps/website/src/main.ts", "apps/renamed.ts");
    if (kind === "executable")
      chmodSync(join(f.cwd, "apps/website/src/main.ts"), 0o755);
    if (kind === "remove-executable")
      chmodSync(join(f.cwd, "apps/website/src/main.ts"), 0o644);
    if (kind === "symlink") {
      rmSync(join(f.cwd, "apps/website/src/main.ts"));
      symlinkSync(
        "../../../miniprogram/domain/model.ts",
        join(f.cwd, "apps/website/src/main.ts"),
      );
    }
    if (kind === "remove-symlink") {
      rmSync(join(f.cwd, "apps/website/src/main.ts"));
      f.put("apps/website/src/main.ts", "export {};\n");
    }
    const result = f.runWithEnv(pullRequest, "classify", base, f.commit());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      ["delete-website", "rename-website"].includes(kind) ? "website" : "full",
      kind,
    );
  }
});
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

test("application READMEs use docs checks including their local links", (t) => {
  const f = fixture(t);
  f.put("README.md", "# Project\n");
  const base = f.commit();
  f.put("apps/website/README.md", "# Website\n[Project](../../README.md)\n");
  const head = f.commit();
  assert.equal(f.run("classify", base, head).stdout.trim(), "docs");
  assert.equal(f.run("docs", base, head).status, 0);
  f.put("apps/website/README.md", "# Website\n[Missing](missing.md)\n");
  assert.notEqual(f.run("docs", head, f.commit()).status, 0);
});

test("README routing preserves executable, symlink, resource and old-path boundaries", (t) => {
  for (const kind of [
    "executable",
    "symlink",
    "resource",
    "rename",
    "runtime-markdown",
  ]) {
    const f = fixture(t);
    f.put("README.md", "# Project\n");
    f.put("app.ts", "export {};\n");
    const base = f.commit();
    if (kind === "rename") {
      mkdirSync(join(f.cwd, "apps/website"), { recursive: true });
      f.git("mv", "app.ts", "apps/website/README.md");
    } else if (kind === "symlink") {
      mkdirSync(join(f.cwd, "apps/website"), { recursive: true });
      symlinkSync("../../README.md", join(f.cwd, "apps/website/README.md"));
    } else {
      f.put("apps/website/README.md", "# Website\n");
      if (kind === "executable")
        chmodSync(join(f.cwd, "apps/website/README.md"), 0o755);
      if (kind === "resource") f.put("apps/website/src/logo.svg", "<svg/>\n");
      if (kind === "runtime-markdown")
        f.put("apps/api/src/prompt.md", "Runtime template\n");
    }
    assert.equal(
      f.run("classify", base, f.commit()).stdout.trim(),
      "full",
      kind,
    );
  }
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
  chmodSync(join(f.cwd, "docs/guide.md"), 0o755);
  f.commit();
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
function gateNeeds(mode) {
  return {
    changes: { result: "success", outputs: { mode } },
    docs: { result: mode === "docs" ? "success" : "skipped" },
    build: { result: mode === "full" ? "success" : "skipped" },
    api: { result: mode === "full" ? "success" : "skipped" },
    browser: { result: mode === "full" ? "success" : "skipped" },
    website: { result: mode === "docs" ? "skipped" : "success" },
    full: { result: mode === "full" ? "success" : "skipped" },
  };
}

test("stable gate accepts each complete selected PR mode and enforces every job result", (t) => {
  const f = fixture(t);
  const run = (needs, env = pullRequest) =>
    f.runWithEnv({ ...env, CHECK_NEEDS: JSON.stringify(needs) }, "gate");
  for (const mode of ["docs", "website", "full"]) {
    const needs = gateNeeds(mode);
    assert.equal(run(needs).status, 0, mode);
    for (const job of Object.keys(needs)) {
      for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
        if (result === needs[job].result) continue;
        const changed = structuredClone(needs);
        changed[job].result = result;
        assert.notEqual(run(changed).status, 0, `${mode}/${job}/${result}`);
      }
      const missing = structuredClone(needs);
      delete missing[job];
      assert.notEqual(run(missing).status, 0, `${mode}/missing ${job}`);
    }
    assert.notEqual(
      run({ ...needs, unexpected: { result: "success" } }).status,
      0,
    );
  }
  assert.notEqual(run({}).status, 0);
  for (const changes of [
    { result: "success", outputs: {} },
    { result: "success", outputs: { mode: "unknown" } },
    { result: "success" },
  ]) {
    assert.notEqual(run({ ...gateNeeds("full"), changes }).status, 0);
  }
  assert.notEqual(
    f.runWithEnv({ ...pullRequest, CHECK_NEEDS: "{" }, "gate").status,
    0,
  );
});

test("stable gate rejects lightweight results for main, push and unknown events", (t) => {
  const f = fixture(t);
  const run = (mode, env) =>
    f.runWithEnv(
      { ...env, CHECK_NEEDS: JSON.stringify(gateNeeds(mode)) },
      "gate",
    );
  for (const env of [
    { CHECK_EVENT_NAME: "push", CHECK_REF: "refs/heads/main" },
    { CHECK_EVENT_NAME: "push", CHECK_REF: "refs/heads/another" },
    { CHECK_EVENT_NAME: "workflow_dispatch", CHECK_REF: "refs/heads/main" },
    { CHECK_EVENT_NAME: "schedule" },
    { CHECK_EVENT_NAME: "pull_request_target" },
    { CHECK_EVENT_NAME: "unknown" },
    { CHECK_REF: "refs/heads/main" },
  ]) {
    assert.notEqual(run("docs", env).status, 0, JSON.stringify(env));
    assert.notEqual(run("website", env).status, 0, JSON.stringify(env));
    assert.equal(run("full", env).status, 0, JSON.stringify(env));
  }
  assert.equal(run("docs", {}).status, 0);
  assert.equal(run("full", {}).status, 0);
  assert.notEqual(run("website", {}).status, 0);
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

for (const kind of ["executable", "symlink", "broken-link"]) {
  test(`tab-containing Markdown paths preserve ${kind} checking`, (t) => {
    const f = fixture(t);
    f.put("README.md", "# Example\n");
    const base = f.commit();
    const file = "docs/guide\t.md";
    if (kind === "symlink") {
      mkdirSync(join(f.cwd, "docs"));
      symlinkSync("../README.md", join(f.cwd, file));
    } else {
      f.put(file, "# Guide\n[Missing](missing.md)\n");
      if (kind === "executable") chmodSync(join(f.cwd, file), 0o755);
    }
    const head = f.commit();
    const route = f.run("classify", base, head);
    assert.equal(route.status, 0, route.stderr);
    if (kind === "broken-link") {
      assert.equal(route.stdout.trim(), "docs");
      const result = f.run("docs", base, head);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /guide\t\.md.*missing\.md/);
    } else {
      assert.equal(route.stdout.trim(), "full");
    }
  });
}
