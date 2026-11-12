# 小程序全量重构 · 模块实施

发布进度：PR 已合并，关联票据已关闭，0.4.0 已上传且配套后端已部署。体验版标记、真机与实际资金仍分别待验，见 [0.4.0 发布记录](release-0.4.0.md)。以下为合并前工程交付记录。

状态：[父规格 #166](https://github.com/brycezhang/timenook/issues/166) 与 12 张子票均已实现，汇入 [PR #179](https://github.com/brycezhang/timenook/pull/179)。正式包为 37 条原生路由。71 张设计状态中，70 个应用状态完成开发者工具 390×844／320×568 对照及对应交互，另 1 个 PDF 状态完成系统调用和真实文件内容验证；逐项范围见[验收映射](design-map.json)与[最终观测记录](evidence/MP12/native-final-acceptance.json)。

真实本地 API、PostgreSQL 与 Redis 已走通送礼／自购／指定领取、礼物三分类、家人文字提问、六章目录、语音与照片、故事随时归章、PDF 与制作寄送。原生走查中的权限恢复、录音选图往返、上传丢响应重试、音频进度拖动、章节与故事拖排、封面草稿保留、地址首项确认、制作未知结果恢复同一订单均已复验。最新故事展示修正后的失败／整理中状态已重新双宽采集；不受影响的既有证据继续复用。

正式包构建与官方 wcc／wcsc 编译通过。前一检查点 `910fec5` 的[必需 CI 通过](https://github.com/brycezhang/timenook/actions/runs/43233986123)，最终提交的检查以 PR 当前结果为准。真机手机号授权、物理麦克风、实际支付与供应商、微信分享扫码、手机 PDF 查看器、印厂物流及实物交付仍待实际验收。开发者工具委托 macOS 查看 PDF 的结果不等于手机查看器验证；硬件与外部供应商夹具边界均写入各票证据。本轮未部署、上传体验版或提审。

基线：`149b1b6`，原画布 71 张页面／状态、11 组，基线正式构建为 29 条原生路由。71 张画板分别对应实际页面、同页状态、弹窗或系统 PDF 内容，不要求创建 71 条路由。

用户于 2026-11-11 明确：按最新版业务流程和设计完整重构小程序，UI 与交互一对一验证；开发阶段前后端及数据库可以破坏性更新，不做兼容处理，按模块拆票推进。

- [实施规格](spec.md)
- [GitHub 票据与依赖编号](issues.json)
- [71 张画板对照与验收表](DESIGN-MAP.md)
- [MP01 原生入口与账号证据](MP01-evidence.md)
- [MP12 全量原生验收与旧入口清理](MP12-delivery.md)
- [390／320 设计参考图](design-reference/README.md)
- [原始 18 项实现差异](../miniprogram-design-gap.md)
- [当前业务流程](../../../../designs/timenook-modern-2026-11-10/project/BUSINESS-FLOW.md)
- [当前画布](../../../../designs/timenook-modern-2026-11-10/project/canvas.json)

## 拆分与依赖

每票包含其业务所需的数据、接口、原生 UI 和验证。编号用于模块标识，实际按依赖顺序实施和发布票据。依赖表示本票需要上游的实现契约；外部真机或供应商待验不统一阻断可独立开展的工程工作。

| 票据 | 可操作结果 | 阻塞依赖 | 主责画板 |
| --- | --- | --- | --- |
| [MP01 公开入口、登录与我的](tickets/MP01-entry-login.md) · [#167](https://github.com/brycezhang/timenook/issues/167) | 从公开首页查看样书、原地登录、继续原操作，并在「我的」修改昵称和退出；同步建立后续页面复用的白底导航、控件和底栏。 | 无 | 6 |
| [MP02 统一购买、付款与送给自己](tickets/MP02-purchase-self-gift.md) · [#168](https://github.com/brycezhang/timenook/issues/168) | 用户从统一送礼入口选择关系与书名、付款；送给自己直接进入自己的故事书，送给他人进入购买成功后的礼物设置。 | MP01 | 6 |
| [MP03 指定手机号发卡与领取礼物](tickets/MP03-designated-gift.md) · [#169](https://github.com/brycezhang/timenook/issues/169) | 送礼人指定号码并分享礼物卡；指定收礼人验证手机号、明确领取后进入原故事书。 | MP02 | 8 |
| [MP04 礼物三分类、切换故事书与家人邀请](tickets/MP04-gifts-members.md) · [#170](https://github.com/brycezhang/timenook/issues/170) | 用户从送出、收到、参与找到正确的故事书；购买者邀请家人，家人填写相对主讲人的关系后加入。 | MP03 | 6 |
| [MP05 六章大纲目录与问题管理](tickets/MP05-outline-directory.md) · [#171](https://github.com/brycezhang/timenook/issues/171) | 新故事书初始化六章六十题，用户在同一目录中编辑章节、问题和章内故事顺序，选题后回答归入对应章节。 | MP01 | 6 |
| [MP06 家人提问、混合推荐与故事书首页](tickets/MP06-family-recommendation.md) · [#173](https://github.com/brycezhang/timenook/issues/173) | 家人文字提问，主讲人从首页优先看到家人问题并语音回答；问题在故事完成后显示回答结果。 | MP04、MP05、MP07 | 7 |
| [MP07 项目照片与从照片开始讲述](tickets/MP07-project-photos.md) · [#172](https://github.com/brycezhang/timenook/issues/172) | 没有故事也能向项目添加照片；用户浏览照片、选图开讲，讲述、故事与封面共享同一项目素材。 | MP01 | 1 |
| [MP08 故事编辑、回听与随时归章](tickets/MP08-stories-assignment.md) · [#174](https://github.com/brycezhang/timenook/issues/174) | 用户查看和编辑真实故事、拖动进度条回听，并把未归章故事随时归入任一章节或跨章移动。 | MP05、MP07 | 8 |
| [MP09 语音讲述、照片操作与可靠保存](tickets/MP09-voice-recording.md) · [#175](https://github.com/brycezhang/timenook/issues/175) | 从当前推荐题直接开讲，录音中加照片先暂停；结束自动保存并形成正确归属的故事，失败可恢复。 | MP06、MP07、MP08 | 7 |
| [MP10 封面编辑、真实 PDF 与扫码回听](tickets/MP10-book-pdf.md) · [#176](https://github.com/brycezhang/timenook/issues/176) | 用户编辑并保存封面，生成只含已归章内容的真实 PDF，在系统查看器打开，并通过书中二维码回听固定版本原声。 | MP07、MP08 | 9 |
| [MP11 制作、收货地址与寄送状态](tickets/MP11-print-delivery.md) · [#177](https://github.com/brycezhang/timenook/issues/177) | 成员在成书后填写地址、确认制作，并查看固定版本的制作与寄送进度。 | MP10 | 7 |
| [MP12 全量原生对照验收与旧实现清理](tickets/MP12-full-native-acceptance.md) · [#178](https://github.com/brycezhang/timenook/issues/178) | 在同一可运行的小程序中走通所有角色和业务主线，完成 71 张画板及必要补充状态的逐项对照，交付没有旧入口与兼容分支的重构结果。 | MP01、MP02、MP03、MP04、MP05、MP06、MP07、MP08、MP09、MP10、MP11 | 全量集成 |

## 推进方式

在 `codex/miniprogram-modern-refactor` 集成分支推进，模块分支交付后按依赖合入；最终整体 PR 关联父规格与所有模块票。独立模块可并行，原生开发者工具验收串行使用同一台机器，避免窗口与编译产物互相覆盖。

先完成 MP01 的真实公开入口与登录，再推进购买、自购及发卡领取；共用大纲与项目照片可以并行。家人提问、故事、语音和成书使用已经实现的上游契约继续推进。

每票完成时记录实现、相关检查及其画板证据，不等到末票才开始 UI 检查。MP12 负责跨模块遗漏和全量对照关闭，不另建一套验收框架。

## 已知基线与设计差异

- 基线 CI 的支付测试 `Array.at` 类型错误和十分钟音频测试依赖编码器的问题均已修复；集成提交 `0a4080a` 的必要 CI 全绿。后续新提交继续执行仓库现有检查。
- MP01 已同步原画布的未勾选登录确认、完整现行条款和窄屏首页标题。71 张参考图及源文件 hash 已保存，原生验收仍分别记录。
- 六十题正文以当前初稿用于开发验证；内容正式审校仍单独记录。
- 本轮授权覆盖 TimeNook 开发模型、API、前后端及隔离开发数据，可重建或清空必要开发数据，不建设旧版本迁移或兼容层。其他产品、共享支付服务的数据不在范围。
