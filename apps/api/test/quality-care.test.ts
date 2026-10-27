import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  startBookFixture,
  stopBookFixture,
  request,
  data,
  login,
} from "./book-fixture";
import { deliveredQualityOrder, adminRequest } from "./quality-fixture";
before(startBookFixture);
after(stopBookFixture);
test("buyer submits quality evidence against the delivered original and sees the same private shared case after replay", async () => {
  const p = await deliveredQualityOrder(),
    key = randomUUID(),
    body = {
      attemptId: p.attempt.id,
      reason: "qualityMissingPages",
      description: "合成书第十页缺失，申请核对原版。",
    };
  assert.equal((await request("GET", p.qualityBase)).statusCode, 401);
  assert.equal(
    (await request("GET", p.qualityBase, (await login()).token)).statusCode,
    404,
  );
  const created = data(
    await request("POST", p.qualityBase, p.buyer.token, body, key),
  );
  assert.equal(created.reason, "qualityMissingPages");
  assert.equal(created.state, "requested");
  assert.equal(created.original.pdfHash, p.binding.pdfHash);
  assert.equal(created.original.attemptId, p.attempt.id);
  assert.equal(created.description, undefined);
  assert.equal(created.address, undefined);
  const replay = data(
    await request("POST", p.qualityBase, p.buyer.token, body, key),
  );
  assert.equal(replay.id, created.id);
  assert.equal(
    (
      await request(
        "POST",
        p.qualityBase,
        p.buyer.token,
        { ...body, description: "另一证据" },
        key,
      )
    ).statusCode,
    409,
  );
  const list = data(await request("GET", p.qualityBase, p.buyer.token), 200);
  assert.equal(list.requests[0].id, created.id);
  assert.equal(list.attempts[0].id, p.attempt.id);
  const cases = data(
    await adminRequest("GET", "/v1/admin/care-requests", p.headers),
    200,
  );
  assert.ok(
    cases.requests.some(
      (c: any) => c.id === created.caseId && c.kind === "quality",
    ),
  );
});
