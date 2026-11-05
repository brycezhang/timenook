# 2026-11-02 Issues 与分支清理记录

用户最新口径：逐票区分“功能仍缺失”和“功能已交付、待实际验收”。前者继续保留 open；后者关闭，并留言待实际验收。产品网页端暂停继续与小程序对齐，相关剩余票据按 not planned 关闭。逐票以本票已确认的公开范围判断交付，不将后来拟用方案的新增接入工作混入旧票。

本轮检查基线为 main `fb516f93072bee4fdf93b2dcb465238c0b10cb4b`。关闭不追勾历史真实验收清单，不表示正式商业准入、真人/真机、供应商、印厂或实物已通过；原实际资金及售卖限制继续适用。

## Issue 处理结果

- 原 open 40 张；本轮关闭 37 张、删除 1 张，剩余 2 张。
- 29 张按功能交付完成关闭，逐票给出交付证据和待实际验收项。
- 8 张产品网页对齐票标记 wontfix / not planned：#95–#101、#107；#106 的独立浏览器 MP3 工程已交付，按 completed 关闭。

| Issue | 结论 | 具体原因/记录 |
| --- | --- | --- |
| [#1 [MVP] 时光里分阶段实施规格与验收](https://github.com/brycezhang/timenook/issues/1) | 保留 open：功能仍缺失 | 总规格：#69 仍有未交付功能；#6/#30 已关闭，原 #85 非核心 CI 流程建设提案已删除。 [清理评论](https://github.com/brycezhang/timenook/issues/1#issuecomment-6577707952) |
| [#3 [T02] 验证真机录音、私有封存与鉴权回听](https://github.com/brycezhang/timenook/issues/3) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/3#issuecomment-6577662637) |
| [#4 [T03] 验证豆包文件转写与 DeepSeek 生成质量](https://github.com/brycezhang/timenook/issues/4) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/4#issuecomment-6577663607) |
| [#5 [T04] 验证照片处理、固定 PDF 与纸面原声入口](https://github.com/brycezhang/timenook/issues/5) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/5#issuecomment-6577665958) |
| [#6 [T05] 冻结销售参数并核验实际微信支付路径](https://github.com/brycezhang/timenook/issues/6) | 关闭 completed：原票功能已交付，待实际验收 | 准入校验模块与 CLI 已交付；此前误将后来拟用条款接入并入旧票范围，保留判断撤销。实际参数/平台/运营待验保留。[复核修正](https://github.com/brycezhang/timenook/issues/6#issuecomment-6577746563) |
| [#7 [T06] 接通微信登录、会话与账号恢复](https://github.com/brycezhang/timenook/issues/7) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/7#issuecomment-6577667195) |
| [#10 [T09] 后端内置单套默认大纲并复制为个人计划](https://github.com/brycezhang/timenook/issues/10) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/10#issuecomment-6577668374) |
| [#11 [T10] 核验付款并唯一激活人生项目和首本权益](https://github.com/brycezhang/timenook/issues/11) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/11#issuecomment-6577669374) |
| [#12 [T11] 实现讲述者邀请绑定与分用途授权](https://github.com/brycezhang/timenook/issues/12) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/12#issuecomment-6577670481) |
| [#13 [T12] 支持无个人微信的同机协助与本人证据](https://github.com/brycezhang/timenook/issues/13) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/13#issuecomment-6577671755) |
| [#14 [T13] 编辑个人大纲、问题和拒答偏好](https://github.com/brycezhang/timenook/issues/14) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/14#issuecomment-6577672928) |
| [#15 [T14] 接通分轮录音、本地恢复与云端封存](https://github.com/brycezhang/timenook/issues/15) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/15#issuecomment-6577674038) |
| [#16 [T15] 持久化文件转写、重试与异常接管](https://github.com/brycezhang/timenook/issues/16) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/16#issuecomment-6577675162) |
| [#17 [T16] 接通照片起讲与私有照片处理](https://github.com/brycezhang/timenook/issues/17) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/17#issuecomment-6577676335) |
| [#18 [T17] 生成可跳过的单条追问并处理迟到结果](https://github.com/brycezhang/timenook/issues/18) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/18#issuecomment-6577677292) |
| [#19 [T18] 从完整转录清单整理可核对故事](https://github.com/brycezhang/timenook/issues/19) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/19#issuecomment-6577678400) |
| [#20 [T19] 实现校对、本人版本确认与真实项目进度](https://github.com/brycezhang/timenook/issues/20) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/20#issuecomment-6577679439) |
| [#21 [T20] 冻结书稿快照并生成完整可核对 PDF](https://github.com/brycezhang/timenook/issues/21) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/21#issuecomment-6577680521) |
| [#22 [T21] 接通书中原声码与版本固定的受控回听](https://github.com/brycezhang/timenook/issues/22) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/22#issuecomment-6577681672) |
| [#23 [T22] 双方确认同一 PDF 并唯一预留首本制作](https://github.com/brycezhang/timenook/issues/23) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/23#issuecomment-6577682832) |
| [#24 [T23] 审核生产、人工交接与物流追踪](https://github.com/brycezhang/timenook/issues/24) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/24#issuecomment-6577684018) |
| [#25 [T24] 贯通撤回、活动流终止与生产暂停](https://github.com/brycezhang/timenook/issues/25) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/25#issuecomment-6577685172) |
| [#26 [T25] 受理并交付可独立读取的完整资料导出](https://github.com/brycezhang/timenook/issues/26) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/26#issuecomment-6577686164) |
| [#27 [T26] 执行主动资料删除与迟到结果防复活](https://github.com/brycezhang/timenook/issues/27) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/27#issuecomment-6577687335) |
| [#28 [T27] 实现退款申请、金额预留与结果对账](https://github.com/brycezhang/timenook/issues/28) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/28#issuecomment-6577688427) |
| [#29 [T28] 闭环质量售后与原单重印](https://github.com/brycezhang/timenook/issues/29) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/29#issuecomment-6577689419) |
| [#30 [T29] 在共用 ECS 发布独立服务并验证当前运行配置](https://github.com/brycezhang/timenook/issues/30) | 关闭 completed：MVP 功能已交付，待实际验收 | 自动告警与全链路日志串联退出 MVP 强制要求；核心资金/权限/版本/恢复及审计保留，目标云配置与故障实测继续待验。[范围与关闭](https://github.com/brycezhang/timenook/issues/30#issuecomment-6577823151) |
| [#31 [T30] 完成内部实物闭环与付费试点验收](https://github.com/brycezhang/timenook/issues/31) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/31#issuecomment-6577690602) |
| [#69 [官网] 时光里营销官网首版规格与验收](https://github.com/brycezhang/timenook/issues/69) | 保留 open：功能仍缺失 | 营销官网制作入口仍为 /app/，缺正式进入小程序套餐页与电脑码。 [清理评论](https://github.com/brycezhang/timenook/issues/69#issuecomment-6577706073) |
| [#70 [官网] 实现独立营销应用与可交互预览](https://github.com/brycezhang/timenook/issues/70) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/70#issuecomment-6577691852) |
| #85 原 CI 并发合并原子保护提案（已删除） | 按用户要求删除：无必要独立立项 | 自动合并队列/互斥不属于 MVP 核心功能；沿用必要 CI 和正常合并操作。原始内容仅在 Git 外留存。[父规格记录](https://github.com/brycezhang/timenook/issues/1#issuecomment-6577863441) |
| [#95 [Web] 网页与小程序统一分步讲述及内部功能验收](https://github.com/brycezhang/timenook/issues/95) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/95#issuecomment-6577702547) |
| [#96 [W01] 同域网页入口与内测账号](https://github.com/brycezhang/timenook/issues/96) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/96#issuecomment-6577693352) |
| [#97 [W02] 共用账号、内测项目与邀请参与](https://github.com/brycezhang/timenook/issues/97) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/97#issuecomment-6577694368) |
| [#98 [W03] 两端统一分步录制到可靠云端保存](https://github.com/brycezhang/timenook/issues/98) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/98#issuecomment-6577695465) |
| [#99 [W04] 真实转写、可选追问与故事确认](https://github.com/brycezhang/timenook/issues/99) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/99#issuecomment-6577696613) |
| [#100 [W05] 同版 PDF 与后台衔接](https://github.com/brycezhang/timenook/issues/100) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/100#issuecomment-6577697873) |
| [#101 [W06] 同域发布与双端内部功能验收](https://github.com/brycezhang/timenook/issues/101) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/101#issuecomment-6577699105) |
| [#106 [W03b] 浏览器生成真实 MP3 并接通既有封存契约](https://github.com/brycezhang/timenook/issues/106) | 关闭 completed：功能已交付，待实际验收 | 逐票交付证据及未完成实际验收见关闭评论。 [清理评论](https://github.com/brycezhang/timenook/issues/106#issuecomment-6577700130) |
| [#107 [W02a] 网页账号与小程序双端确认关联](https://github.com/brycezhang/timenook/issues/107) | 关闭 not planned / wontfix：网页对齐暂停 | 退出当前网页端后续对齐队列，保留既有实现与历史证据。 [清理评论](https://github.com/brycezhang/timenook/issues/107#issuecomment-6577701310) |

## 分支处理结果

- GitHub 远端从 76 个分支减至 1 个，仅保留 main；无 open PR。删除 75 个分支前按初始 SHA 复核远端状态，使用带 expected SHA 的 lease 和原子 push，未改写 main。
- 其中 72 个分支的全部提交已包含在 main；其余 3 个是已替代的历史分支：planning-docs-main（#125 补丁等价）、story-transcript-state（旧 #119，由 #126/#128 补齐）、t27-ci-budget（旧 #64，由 #61 覆盖）。
- 三个历史引用已保存可校验的增量 Git bundle：`.git/maintenance/2026-11-02/superseded-branches.bundle`，对应 main 中的前置提交保留。
- 本地删除 86 个无 worktree 占用且已合入/确定被替代的分支；保留 30 个本地分支：25 个在使用中的 worktree 分支，5 个存在未确认归属的 main 外提交，未删除这些提交或工作区。
- 本轮没有删除 worktree、修改业务代码、云配置或原有未提交样本。原工作目录已有的未提交改动保留；本轮文档调整尚未提交。

## 文档与验证

- 已同步本地 CONTEXT、Issue tracker、MVP 规格及网页规格/票据的最新闭票和暂停口径。
- GitHub 原生父子/blocked-by 关系保留；工程交付和实际验收状态继续分别表达。
- 重新读取全部 40 个处理对象，检查 state/state_reason、标签及逐票评论；确认只剩上述 2 张 open、远端只剩 main。
- 文档差异空白检查通过；本轮未修改业务代码，不重复业务全量测试。
- 原始 issue/PR/远端分支快照、动作计划与结果保存在 `.git/maintenance/2026-11-02/`，不进入 Git。
