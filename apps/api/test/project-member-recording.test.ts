import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { startBookFixture, stopBookFixture, readyStory } from "./book-fixture";
before(startBookFixture);
after(stopBookFixture);
test("two saved clips automatically produce one current story without consent or manual organization", async () => {
  const p = await readyStory();
  assert.equal(p.story.task.sources.length, 2);
  assert.ok(p.story.revision);
});
