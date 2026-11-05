# 无付款内测项目与本人参与

对应 [W02 #97](https://github.com/brycezhang/timenook/issues/97)。本模块让已预建的网页产品账号在同一个无付款项目中完成邀请、审批、分用途本人授权、个人大纲编辑及进入讲述。媒体、真实AI和PDF运行由对应装配接续；不创建订单、资金流水、微信身份或首本生产权益。

## 配置与创建

默认关闭；受控非 test 内测环境设置 `INTERNAL_ACCEPTANCE_ENABLED=1`，同时配置 W01 的 `WEB_ORIGIN` / `WEB_SESSION_KEY` 和独立 `PRIVACY_JOURNAL_ROOT` / `PRIVACY_JOURNAL_KEY`。API 拒绝内测装配与 payments 并存；不以 NODE_ENV=test 代替真实内测。未取得的独立微信 AppID/Secret 继续留空。

先使用[网页账号 CLI](development-web-accounts.md)预建发起人与讲述者两个真实 User，并分别签发私下登录链接。内测项目命令引用已存在的发起人 User：

```sh
node --env-file=/absolute/private/server.env apps/api/dist/projects/internal-project-cli.js create --input-file /absolute/private/project.json --output-file /absolute/private/project-result.json
```

输入示例（文件权限600、父目录700，输出不能已存在）：

```json
{
  "provisionKey": "acceptance-project-001",
  "initiatorUserId": "真实预建产品账号的UUID",
  "bookTitle": "人生故事书",
  "subjectName": "讲述者称呼"
}
```

相同 provisionKey 和输入并发或再次执行返回同一个项目；同 key 改输入拒绝。CLI 不提供公网 arbitrary User 创建入口，不覆盖输出文件，不把凭据写标准输出。输出为 `{projectId,source:'internal-acceptance',admissionId}`。

一次事务建立真实项目、大纲/偏好、讲述者档案、不可变准入和长期服务规则。`internal-acceptance-v1` 是代码内置的内部工程额度/告知，不是商业套餐或供应商准入已批准；真实供应商的配置、告知与实际结果由运行装配另验。

## 两人操作

1. 发起人使用自己的登录链接进入项目，准备邀请并复制 `/app/invitation/:token` 网页链接；原生微信分享仍指向 welcome 的 token 入口。
2. 讲述者用自己的产品账号打开邀请，阅读内部告知并申请参与。发起人核对申请者账号后批准。
3. 讲述者在本人用途页分别选择采集、AI处理、向发起人共享；加入、审批、付款或网页/小程序账号关联均不替代授权。未授权采集不能录音，未授权AI不能处理，未授权共享时发起人不能读私人内容。
4. 具备当前权限后进入项目、编辑个人大纲/问题；讲述者可独立设置禁问/跳过，再进入讲述。后续媒体、AI、PDF仍受各自当前授权和运行装配约束。

实际网页登录由服务端 Session→WebSession 关系记录为 `self_web`；原生微信会话为 `self_wechat`。客户端不能通过 channel/method/operator 字段冒记来源。内部本人证据由服务端会话生成，客户端 `internal:` 确认文案不被当成外部身份核验凭证。

## 数据与消费者契约

`readProjectAdmissionIn(tx, projectId)` 返回 `{project,source,initiatorUserId,snapshot}`；付费源要求真实 paid 订单，内测源必须 orderId=null 并匹配唯一 immutable InternalProjectAdmission。付费标题保留 Project 自定义标题及原订单标题回退。两源并存、来源缺失或主体不匹配拒绝。

ProjectServiceTerms 的销售版本与 internalAdmissionId 精确选一；内测使用同项目复合 FK 和 snapshot 精确匹配，服务资格沿 #105 的 `read(projectId,tx)` 长期模型。内测 `firstCopyAction` 为 blocked；没有实体书生产权益。必要资料长期保存与临时会话、邀请、协助、上传/下载能力的安全有效期分开。

snapshot 的 d04 用户/供应商额度保持既有消费形状，scope 为 internal-acceptance；媒体、任务和PDF消费者按其责任票消费同一个来源，不再使用 `orderId!` 或伪造付款。共享总览提供实际 noticeVersion、evidencePrefix、noticeText、policyStatus 和 source。

数据库保持来源不可变、真实User FK、服务规则单一来源/同项目关系、真实唯一性与幂等；`self_web` 扩展与删除后拒绝写入的 paid/internal 发起人归属一并落地。没有取消本人拒绝、独立台账、版本/epoch、assisted用途限制或真实支付专属守卫。

## 本轮证据

受控 CLI 并发重试到同一个项目、两个真实 Cookie 账号邀请/审批/三个用途、个人计划/偏好及进入采访，通过真实隔离 PostgreSQL/Redis公开接口验证。内测没有新增支付/微信/权益事实，外人和发起人代替本人同意被拒绝。包含原 paid 参与、计划和网页账号的相关 API42项通过；共享参与/计划页面37项、前端类型和官方原生26页编译通过。

按最新 AGENTS 的功能优先约定仅做定向验证，最终与真实媒体、PDF、共享网页入口由主线集成。本文没有声称目标部署、真实微信、供应商或真机已验收；这些结果由主线另记，#97 仍使用 Refs。
