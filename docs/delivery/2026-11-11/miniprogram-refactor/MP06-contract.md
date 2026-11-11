# MP06 家人提问与录音输入契约

家人文字问题独立于大纲问题，API 路径均位于 `/v1` 下。

- `GET /projects/:id/family-questions` 返回 `FamilyQuestions {projectId, questions}`；`GET /:questionId` 返回单题。`FamilyQuestion` 含文字、可空 `chapterKey`、版本、原 `authorId/authorNickname/authorRelationship`、`state: ready|later|skipped`、可空 `story:{id,title}`。
- 创建 `POST /projects/:id/family-questions` 接 `{clientQuestionId,text,chapterKey}`。文字 1–2000 字，章节可空；关系缺失先沿用 MP04 `/member-profile` 补填。作者取当前账号及已保存主讲人视角关系，后续编辑不更换作者。传相同 clientQuestionId 重试创建不会增加问题。
- 编辑 `POST /:questionId` 接 `{expectedVersion,text,chapterKey}`；状态 `POST /:questionId/state` 接 `{expectedVersion,state}`；移除 `POST /:questionId/remove` 接 `{expectedVersion}`。移除沿用资料删除保留外壳的约束，列表不再返回，原声、故事、实际提问快照继续保留。
- `POST /projects/:id/interviews` 新增互斥输入 `familyQuestionId`，与既有 `questionKey/starterKind/selfWritten` 四选一，保留 `clientInterviewId/expectedPlanRevision`。返回 `actualQuestion.source.kind='family'` 及 `familyQuestionId/authorId/authorNickname/authorRelationship/chapterKey?`。`snapshot.text` 是当时问题，`capturedBy` 是录音操作者。
- 采访创建不算回答；只有已完成并保存了 `StoryRevision` 的故事才出现在问题的 `story`。无章回答保持未归章；问题改章与已保存故事移章同步，移除章不删故事。
- 小程序 `family-questions.ts` 暴露 `familyQuestionClient`、`familyQuestionSource`、`startFamilyAnswer(projectId, revision, id)`。后者建立采访后进入 `interview?projectId=...&interviewId=...&prepare=1`；MP09 可直接消费返回的实际提问来源，不能拿 capturedBy 当原作者。
- `question-recommendations.ts` 的 `questionSession(projectId)` 消费当前 PersonalPlan 和 FamilyQuestion 列表。首次家人优先，2 家人/1 大纲、类内随机，本轮不重；`defer('family:'+id)` 或 `defer('outline:'+key)` 在本次进入内排除。`resetQuestionSession()` 只在重新进入故事书时调用，轮次重开不能清除 defer。返回 `RecommendedQuestion {id,kind,key,text,source,chapterKey}`。
- `ProjectOverview.summary.photos` 是已封存项目照片数，`audioMinutes` 是真实已保存原声的整数分钟（向下取整）；故事数使用已有 `summary.confirmed`。

工程与真实运行验收分别登记。本契约允许 MP09 并行开发；尚未声称微信原生画板、真机录音或供应商验收通过。
