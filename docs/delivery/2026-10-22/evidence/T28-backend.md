# T28 后端工程证据

仅为隔离合成配置下的本地工程，Refs #29。本票及真实未勾选项保持 OPEN。消费 T27 PR #63 最终 f9581c5，合并 b00fb40，PR CI 40336585654 成功，精确 main CI 40340836685 attempt 2 完整成功；attempt 1 的预算截断不算通过。恢复后安全保存首片为 0039d84，再合入 T24 已发布 main 78ccf6d（精确 CI 40351115911 success），合并记录 a96f407。最终整票 HEAD、独立双轴审查和 CI 由主交付记录补充。

## 公开边界与实现

按既定 HTTP + 真实 PostgreSQL/Redis + 实际 PDF seams 逐片实现，供应商仅使用原有显式合成外部协议。申请固定原付款/首本单、已交付尝试、PDF hash/物流和原申请时间；共享工单仅返回最少元数据。质量文字放在项目所属可清理证据行，命令只存 hash。

MFA/CSRF/运营权限领取实际负责人及经原 D06 日历核验的绝对截止；本人/合规 book_confirmation 协助 Session 选择限时 scope，非本人买方和其他客服不能访问。PDF 复用 T24 ProjectStreams 并在 I/O 前捕获 fence。每次 scope 调用 Participation.subjectCareGrantIn 重算本人实际 collection 及原 self/本次 book_confirmation 协助方式；grant 固化协助 Session 与相关撤回序号，防同 epoch 拒绝后旧 grant 复活。同机 AI/sharing 单项拒绝不误伤这份专属印刷核对授权。投产仍调用原 bookGrantIn/T23 条件。

原文件重印与新稿重确认均新增原首本单的质量尝试；原单/旧稿/旧确认不可变，consumed 权益不变。数据库活动唯一性保留未知/取消待核实占位。质量取消不返还首本；新交付只记录本次事实，首次 FulfillmentDelivery/D03 不重起。新稿只有完整生成且双方 fresh 同版确认才返回 replacement，ordinary consumed submit 不复活。

质量退款调用同一 Refunds.requestIn，并沿已有 approve/execute/通知/查询入账。服务端原申请时刻用于原 D07 窗口，及时申请跨期核验仍有效；质量页仅投影退款实际状态，不自行写金额终态。商业冻结、终止及首本取消标记继续生效。新增资产及 T26 消费责任见[质量售后开发说明](../../../development-quality-care.md#t26-清理消费清单)。

## RED / GREEN 记录

- 原单申请：RED 缺接口 404；GREEN 原申请/同键重放、异载荷冲突、私有列表与共享工单。`/tmp/timenook-t28-{red-request,green-request,resume-first-slice}.log`。
- 限时材料：RED 缺运营读取接口；GREEN 实际 PDF、负责人/scope、到期及撤回拒绝，初轮两片 2/2。`/tmp/timenook-t28-{red-access,green-access}.log`。
- 原文件重印：RED 当前本人不能申请、ordinary consumed submit 返回成功；修复后并发三命令只成功一条、原交付历史/权益保持及后续签收 D03 不重起。`/tmp/timenook-t28-{red-reprint,green-reprint}.log`。曾用 fixture 的运营 base 误调普通 submit 得 404，修正测试路径后才观察到真实 consumed 提交问题，不把路径错误当业务证据。
- 新稿：replacement 未实现的 RED 后，实际新 PDF、缺任一 fresh 确认拒绝、两方确认后受控绑定及旧证据不变通过。`/tmp/timenook-t28-{red-revised,green-revised}.log`。该片的公开 tracer 为服务端受控新版绑定，已有新稿门禁以本票新增集成回归核验，不声称每条断言均有独立初始 RED。
- 同退款用例：RED 缺组合接口；GREEN 原退款 unknown、预留、同号查询及已核验 SUCCESS，保留 consumed/D03。`/tmp/timenook-t28-{red-refund,green-refund}.log`。

未知质量交接/取消不返首本、合规同机 scope、并行退款冻结、原申请窗口及恰好截止的本票阶段整轮 9/9：`/tmp/timenook-t28-api-quality-boundaries.log`。随后同机撤回序号增量的单项 GREEN 记录为 `/tmp/timenook-t28-green-assist-fence.log`；最初补用例时遗漏 expectedSessionId 得 409，为测试准备问题，不算所述访问漏洞的 RED。实际质量 scope 早已通过当前 bookGrant 拒绝拒绝期间的新 GET，序号增量进一步使旧质量 grant 不能在重授后自行恢复。

完整相关 serial 回归、最终 API 类型/构建/OpenAPI、实际浏览器及最终双轴审查在完成后补充；当前分片记录不替代这些结果。

## 专属客服授权与 D03 增量

Root 定点审查指出：原 scope 用 buyer 的 bookGrantIn，把「向发起人共享」错误当成客服权限。公开 RED：本人 sharing=false、collection=true 时新专属 grant 接受，但 owner 材料403（`/tmp/timenook-t28-red-dedicated-care.log`）。修复后按实际授权主体/方式和精确协助 Session 校验，普通买方不因客服 grant 获得内容权限；重印仍保留原 T23 条件。ProjectStreams 只增加受控运营用途参数，携带产品 Authorization 时始终按真实用户派生。专属本人、同机、结束协助及既有同机序号共两项定向 GREEN（`/tmp/timenook-t28-green-dedicated-care.log`）。

另观察到 D03 activeData 已到期仍能新增质量说明的公开 RED（201，`/tmp/timenook-t28-red-evidence-retention.log`）；质量文字明确归该既有保留类别，到期拒绝新证据与新证据 grant，并在材料/核验读取时重验。未新增商业期限，PDF 仍单独消费 bookPdf；删除及备份副本仍待 T26。最终三项定向 3/3（`/tmp/timenook-t28-green-dedicated-retention.log`），包括同机 sharing 拒绝不误杀专属客服 PDF。

## 最终生产许可回归

定点公开回归复现原文件重印未检查原故事版本入书许可：撤销 allowInBook 后仍201（`/tmp/timenook-t28-red-original-story-permission.log`）。生产 preflight 现核验原 PDF 快照内精确 revision/content hash、当前 subject/binding 的最新 confirmed/allowInBook；专属质量证据查看保持独立。没有用当前不同草稿覆盖原文件，也未放宽普通首本条件。最终本票回归记录于 `/tmp/timenook-t28-api-quality-final.log`。

## T25 合入前的本地结果

- T28/T22/T23/T27/T24/Book 相关六文件 serial 整轮 **98/98**，日志 `/tmp/timenook-t28-api-related-final-v2.log`；涵盖 subjectCareGrantIn 与 ProjectStreams 用途扩展后的既有回归。
- 随后仅增加精确故事入书许可生产 guard，T28 最新全文件 **12/12**，日志 `/tmp/timenook-t28-api-quality-final.log`。两轮包含重叠场景，不相加冒充一次测试总数；最后这项 guard 只进入质量生产路径。
- API 类型、构建和 OpenAPI 导出成功：`/tmp/timenook-t28-api-typecheck-final.log`、`/tmp/timenook-t28-api-build-final.log`、`/tmp/timenook-t28-openapi-final.log`。
- 本机独立数据库增量迁移应用成功（`/tmp/timenook-t28-migrate-final.log`），各 HTTP 夹具继续覆盖 fresh/replay；未修改任何已应用旧迁移或共享服务配置。
- UI 由分区协作者在同票提交 2e5165e；相关 Page/Vben/实际浏览器及 native 的责任证据由其交接及主流程记录，本后端未重复运行前端检查。

以上结果对应已由 a96f407 纳入的 main 78ccf6d。新的质量数据清理清单交由 T26 消费；D03/D06/D07 实际政策、供应商、资金、真机和印刷证据仍待原责任票验收。独立 Standards/Spec 与精确 PR/main CI 仍待主交付，不以以上本地结果关闭 #29 或放行生产/售卖。

## T25 发布后的整票整合

合入 T25 PR #62 已发布 main `79f82e54ff1c9de12fb8b5fd0ddd58e11544a147`，保留其 `CareRequest.exportCollectionStamp`、完整资料导出、共享运营和小程序入口。该候选 `8b9cbf6` 的 PR CI `40438843650` 成功；main CI `40442841501` 独立跟踪，候选通过不替代 main 结论。

三个冲突只合并双方契约：Participation 的当前用途判断共用 T25 effectiveConsentIn，质量专属 grant 和导出专属授权仍独立核验；预览白名单和 Vite 代理同时保留质量与导出路径。未放宽 T23 投产或买方共享，也未改变退款、首次交付及 D03。其余 schema、CareKind、路由、组件、页面清单与 SessionClient 的双方增量均保留。

先核对本机回环且数据库为独立 `timenook_t28`，重新生成本工作树 Prisma Client，再应用独立新增的 `20261026130000_complete_export`；现共 40 迁移，保留所有已应用旧迁移，未修改共享服务配置。日志 `/tmp/timenook-t28-integration-migrate.log`。

- 质量、完整导出、参与授权、撤回、退款、首本及履约七文件按 `--test-concurrency=1` 实际顺序运行，**126/126**，346.6 秒，`/tmp/timenook-t28-integration-api-test.log`。覆盖两个 consumer 各自当前用途、同 epoch 拒绝、旧包/旧 grant、明确新授权、活动流和实际 PDF/ZIP，以及商业冻结、终止、取消占位与唯一活动交接。该轮包含先前 98/12 的重叠用例，不相加。
- Contracts 构建、API 类型/构建/OpenAPI 通过；日志 `/tmp/timenook-t28-integration-api-{typecheck,build}.log`、`/tmp/timenook-t28-integration-openapi.log`。整仓检查留给本次固定提交的 PR CI，45 分钟 workflow 预算未提前更改。
- 相关十一前端文件 **130/130**，前端/运营类型及构建通过，Mac 官方 wcc/wcsc **24 页**；日志 `/tmp/timenook-t28-integration-frontend-test.log`、`/tmp/timenook-t28-integration-{frontend,admin}-{typecheck,build}.log`、`/tmp/timenook-t28-integration-native.log`。其中质量二次申请原子选择、清旧 scope/同机/退款意图及迟到轮询门禁保留。
- 清除本工作树的 Vite 优化缓存后，沿仓库 Playwright 顺序运行真实质量三场与导出一场，**4/4**，42.5 秒，`/tmp/timenook-t28-integration-browser.log`。质量使用 5198/3480/3483，导出使用 5195/3445/3446；实际 API、Page/Vben、PG/Redis、PDF canvas 与 ZIP 都参与验证，只有外部协议使用明确合成替身。缓存清理属于环境准备，没有记作业务 RED。四场完整退出且测试服务均由 afterAll 停止。
