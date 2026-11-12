// Run against an already opened isolated native package and real local API.
// Reuses the MP05 official CLI adapter. No page data or HTTP response injection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP05/harness/native.cjs");
const capturesFile = path.join(h.evidence, "native-design-captures.json");
function state() {
  return h.evaluate(function () {
    const p = getCurrentPages().slice(-1)[0];
    return { route: p.route, projectId: p.projectId, data: p.data };
  });
}
function ready(name, condition = () => true) {
  for (let n = 0; n < 20; n++) {
    const p = state(),
      d = p.data;
    if (
      p.route === `pages/${name}/index` &&
      !d.busy &&
      !d.loading &&
      !d.pageLoading &&
      condition(d)
    ) {
      assert.ok(!d.status, d.status);
      return d;
    }
  }
  throw Error(`Native page ${name} did not reach its expected state`);
}
function capture(board, entry, interaction) {
  const { windowWidth: width, windowHeight: height } = h.evaluate(function () {
    return wx.getWindowInfo();
  });
  assert.ok([390, 320].includes(width), `Actual native viewport is ${width}px`);
  const current = state();
  assert.ok(!current.data.pageLoading, "Initial skeleton has not finished");
  h.snap(board, width);
  const rows = fs.existsSync(capturesFile)
    ? JSON.parse(fs.readFileSync(capturesFile))
    : [];
  rows.push({
    board,
    width,
    height,
    route: current.route,
    entry,
    interaction,
    screenshot: `${board}-${width}.png`,
    environment:
      "Official WeChat DevTools; real isolated API/PostgreSQL/Redis; external supplier fixtures",
    visualComparison: "pending",
  });
  fs.writeFileSync(capturesFile, JSON.stringify(rows, null, 2));
}
function home() {
  h.tool("automation_navigate", {
    action: "switchTab",
    url: "/pages/home/index",
  });
  const d = ready("home", (d) => !!d.overview);
  assert.equal(
    d.overview.projectId,
    h.projectId,
    "Select the intended isolated project through My Gifts first",
  );
  return d;
}
function family() {
  const d = home();
  capture(
    d.overview.summary.confirmed ? "HomeActive" : "HomeEmpty",
    "My Gifts → selected book → Home",
    "Story, photo and family question counts returned by the real API",
  );
  h.tap(".home-family");
  let list = ready("family-questions");
  capture(
    list.questions.length ? "FamilyQuestions" : "FamilyQuestionsEmpty",
    "Home → family questions",
    "The native list is filtered from the project API",
  );
  h.tap(".tn-dock .tn-button");
  const draft = ready("family-question-edit");
  capture(
    "FamilyQuestionNew",
    "Family questions → ask a question",
    "Optional chapter remains unset; author relationship is required when missing",
  );
  if (draft.needsRelationship) h.tap('.relation[data-value="女儿"]');
  const question = "家里最让你难忘的一个瞬间是什么？";
  h.input(".question-input", question);
  h.tap(".tn-dock .tn-button");
  const detail = ready("family-question", (d) => !!d.question);
  assert.equal(detail.question.text, question);
  assert.equal(detail.question.chapterKey, null);
  capture(
    "FamilyQuestionDetail",
    "New question → publish",
    "Real saved question, original author and optional chapter returned from API",
  );
  h.tap('[data-state="later"]');
  ready("family-question", (d) => d.question.state === "later");
  h.back();
  ready("family-questions", (d) =>
    d.questions.some((q) => q.id === detail.question.id && q.state === "later"),
  );
  h.tap('[data-tab="answered"]');
  list = ready("family-questions", (d) => d.tab === "answered");
  assert.ok(
    list.questions.length,
    "Seed an answered family question using the existing MP06 API fixture",
  );
  h.tap(".family-card");
  ready("family-question", (d) => !!d.question?.story);
  capture(
    "FamilyQuestionAnswered",
    "Family questions → answered → question",
    "Completed answer links to its real saved story",
  );
  h.tap(".family-answer");
  ready("story", (d) => !!d.story?.revision);
}
function stories() {
  home();
  h.tap(".home-statistics button:nth-child(1)");
  ready("stories", (d) => d.rows.length > 0);
  capture(
    "Stories",
    "Home → story count",
    "List and placement come from current project stories",
  );
  h.tap(".story-card");
  let d = ready("story", (d) => !!d.story?.revision);
  const original = d.story.revision.title;
  capture(
    d.placement === "未归章" ? "StoryUnassigned" : "Story",
    "Stories → story card",
    "Real body, audio sources, photos and current placement",
  );
  h.tap(".story-edit");
  ready("edit-story");
  capture(
    "StoryEdit",
    "Story → edit text",
    "Original audio remains unchanged when text is edited",
  );
  h.input(".tn-input", original + " · 原生走查");
  h.tap(".tn-dock .tn-button");
  d = ready(
    "story",
    (d) => d.story?.revision?.title === original + " · 原生走查",
  );
  h.tap(".story-placement");
  ready("assign-story", (d) => d.chapters.length > 0);
  capture(
    "AssignStory",
    "Story → chapter",
    "Current shared chapters are selectable",
  );
  h.back();
  ready("story");
}
function cover() {
  home();
  h.tap(".home-book-entry");
  let d = ready("book", (d) => !!d.context);
  const original = d.title;
  capture(
    d.screen === "empty"
      ? "BookEmpty"
      : d.screen === "changed"
        ? "BookChanged"
        : d.screen === "failed"
          ? "BookGenerateFailed"
          : "BookOverview",
    "Home → book cover",
    "State comes from the real book context",
  );
  if (d.screen === "changed") {
    h.tap(".tn-dock .tn-link");
    d = ready("book", (d) => d.screen !== "changed");
  }
  assert.notEqual(
    d.screen,
    "failed",
    "Retry the failed render before editing its cover",
  );
  h.tap(d.screen === "empty" ? ".book-display" : ".book-preview");
  ready("cover");
  capture(
    "BookCover",
    "Book → edit cover",
    "Title, message and photo form one unsaved draft",
  );
  h.input("#cover-title", original + " · 未保存");
  h.back();
  d = ready("book", (d) => !!d.context);
  assert.equal(
    d.title,
    original,
    "Cancel must leave the saved title unchanged",
  );
  if (d.ready) {
    h.tap(".tn-dock .tn-button");
    ready("manuscript", (d) => d.version?.state === "ready");
    capture(
      "BookReader",
      "Ready book → PDF manuscript",
      "Frozen version is loaded; system viewer is a separate native action",
    );
  }
}
const flows = { family, stories, cover };
const command = process.argv[2];
if (command === "capture") {
  const [board, entry, interaction] = process.argv.slice(3);
  assert.ok(
    board && entry && interaction,
    "capture requires board, actual entry and observed interaction",
  );
  capture(board, entry, interaction);
} else {
  assert.ok(
    flows[command],
    "Use family, stories, cover, or capture <board> <entry> <observed interaction>",
  );
  h.step(`current API native ${command} journey`, flows[command]);
}
