# T23 后端工程证据

## 范围与复用

基线 `ec606dd37c67b91756bef152697082a63eacf8c2`，票据 [#24](https://github.com/brycezhang/timenook/issues/24)。复用 T22 PR #58 的已付款、地址/书稿/双方确认、唯一预留、管理审核与 D02 门禁；T10 `ProjectServiceTerms.recordFact` 承担交付起算，T11/T12 承担当前主体/协助授权。新增行为沿票据和父规格预先约定的 HTTP + 真实 PostgreSQL/Redis 边界验证。

没有新增真实印厂或物流接口。路由仍只注册于既有 `books.mode=synthetic-local`、`environment=test` 隔离入口；微信/支付/AI 为显式外部协议替身，数据库与 Redis 为真实本地依赖。未调用真实资金、发送生产文件、部署或接触私人素材。

## 逐片 RED → GREEN

每片先执行公开 HTTP 失败，再补对应最小实现。日志均保留仓库外：

| 片段 | RED | GREEN |
| --- | --- | --- |
| 私有生产进度，匿名/无关账号拒绝 | `/tmp/timenook-t23-backend-red-progress.log` | `/tmp/timenook-t23-backend-green-progress.log` |
| 并发仅一个尝试/编号/共享工单/负责人，默认不披露材料 | `/tmp/timenook-t23-backend-red-attempt.log` | `/tmp/timenook-t23-backend-green-attempt.log` |
| 讲述者限时同版授权、仅工单负责人读取最少 PDF/地址、到期及撤权拒绝 | `/tmp/timenook-t23-backend-red-grant.log` | `/tmp/timenook-t23-backend-green-grant.log` |
| 未知交接保留预留、禁止再交接，确定接单才消费 | `/tmp/timenook-t23-backend-red-handoff.log` | `/tmp/timenook-t23-backend-green-handoff.log` |
| 交接前取消；已接单取消须印厂核验后才恢复原单预留并新建尝试 | `/tmp/timenook-t23-backend-red-cancel.log` | `/tmp/timenook-t23-backend-green-cancel.log` |
| D02 到期后仍核对既有实物状态；真实交付事实幂等起算 D03 | `/tmp/timenook-t23-backend-red-delivery.log` | `/tmp/timenook-t23-backend-green-delivery.log` |
| 原销售快照 D08 已准入印厂绑定，不接受另选供应商 | `/tmp/timenook-t23-backend-red-supplier.log` | `/tmp/timenook-t23-backend-green-supplier.log` |

下载和交接消费 T22 同事务审核门禁，没有复制另一套付款/版本/授权判断。读取 PDF 在磁盘读取前后分别重新鉴权并验证具体文件长度/hash。交接前状态变更才执行新文件交付门禁；既有未知/接单/取消/物流核对不会被后来的 D02 到期挡住，也不会自行放行新文件或新尝试。Commerce 后续冻结不因核实真实接单而被覆盖。

附加消费者集成：进程重启后未知交接仍返回原尝试/交接号与预留权益，不能再交接；公开封面变更使已获准的下载和交接拒绝，历史进度仍显示固定书稿；协助授权必须使用当次 `book_confirmation` 及单独版本证据；暂停再次阻止材料和交接；管理权限、CSRF、幂等异载荷与拒绝审计持续生效。相关日志 `/tmp/timenook-t23-backend-green-recovery-preflight.log`，最终合并运行包含全部增量。

最终 T23 **11/11**（`/tmp/timenook-t23-backend-final.log`）。API 类型及构建通过；最终整仓检查和精确提交审查/CI 由主 Agent 记录。

## 持久约束与人工边界

每个 T22 首本单可以有多次顺序尝试；数据库部分唯一索引保证最多一个非取消尝试，复合外键绑定项目/原单/尝试。grant、回执/操作记录及唯一交付事实不可更新。取消不释放为可再次购买的权益；已消费经确定取消后只回到原单 `reserved`，未知/待取消状态不释放。真实交付后采用售后流程，不允许重置交付。

原销售快照 D06 仅有 `business_days` 与待落地的日历引用，系统未假定节假日/真实日历。运营必须明确录入适用日历核算后的未来处理截止时间，记录在共享工单对应尝试的 `dueAt`；合成测试的期限不是正式服务承诺。限时材料授权上限 30 分钟是隔离本地读取的技术限制，不替代 D03 商业资料服务期限。

物流记录分别保存承运事实与原 D08 `implemented_and_verified` 路径的微信处理状态/证据。`pending`/`failed` 不显示平台处理成功，可在保持相同追踪号及时间时补录结果；实物交付不会因补录微信结果而回退或重新起算期限。此处全部 evidenceRef 为明确合成引用，实际微信发货管理仍未验收。

## 外部待验

正式 D01/D02/D03/D05/D06/D08、实际日历和负责人、印厂条款/接收/取消凭证、物流交付、微信发货管理结果及真机同步仍待责任票验收。首次真实交接仍须明确授权。合成通过仅证明本地工程，不能关闭 #24 或开放生产/售卖。

相关上游回归 `first-copy.test.js`、`book-pdf.test.js`、`participation.test.js`、`admin.test.js`、`payments.test.js` **89/89**（`/tmp/timenook-t23-backend-regression.log`）。这与 T23 11 项不是同一次全量运行；未改动的媒体/队列广泛回归继续由精确提交 CI 执行。
