# 实施路线与 ticket 审阅清单

2026-10-22 · 用户已确认并将运营模板改为后端单套内置模板；已发布 GitHub issues。目标仓库：[brycezhang/timenook](https://github.com/brycezhang/timenook)。

基于已定稿开发方案，已创建 **[1 个规格父 issue](https://github.com/brycezhang/timenook/issues/1) + 30 个子 tickets**，用 GitHub 原生 blocked-by 关系表示依赖，并按 ready-for-agent / ready-for-human 区分实现和外部决策。每票均可从本页打开完整验收条件。

推进方式：主 Agent 按 ready frontier 派发实施 subagent；工程依赖已满足且彼此独立的票，可用独立 worktree/分支并行实施。每票分别完成 TDD、相关检查、独立 Standards / Spec 双轴审查与最终提交的 PR CI；合并串行，每次合并后 main CI 全绿，才进行下一票合并并放行依赖者；独立票实施、PR CI 与审查仍可并行。现有 45 条依赖与真实完成口径不变。外部验收缺失时保留票据未完成；按上游已交付工程产物判断可推进的本地范围，真实验收与上线分别检查。T01 已由 PR #32 合并。部署目标已按 [ADR 0009](../../adr/0009-shared-ecs-api-path.md) 调整为 legal-agent 共用 ECS/域名、`/timenook` 分流。

## 阶段

| 阶段 | Tickets | 结果 |
| --- | --- | --- |
| S0 | T01–T05 | 工程及技术/准入验证 |
| S1 | T06–T12 | 登录、运营、套餐模板、支付和身份授权 |
| S2 | T13–T19 | 个人计划、录音、转写、照片、追问及故事确认 |
| S3 | T20–T23 | 完整书稿、原声入口、首本与生产物流 |
| S4 | T24–T29 | 撤回、导出、删除、售后与发布恢复 |
| S5 | T30 | 内部实物闭环及付费试点 |

## 逐票交付与依赖

1. **[T01 建立可复现工程与服务健康闭环](tickets/01-workspace-health.md)**
   - 阻塞：无。
   - 交付：新成员从空目录安装后，能运行现有小程序预览、启动 NestJS/Fastify API，并查询进程和依赖状态。

2. **[T02 验证真机录音、私有封存与鉴权回听](tickets/02-audio-storage-probe.md)**
   - 阻塞：T01。
   - 交付：在受控测试入口用已授权样本完成录音、本地保存、私有 OSS 封存及回听，形成可复现的双端证据。

3. **[T03 验证豆包文件转写与 DeepSeek 生成质量](tickets/03-ai-provider-probe.md)**
   - 阻塞：T02。
   - 交付：从同一封存样本取得真实文件转录、一条可选追问和带来源的整理稿，记录时延、费用与失败恢复结果。

4. **[T04 验证照片处理、固定 PDF 与纸面原声入口](tickets/04-print-image-probe.md)**
   - 阻塞：T01。
   - 交付：以合成或已授权内容生成一份候选生产文件，完成图片方向/清晰度检查和实体打样扫码。

5. **[T05 冻结销售参数并核验实际微信支付路径](tickets/05-commerce-admission.md)**
   - 阻塞：T01。
   - 交付：形成可审核的套餐发布参数及真实商品准入证据，让后续支付实现有明确输入和不开售条件。

6. **[T06 接通微信登录、会话与账号恢复](tickets/06-wechat-session.md)**
   - 阻塞：T01。
   - 交付：小程序登录后使用服务端身份访问自己的资源，退出或会话失效时正确恢复；演示模式保留明确隔离。

7. **[T07 建立独立运营登录与受限管理入口](tickets/07-admin-access.md)**
   - 阻塞：T01。
   - 交付：运营使用 Vben 管理端登录，看到权限内的运行信息，并留下操作审计。

8. **[T08 发布动态赠礼关系与不可变套餐](tickets/08-catalog-package.md)**
   - 阻塞：T04、T05、T07。
   - 交付：运营发布关系目录和套餐后，小程序展示相同的价格、称呼及服务条款；配置不完整时明确不可购买。

9. **[T09 后端内置单套默认大纲并复制为个人计划](tickets/09-builtin-template.md)**
   - 阻塞：T01。
   - 交付：后端内置一套默认模板，创建项目时复制独立计划；代码更新不覆盖旧项目，用户可编辑个人章节和问题。

10. **[T10 核验付款并唯一激活人生项目和首本权益](tickets/10-payment-project.md)**
   - 阻塞：T05、T06、T08、T09。
   - 交付：发起人付款或退出后查询订单，都恢复同一个人生项目、讲述者、默认计划和首本权益。

11. **[T11 实现讲述者邀请绑定与分用途授权](tickets/11-invitation-consent.md)**
   - 阻塞：T10。
   - 交付：讲述者申请参与，经发起人核验绑定后，分别决定采集、AI 处理和共享权限。

12. **[T12 支持无个人微信的同机协助与本人证据](tickets/12-assisted-session.md)**
   - 阻塞：T11。
   - 交付：讲述者在场同意时，发起人可代操作录音；系统持续区分讲述者和操作人。

13. **[T13 编辑个人大纲、问题和拒答偏好](tickets/13-personal-plan.md)**
   - 阻塞：T09、T11。
   - 交付：双方可调整个人计划，讲述者随时跳过、拒答或禁问；从默认问题即可开始，无需先填完设置。

14. **[T14 接通分轮录音、本地恢复与云端封存](tickets/14-interview-recording.md)**
   - 阻塞：T02、T11、T13。
   - 交付：讲述者从计划/自拟问题开始采访，录音可靠保存后可以离开、返回和按文件重试。

15. **[T15 持久化文件转写、重试与异常接管](tickets/15-durable-transcription.md)**
   - 阻塞：T03、T14。
   - 交付：每段封存录音自动转写，离开后可查状态；Worker/Redis 故障后能从原声恢复，不重复扣用户额度。

16. **[T16 接通照片起讲与私有照片处理](tickets/16-story-photos.md)**
   - 阻塞：T04、T14。
   - 交付：用户可以先选照片讲述或事后补图，每张照片独立保存、重试并关联正确故事。

17. **[T17 生成可跳过的单条追问并处理迟到结果](tickets/17-optional-followup.md)**
   - 阻塞：T15。
   - 交付：当前片段转录就绪后，可出现一条中性追问；用户可改写、跳过、继续讲或结束。

18. **[T18 从完整转录清单整理可核对故事](tickets/18-story-generation.md)**
   - 阻塞：T15。
   - 交付：用户提交整理后取得带来源、待本人确认的第一人称故事；原声和原始转录保持独立。

19. **[T19 实现校对、本人版本确认与真实项目进度](tickets/19-story-confirmation.md)**
   - 阻塞：T12、T16、T18。
   - 交付：发起人可协助校对，讲述者确认指定版本并单独决定入书；项目主页反映真实记录。

20. **[T20 冻结书稿快照并生成完整可核对 PDF](tickets/20-book-pdf.md)**
   - 阻塞：T04、T19。
   - 交付：用户按实际目录生成包含全文、照片及原声入口的完整书稿，总览与 PDF 显示同一版本。

21. **[T21 接通书中原声码与版本固定的受控回听](tickets/21-versioned-audio-entry.md)**
   - 阻塞：T20。
   - 交付：读者扫描纸书入口，登录授权后只听到所印版本的原声；未授权者看不到私人信息。

22. **[T22 双方确认同一 PDF 并唯一预留首本制作](tickets/22-first-copy-confirm.md)**
   - 阻塞：T21。
   - 交付：讲述者确认内容，发起人确认完整 PDF 与地址后，提交首本且无需再次付款。

23. **[T23 审核生产、人工交接与物流追踪](tickets/23-production-shipping.md)**
   - 阻塞：T22。
   - 交付：运营把用户确认的同一生产文件交给印厂，记录接收回执、生产和物流；用户可看真实阶段。

24. **[T24 贯通撤回、活动流终止与生产暂停](tickets/24-withdrawal.md)**
   - 阻塞：T23。
   - 交付：讲述者撤回指定用途后立即停止相关访问与新处理，并能看见待生产或已交接事项的实际处置进度。

25. **[T25 受理并交付可独立读取的完整资料导出](tickets/25-complete-export.md)**
   - 阻塞：T21。
   - 交付：用户申请后，客服核验范围并生成完整 ZIP，交付给获授权的申请人。

26. **[T26 执行资料删除及备份恢复防复活](tickets/26-deletion-ledger.md)**
   - 阻塞：T24、T25。
   - 交付：资料删除请求按范围清理活动内容、历史对象、导出与供应商副本，并如实展示尚待到期或确认的部分。

27. **[T27 实现退款申请、金额预留与结果对账](tickets/27-refund-reconciliation.md)**
   - 阻塞：T23。
   - 交付：客服按已公示规则处理退款，超时或通知重放不会重复退钱，权益及生产状态保持一致。

28. **[T28 闭环质量售后与原单重印](tickets/28-quality-care.md)**
   - 阻塞：T27。
   - 交付：用户提交质量问题后，客服可核对确定 PDF、印刷及物流证据，处理赔付或原单重印。

29. **[T29 在共用 ECS 发布独立服务并完成恢复演练](tickets/29-release-recovery.md)**
   - 阻塞：T17、T26、T28。
   - 交付：在共用 ECS 上隔离部署 TimeNook，通过同一 API 域名的 `/timenook` 分流，并验证现有 legal-agent 不受影响及故障恢复。

30. **[T30 完成内部实物闭环与付费试点验收](tickets/30-pilot-acceptance.md)**
   - 阻塞：T29。
   - 交付：以一份真实内部项目走完付款、讲述、确认、实体书、原声和资料权利，再按门槛开放 30–50 个付费项目。

## 启动顺序

先完成 T01。之后逐票读取上游已合并 PR、相关测试/审查和未完成条件。所需工程成果已交付、剩余仅为外部条件时，可继续已授权的下游本地开发并记录证据；所需契约或代码尚未交付则等待。原生 blocked-by 继续表达完整交付依赖，不把本地可实施标成完整无阻塞。T08 的正式套餐仍要求实际参数及准入，合成预览不授权售卖。

技术验证票的本票真实证据齐全才关闭；缺少账号、样本、设备、商业决策或印厂回执时明确剩余范围。T29 集中正式部署、实际管理员 MFA、云资源与恢复；T30 汇总上线/实物/用户验收，前序票不反向等待它们关闭。生产数据采集、资金、印厂交接与售卖仍受对应条件约束。完整规则见 [Issue tracker](../../agents/issue-tracker.md) 和 [父规格](spec.md#依赖完成规则)。

## 验收追踪

- A01：[T05](tickets/05-commerce-admission.md)、[T08](tickets/08-catalog-package.md)、[T10](tickets/10-payment-project.md)；T30 汇总实测。
- A02：[T10](tickets/10-payment-project.md)；T30 汇总实测。
- A03：[T05](tickets/05-commerce-admission.md)、[T10](tickets/10-payment-project.md)；T30 汇总实测。
- A04：[T11](tickets/11-invitation-consent.md)；T30 汇总实测。
- A05：[T11](tickets/11-invitation-consent.md)；T30 汇总实测。
- A06：[T05](tickets/05-commerce-admission.md)、[T12](tickets/12-assisted-session.md)；T30 汇总实测。
- A07：[T03](tickets/03-ai-provider-probe.md)、[T09](tickets/09-builtin-template.md)、[T13](tickets/13-personal-plan.md)、[T14](tickets/14-interview-recording.md)、[T17](tickets/17-optional-followup.md)；T30 汇总实测。
- A08：[T16](tickets/16-story-photos.md)；T30 汇总实测。
- A09：[T02](tickets/02-audio-storage-probe.md)、[T14](tickets/14-interview-recording.md)、[T15](tickets/15-durable-transcription.md)；T30 汇总实测。
- A10：[T02](tickets/02-audio-storage-probe.md)、[T03](tickets/03-ai-provider-probe.md)、[T14](tickets/14-interview-recording.md)、[T15](tickets/15-durable-transcription.md)、[T18](tickets/18-story-generation.md)；T30 汇总实测。
- A11：[T03](tickets/03-ai-provider-probe.md)、[T18](tickets/18-story-generation.md)、[T19](tickets/19-story-confirmation.md)；T30 汇总实测。
- A12：[T18](tickets/18-story-generation.md)、[T19](tickets/19-story-confirmation.md)；T30 汇总实测。
- A13：[T16](tickets/16-story-photos.md)、[T19](tickets/19-story-confirmation.md)；T30 汇总实测。
- A14：[T19](tickets/19-story-confirmation.md)；T30 汇总实测。
- A15：[T04](tickets/04-print-image-probe.md)、[T20](tickets/20-book-pdf.md)；T30 汇总实测。
- A16：[T19](tickets/19-story-confirmation.md)、[T20](tickets/20-book-pdf.md)、[T22](tickets/22-first-copy-confirm.md)；T30 汇总实测。
- A17：[T19](tickets/19-story-confirmation.md)、[T20](tickets/20-book-pdf.md)、[T22](tickets/22-first-copy-confirm.md)；T30 汇总实测。
- A18：[T22](tickets/22-first-copy-confirm.md)、[T23](tickets/23-production-shipping.md)；T30 汇总实测。
- A19：[T04](tickets/04-print-image-probe.md)、[T21](tickets/21-versioned-audio-entry.md)、[T23](tickets/23-production-shipping.md)；T30 汇总实测。
- A20：[T04](tickets/04-print-image-probe.md)、[T11](tickets/11-invitation-consent.md)、[T21](tickets/21-versioned-audio-entry.md)、[T24](tickets/24-withdrawal.md)；T30 汇总实测。
- A21：[T25](tickets/25-complete-export.md)；T30 汇总实测。
- A22：[T24](tickets/24-withdrawal.md)、[T26](tickets/26-deletion-ledger.md)；T30 汇总实测。
- A23：[T05](tickets/05-commerce-admission.md)、[T27](tickets/27-refund-reconciliation.md)；T30 汇总实测。
- A24：[T23](tickets/23-production-shipping.md)、[T28](tickets/28-quality-care.md)；T30 汇总实测。
- X01：[T08](tickets/08-catalog-package.md)、[T10](tickets/10-payment-project.md)；T30 汇总实测。
- X02：[T02](tickets/02-audio-storage-probe.md)、[T03](tickets/03-ai-provider-probe.md)、[T14](tickets/14-interview-recording.md)、[T15](tickets/15-durable-transcription.md)；T30 汇总实测。
- X03：[T02](tickets/02-audio-storage-probe.md)、[T03](tickets/03-ai-provider-probe.md)、[T14](tickets/14-interview-recording.md)、[T15](tickets/15-durable-transcription.md)、[T17](tickets/17-optional-followup.md)、[T18](tickets/18-story-generation.md)、[T24](tickets/24-withdrawal.md)、[T29](tickets/29-release-recovery.md)；T30 汇总实测。
- X04：[T04](tickets/04-print-image-probe.md)、[T05](tickets/05-commerce-admission.md)、[T10](tickets/10-payment-project.md)、[T16](tickets/16-story-photos.md)、[T23](tickets/23-production-shipping.md)、[T27](tickets/27-refund-reconciliation.md)；T30 汇总实测。
- X05：[T09](tickets/09-builtin-template.md)、[T13](tickets/13-personal-plan.md)、[T20](tickets/20-book-pdf.md)；T30 汇总实测。
- X06：[T03](tickets/03-ai-provider-probe.md)、[T13](tickets/13-personal-plan.md)、[T17](tickets/17-optional-followup.md)、[T19](tickets/19-story-confirmation.md)、[T20](tickets/20-book-pdf.md)；T30 汇总实测。

D01 由 T04 冻结；D02–D08 由 T05 冻结；D09 由 T09 冻结；D10 由 T08 冻结。T08 必需参数缺失则拒绝可售发布。T30 汇总全部参数、平台与实物证据。

## 当前规格与验收归属

首版实施已按 [ADR 0010](../../adr/0010-mvp-fixed-policy-and-reuse.md) 收敛；完整规则以[父规格](spec.md)为准。

| 事项 | 唯一依据 |
| --- | --- |
| 固定政策与订单快照 | [首版固定政策](spec.md#首版固定政策)；T05 冻结实际选择，未知值保持待定 |
| 探针到生产的复用 | [复用矩阵](spec.md#探针复用与生产集成)；消费者补生产集成，T15 提供共享任务机制 |
| 人工与系统分工 | [人工运营边界](spec.md#人工运营边界)；共享工单、人工判断、受控执行 |
| 完成、验收和质量 | [依赖完成规则](spec.md#依赖完成规则)、[证据归属](spec.md#验收复用与唯一归属)、[质量目标](spec.md#质量目标与证据归属) |
| 路径 | [ADR 0009](../../adr/0009-shared-ecs-api-path.md)；内部 `/v1`，公网 `/timenook` 前缀 |

保留 T01–T30、45 条依赖、全部 A/X/D 责任与已有交付记录；补漏验收已并入各票，不再维护第二份“本次补充”清单。本地票据与 GitHub 正文同步，实时状态以 GitHub 为准，修订不追认验收通过。本轮仅修改文档，业务实现及真实条件仍分别验证。[复杂度复核](mvp-complexity-review.md)保留决策理由，当前执行以父规格为准。

## 已确认内容

- 首版固定一份政策版本，生产复用探针能力，共享工单支持人工运营；各票保留必要公开入口、可靠性和真实验收。

- 沿用 30 票拆分；T09 改为后端一套固定模板，去掉运营模板管理及多模板选择/切换。
- [实施规格](spec.md)中的四类测试边界，先从 HTTP 健康与依赖就绪验证开始。
- [仓库流程配置草稿](setup-proposal.md)：GitHub Issues、默认标签、根 AGENTS.md、现有单一术语表与 ADR。

发布规格和 tickets，建立原生父子/阻塞关系，再执行 T01。实际 issue 链接回填后作为执行索引；功能状态以验收证据为准。

## GitHub 执行索引

- [T01 · #2 · 建立可复现工程与服务健康闭环](https://github.com/brycezhang/timenook/issues/2)
- [T02 · #3 · 验证真机录音、私有封存与鉴权回听](https://github.com/brycezhang/timenook/issues/3)
- [T03 · #4 · 验证豆包文件转写与 DeepSeek 生成质量](https://github.com/brycezhang/timenook/issues/4)
- [T04 · #5 · 验证照片处理、固定 PDF 与纸面原声入口](https://github.com/brycezhang/timenook/issues/5)
- [T05 · #6 · 冻结销售参数并核验实际微信支付路径](https://github.com/brycezhang/timenook/issues/6)
- [T06 · #7 · 接通微信登录、会话与账号恢复](https://github.com/brycezhang/timenook/issues/7)
- [T07 · #8 · 建立独立运营登录与受限管理入口](https://github.com/brycezhang/timenook/issues/8)
- [T08 · #9 · 发布动态赠礼关系与不可变套餐](https://github.com/brycezhang/timenook/issues/9)
- [T09 · #10 · 后端内置单套默认大纲并复制为个人计划](https://github.com/brycezhang/timenook/issues/10)
- [T10 · #11 · 核验付款并唯一激活人生项目和首本权益](https://github.com/brycezhang/timenook/issues/11)
- [T11 · #12 · 实现讲述者邀请绑定与分用途授权](https://github.com/brycezhang/timenook/issues/12)
- [T12 · #13 · 支持无个人微信的同机协助与本人证据](https://github.com/brycezhang/timenook/issues/13)
- [T13 · #14 · 编辑个人大纲、问题和拒答偏好](https://github.com/brycezhang/timenook/issues/14)
- [T14 · #15 · 接通分轮录音、本地恢复与云端封存](https://github.com/brycezhang/timenook/issues/15)
- [T15 · #16 · 持久化文件转写、重试与异常接管](https://github.com/brycezhang/timenook/issues/16)
- [T16 · #17 · 接通照片起讲与私有照片处理](https://github.com/brycezhang/timenook/issues/17)
- [T17 · #18 · 生成可跳过的单条追问并处理迟到结果](https://github.com/brycezhang/timenook/issues/18)
- [T18 · #19 · 从完整转录清单整理可核对故事](https://github.com/brycezhang/timenook/issues/19)
- [T19 · #20 · 实现校对、本人版本确认与真实项目进度](https://github.com/brycezhang/timenook/issues/20)
- [T20 · #21 · 冻结书稿快照并生成完整可核对 PDF](https://github.com/brycezhang/timenook/issues/21)
- [T21 · #22 · 接通书中原声码与版本固定的受控回听](https://github.com/brycezhang/timenook/issues/22)
- [T22 · #23 · 双方确认同一 PDF 并唯一预留首本制作](https://github.com/brycezhang/timenook/issues/23)
- [T23 · #24 · 审核生产、人工交接与物流追踪](https://github.com/brycezhang/timenook/issues/24)
- [T24 · #25 · 贯通撤回、活动流终止与生产暂停](https://github.com/brycezhang/timenook/issues/25)
- [T25 · #26 · 受理并交付可独立读取的完整资料导出](https://github.com/brycezhang/timenook/issues/26)
- [T26 · #27 · 执行资料删除及备份恢复防复活](https://github.com/brycezhang/timenook/issues/27)
- [T27 · #28 · 实现退款申请、金额预留与结果对账](https://github.com/brycezhang/timenook/issues/28)
- [T28 · #29 · 闭环质量售后与原单重印](https://github.com/brycezhang/timenook/issues/29)
- [T29 · #30 · 在共用 ECS 发布独立服务并完成恢复演练](https://github.com/brycezhang/timenook/issues/30)
- [T30 · #31 · 完成内部实物闭环与付费试点验收](https://github.com/brycezhang/timenook/issues/31)
