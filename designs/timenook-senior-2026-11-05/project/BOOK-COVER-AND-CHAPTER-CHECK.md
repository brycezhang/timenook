# 书封与章节功能核对

2026-11-05。已获取当前 origin/main，提交仍为 `473fb6b23be0091793e6219540c8b5c8a8e0d001`。以下是源码核对，不是新功能的微信运行验收。本轮仅修改设计稿和说明。

## 章节选择：已有实现，保留设计入口

- 原生页面直接渲染每章的可选故事与已选故事，并绑定选择及上下移：[主分支 book/index.wxml](https://github.com/brycezhang/timenook/blob/473fb6b23be0091793e6219540c8b5c8a8e0d001/miniprogram/pages/book/index.wxml#L54)。
- `updateDraftRows` 从 `eligibleStories` 生成候选，以 `storyRefs` 标记已选；`assignStory` 选择/移出，先移除所有章节中的旧引用，再加入目标章节；`moveStory` 调整章内顺序；`saveDirectory` 调用接口保存。主分支对应 `miniprogram/pages/book/index.ts:411–509`，尤其 472、483、493 行。
- 服务端 `apps/api/src/projects/project-plans.ts:215–229` 校验同一故事不能重复出现在多个章节。

因此保留「调整本章故事」，它不是新增的业务能力。现有小程序将它放在目录编辑区域；设计稿将它放在章节正文内的独立二级页，以保持简洁。点击章节仍然直接显示可编辑正文。

## 封面选择：已有能力，补足设计呈现

- `miniprogram/pages/book/index.wxml:43–48` 已有封面照片选择与“不使用封面照片”，当前实现以文字按钮列出候选。
- `miniprogram/pages/book/index.ts:345–405` 根据 `coverPhotoOptions` 标记选中、更新封面草稿并保存。
- `apps/api/src/books/books.ts:343–354` 从可入书故事照片中合并去重，保存时在 919–925 行校验候选。不是任意图片或独立封面模板列表。

设计稿调整：
1. 25「调整书封」直接显示已选图片；无图显示文字封面状态。
2. 新增 25a「选择封面照片」，展示可用照片、当前选择及不用照片入口。
3. 点选照片直接返回书封，保留书名与称呼；保存后总览显示新封面，重新生成的书稿封面使用该图片。
4. 无可用照片时说明先在故事中添加；不新增直接上传、裁切或模板商城。
5. 受邀成员、自动上传和直接印刷等上轮规则不变。

本次完成 Baoyu Canvas 文件结构检查；未新增浏览器、原生小程序或真实服务验收。
