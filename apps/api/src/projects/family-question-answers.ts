import type { Prisma } from "@prisma/client";

// A saved story, rather than an interview or an upload, answers a question.
export async function familyAnswersIn(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  const [stories, interviews, actual] = await Promise.all([
    tx.story.findMany({
      where: { projectId, currentRevisionId: { not: null } },
      orderBy: { createdAt: "asc" },
    }),
    tx.interview.findMany({ where: { projectId } }),
    tx.actualPlanQuestion.findMany({ where: { projectId } }),
  ]);
  return stories.flatMap((story) => {
    const interview = interviews.find((i) => i.id === story.interviewId);
    const source = actual.find((q) => q.id === interview?.actualQuestionId)
      ?.source as { familyQuestionId?: string } | null;
    return source?.familyQuestionId
      ? [
          {
            questionId: source.familyQuestionId,
            storyId: story.id,
            revisionId: story.currentRevisionId!,
            included: story.included,
          },
        ]
      : [];
  });
}
