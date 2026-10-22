import test from "node:test";
import assert from "node:assert/strict";
import {
  sampleProject,
  confirmStory,
  editStory,
  readyToPrint,
  touch,
  validAddress,
  createProject,
} from "../miniprogram/domain/model";
function confirmedProject() {
  const p = sampleProject();
  p.stories.forEach((s) => confirmStory(p, s.id));
  p.contentApproved = p.revision;
  p.layoutApproved = p.revision;
  return p;
}
test("a new purchase has no consent or inherited stories", () => {
  const p = createProject("爸爸");
  assert.equal(p.title, "爸爸的一生");
  assert.equal(p.consent, false);
  assert.deepEqual(p.stories, []);
  assert.equal(readyToPrint(p), false);
});
test("printing requires all story and both manuscript confirmations", () => {
  const p = sampleProject();
  p.contentApproved = p.revision;
  p.layoutApproved = p.revision;
  assert.equal(readyToPrint(p), false);
  confirmStory(p, p.stories[2].id);
  assert.equal(readyToPrint(p), false);
  p.contentApproved = p.revision;
  assert.equal(readyToPrint(p), false);
  p.layoutApproved = p.revision;
  assert.equal(readyToPrint(p), true);
});
test("editing revokes story and manuscript consent, original recordings remain intact", () => {
  const p = confirmedProject(),
    s = p.stories[0];
  s.recordings = [
    { id: "r1", path: "local-file", duration: 1200, question: "童年" },
  ];
  editStory(p, s.id, s.title, s.body + "\n修改");
  assert.equal(s.version, 2);
  assert.equal(s.confirmedVersion, null);
  assert.equal(p.contentApproved, null);
  assert.equal(p.layoutApproved, null);
  assert.equal(readyToPrint(p), false);
  assert.equal(s.recordings[0].path, "local-file");
});
test("unchanged save preserves valid confirmations", () => {
  const p = confirmedProject(),
    s = p.stories[0],
    revision = p.revision;
  editStory(p, s.id, s.title, s.body);
  assert.equal(p.revision, revision);
  assert.equal(readyToPrint(p), true);
});
test("excluding or changing book content invalidates manuscript approval", () => {
  const p = confirmedProject();
  p.stories[0].included = false;
  touch(p);
  assert.equal(readyToPrint(p), false);
  assert.equal(p.stories[0].confirmedVersion, 1);
});
test("an empty book cannot be printed even if confirmation flags exist", () => {
  const p = confirmedProject();
  p.stories.forEach((s) => (s.included = false));
  assert.equal(readyToPrint(p), false);
});
test("address validation rejects missing and malformed delivery data", () => {
  assert.equal(
    validAddress({
      name: "测试收件人",
      phone: "13800000000",
      detail: "测试省测试市测试路1号",
    }),
    true,
  );
  assert.equal(
    validAddress({
      name: "",
      phone: "13800000000",
      detail: "测试省测试市测试路1号",
    }),
    false,
  );
  assert.equal(
    validAddress({
      name: "测试",
      phone: "123",
      detail: "测试省测试市测试路1号",
    }),
    false,
  );
});
