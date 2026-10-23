import type {
  PersonalPlan,
  PlanContent,
  PlanQuestionState,
} from "../../../packages/contracts/src";
import { personalPlanClient } from "../../services/personal-plan";
import { sessionClient, ApiFailure } from "../../services/session";
import { dataMode, setDataMode } from "../../services/mode";
import { go } from "../../services/store";
import { paymentKey } from "../../services/payments";
type E = {
  currentTarget: { dataset: Record<string, string> };
  detail: { value: string };
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
Page({
  data: {
    plan: null as PersonalPlan | null,
    draft: null as PlanContent | null,
    busy: false,
    dirty: false,
    status: "",
    topic: "",
    loggedIn: false,
  },
  projectId: "",
  generation: 0,
  timer: 0 as ReturnType<typeof setTimeout> | 0,
  onLoad(q) {
    this.projectId = q.projectId ?? "";
    setDataMode("live");
  },
  onShow() {
    return this.refresh();
  },
  onHide() {
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.setData({
      plan: null,
      draft: null,
      busy: false,
      dirty: false,
      topic: "",
    });
  },
  onUnload() {
    this.onHide();
  },
  current(generation: number, context: string) {
    return (
      generation === this.generation &&
      dataMode() === "live" &&
      context === sessionClient.context()
    );
  },
  armPrivacy(context: string) {
    if (this.timer) clearTimeout(this.timer);
    const check = () => {
      const expiresAt = this.data.plan?.accessExpiresAt;
      if (
        dataMode() !== "live" ||
        context !== sessionClient.context() ||
        (expiresAt && Date.parse(expiresAt) <= Date.now())
      ) {
        this.onHide();
        this.setData({
          loggedIn: !!sessionClient.context(),
          status: "授权已到期或账号已变化，请重新查询",
        });
      } else this.timer = setTimeout(check, 1000);
    };
    this.timer = setTimeout(check, 1000);
  },
  accept(plan: PersonalPlan, context: string, resetDraft = true) {
    if (plan.accessExpiresAt && Date.parse(plan.accessExpiresAt) <= Date.now())
      throw new Error("当次授权已到期，请重新取得本人许可");
    this.setData({
      plan,
      ...(resetDraft
        ? {
            draft: copy({ chapters: plan.chapters, starters: plan.starters }),
            dirty: false,
          }
        : {}),
    });
    this.armPrivacy(context);
  },
  async perform(
    work: (generation: number, context: string) => Promise<void>,
    keepConflictDraft = false,
  ) {
    if (this.data.busy) return;
    const generation = ++this.generation,
      context = sessionClient.context();
    this.setData({ busy: true, status: "", loggedIn: !!context });
    try {
      await work(generation, context);
    } catch (error) {
      if (generation !== this.generation || dataMode() !== "live") return;
      if (context !== sessionClient.context()) {
        this.setData({
          plan: null,
          draft: null,
          dirty: false,
          loggedIn: !!sessionClient.context(),
          status: "登录已失效或账号已变化，请重新查询",
        });
      } else if (
        error instanceof ApiFailure &&
        error.status === 409 &&
        keepConflictDraft
      ) {
        this.setData({
          status:
            "编辑冲突：保留了你的修改。请重新查询并比较后再编辑，未保存的修改不会自动覆盖另一方。",
        });
      } else {
        this.setData({
          plan: null,
          draft: null,
          dirty: false,
          status:
            error instanceof Error
              ? `操作未确认，请重新查询。${error.message}`
              : "操作未确认，请重新查询",
        });
      }
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  async refresh() {
    return this.perform(async (generation: number, context: string) => {
      this.setData({ plan: null, draft: null, dirty: false });
      const plan = await personalPlanClient.read(this.projectId);
      if (this.current(generation, context)) this.accept(plan, context);
    });
  },
  async login() {
    return this.perform(async () => {
      await sessionClient.login();
      this.setData({ loggedIn: true, status: "已登录，请重新查询计划" });
    });
  },
  edit(work: (draft: PlanContent) => void) {
    if (!this.data.draft || this.data.busy) return;
    const draft = copy(this.data.draft);
    work(draft);
    this.setData({ draft, dirty: true });
  },
  chapterTitle(e: E) {
    this.edit((d: PlanContent) => {
      const c = d.chapters[Number(e.currentTarget.dataset.chapter)];
      if (c) c.title = e.detail.value;
    });
  },
  questionText(e: E) {
    this.edit((d: PlanContent) => {
      const q =
        d.chapters[Number(e.currentTarget.dataset.chapter)]?.questions[
          Number(e.currentTarget.dataset.question)
        ];
      if (q) q.text = e.detail.value;
    });
  },
  addChapter() {
    this.edit((d: PlanContent) =>
      d.chapters.push({
        key: `custom-${paymentKey()}`,
        title: "新章节",
        questions: [],
      }),
    );
  },
  removeChapter(e: E) {
    this.edit((d: PlanContent) =>
      d.chapters.splice(Number(e.currentTarget.dataset.chapter), 1),
    );
  },
  moveChapter(e: E) {
    this.edit((d: PlanContent) => {
      const i = Number(e.currentTarget.dataset.chapter),
        j = i + Number(e.currentTarget.dataset.direction);
      if (j >= 0 && j < d.chapters.length)
        [d.chapters[i], d.chapters[j]] = [d.chapters[j], d.chapters[i]];
    });
  },
  addQuestion(e: E) {
    this.edit((d: PlanContent) =>
      d.chapters[Number(e.currentTarget.dataset.chapter)]?.questions.push({
        key: `custom-${paymentKey()}`,
        text: "我想说的一件事",
        intent: "由本人选择的自拟问题",
        optionalContext: [],
        sensitivityTags: [],
        followupCandidates: [],
        locale: "zh-CN",
      }),
    );
  },
  removeQuestion(e: E) {
    this.edit((d: PlanContent) =>
      d.chapters[Number(e.currentTarget.dataset.chapter)]?.questions.splice(
        Number(e.currentTarget.dataset.question),
        1,
      ),
    );
  },
  moveQuestion(e: E) {
    this.edit((d: PlanContent) => {
      const qs = d.chapters[Number(e.currentTarget.dataset.chapter)]?.questions,
        i = Number(e.currentTarget.dataset.question),
        j = i + Number(e.currentTarget.dataset.direction);
      if (qs && j >= 0 && j < qs.length) [qs[i], qs[j]] = [qs[j], qs[i]];
    });
  },
  clearPlan() {
    this.edit((d: PlanContent) => {
      d.chapters = [];
    });
  },
  async save() {
    const { plan, draft } = this.data;
    if (!plan || !draft) return;
    return this.perform(async (generation: number, context: string) => {
      const saved = await personalPlanClient.revise(plan, draft);
      if (this.current(generation, context)) {
        this.accept(saved, context);
        this.setData({
          status: "个人计划已保存；已回答内容和本人偏好继续保留。",
        });
      }
    }, true);
  },
  async decision(e: E) {
    const plan = this.data.plan;
    if (!plan?.subjectDecision) return;
    const key = e.currentTarget.dataset.key,
      value = e.currentTarget.dataset.state;
    const states = plan.questionStates.filter((row) => row.questionKey !== key);
    if (["ready", "later", "skipped", "not-applicable"].includes(value))
      states.push({
        questionKey: key,
        state: value as PlanQuestionState["state"],
      });
    else return;
    return this.saveDecision(states, plan.preferences.blockedTopics);
  },
  topicInput(e: E) {
    this.setData({ topic: e.detail.value });
  },
  async blockTopic() {
    const p = this.data.plan,
      topic = this.data.topic.trim();
    if (p && topic && !p.preferences.blockedTopics.includes(topic))
      return this.saveDecision(p.questionStates, [
        ...p.preferences.blockedTopics,
        topic,
      ]);
  },
  async unblockTopic(e: E) {
    const p = this.data.plan;
    if (p)
      return this.saveDecision(
        p.questionStates,
        p.preferences.blockedTopics.filter(
          (topic) => topic !== e.currentTarget.dataset.topic,
        ),
      );
  },
  async saveDecision(states: PlanQuestionState[], topics: string[]) {
    const plan = this.data.plan;
    if (!plan?.subjectDecision) return;
    return this.perform(async (generation: number, context: string) => {
      const saved = await personalPlanClient.decide(plan, states, topics);
      if (this.current(generation, context)) {
        this.accept(saved, context, false);
        this.setData({ status: "本人的回答选择已保存。", topic: "" });
      }
    }, true);
  },
  back() {
    go("welcome", `projectId=${this.projectId}`);
  },
});
