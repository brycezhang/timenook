const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readPaidProjectInput } = require("../scripts/native-mvp.cjs");

test("paid-project mode requires an explicit restricted input and accepts only its order and project IDs", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "timenook-paid-project-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.json");
  const input = {
    orderId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
  };
  await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
  assert.deepEqual(await readPaidProjectInput(file), input);
  await fs.chmod(file, 0o644);
  await assert.rejects(
    readPaidProjectInput(file),
    /restricted paid-project input/,
  );
  await assert.rejects(
    readPaidProjectInput(""),
    /restricted paid-project input/,
  );
});

test("paid-project mode rejects malformed input without falling back to an internal purchase", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "timenook-paid-project-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.json");
  for (const input of [
    "{",
    JSON.stringify({ orderId: "invalid", projectId: "invalid" }),
    JSON.stringify({
      orderId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      token: "disallowed",
    }),
  ]) {
    await fs.writeFile(file, input, { mode: 0o600 });
    await assert.rejects(
      readPaidProjectInput(file),
      /restricted paid-project input/,
    );
  }
});

test("paid continuation accepts only the server verified one-fen WeChat order for the requested project", () => {
  const { requirePaidProject } = require("../scripts/native-mvp.cjs");
  const input = {
    orderId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
  };
  const order = {
    id: input.orderId,
    state: "paid",
    mode: "wechat",
    listAmount: 99900,
    amount: 1,
    isE2e: true,
    project: { id: input.projectId },
  };
  assert.equal(requirePaidProject(order, input), input.projectId);
  for (const change of [
    { state: "pending" },
    { mode: "local-verification" },
    { amount: 99900, isE2e: false },
    { id: "33333333-3333-4333-8333-333333333333" },
    { project: { id: "44444444-4444-4444-8444-444444444444" } },
  ])
    assert.throws(
      () => requirePaidProject({ ...order, ...change }, input),
      /verified one-fen WeChat order/,
    );
});
