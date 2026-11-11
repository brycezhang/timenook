export interface FamilyQuestion {
  id: string;
  projectId: string;
  version: number;
  text: string;
  chapterKey: string | null;
  authorId: string;
  authorNickname: string;
  authorRelationship: string;
  state: "ready" | "later" | "skipped";
  createdAt: string;
  story: { id: string; title: string } | null;
}
export interface FamilyQuestions {
  projectId: string;
  questions: FamilyQuestion[];
}
