import type {
  FamilyQuestion,
  PersonalPlan,
} from "../../packages/contracts/src";
import { familyQuestionSource } from "./family-question-source";
import { sessionClient } from "./session";
export interface RecommendedQuestion {
  id: string;
  kind: "family" | "outline";
  key: string;
  text: string;
  source: string;
  chapterKey: string | null;
}
export class QuestionRecommendations {
  private seen = new Set<string>();
  private deferred = new Set<string>();
  private currentId = "";
  private position = 0;
  private questions: RecommendedQuestion[] = [];
  constructor(private readonly random: () => number = Math.random) {}
  update(plan: PersonalPlan, family: FamilyQuestion[]) {
    this.questions = [
      ...family
        .filter((q) => !q.story && q.state !== "skipped")
        .map((q) => ({
          id: `family:${q.id}`,
          kind: "family" as const,
          key: q.id,
          text: q.text,
          source: familyQuestionSource(q),
          chapterKey: q.chapterKey,
        })),
      ...plan.chapters.flatMap((ch) =>
        ch.questions
          .filter(
            (q) =>
              !plan.answers.some((a) => a.questionKey === q.key) &&
              !["skipped", "not-applicable"].includes(
                plan.questionStates.find((s) => s.questionKey === q.key)
                  ?.state ?? "ready",
              ) &&
              ![q.key, ...q.sensitivityTags].some((tag) =>
                plan.preferences.blockedTopics.includes(tag),
              ),
          )
          .map((q) => ({
            id: `outline:${q.key}`,
            kind: "outline" as const,
            key: q.key,
            text: q.text,
            source: `大纲 · ${ch.title}`,
            chapterKey: ch.key,
          })),
      ),
    ];
    return this.current();
  }
  current() {
    return (
      this.questions.find(
        (q) => q.id === this.currentId && !this.deferred.has(q.id),
      ) ?? this.next()
    );
  }
  next() {
    let available = this.questions.filter(
      (q) => !this.deferred.has(q.id) && !this.seen.has(q.id),
    );
    if (!available.length) {
      this.seen.clear();
      this.position = 0;
      available = this.questions.filter((q) => !this.deferred.has(q.id));
    }
    const kind = this.position % 3 === 2 ? "outline" : "family";
    const preferred = available.filter((q) => q.kind === kind);
    const pool = preferred.length ? preferred : available;
    const q = pool[Math.floor(this.random() * pool.length)] ?? null;
    this.currentId = q?.id ?? "";
    if (q) {
      this.seen.add(q.id);
      this.position++;
    }
    return q;
  }
  defer(id: string) {
    this.deferred.add(id);
    if (this.currentId === id) this.currentId = "";
  }
  restore(id: string) {
    this.seen.delete(id);
  }
}
let active:
  { key: string; recommendations: QuestionRecommendations } | undefined;
export function questionSession(projectId: string) {
  const key = `${sessionClient.context()}:${projectId}`;
  if (active?.key !== key)
    active = { key, recommendations: new QuestionRecommendations() };
  return active.recommendations;
}
export function resetQuestionSession() {
  active = undefined;
}
