# T07 独立代码审查

初始审查范围：`git diff 1f4e3a740bad090ded33078481e1becb79241b78...edeccd67503c0de32ec9300490942916cb769908`。双方引用有效、diff 非空；提交为 `edeccd6 feat(admin): add independent MFA operator access (#8)`。两个独立 Agent 分别审查工程规范与规格，均不修改实现。PR 为 [#36](https://github.com/brycezhang/timenook/pull/36)，关联 #8，外部验收仍未完成。

## Standards

初审：明确违约2项、判断性建议1项；轴内最严重P2。

1. P2：`onSend → auditUnhandled` 未捕获失败审计异常。无效登录载荷遇到数据库不可连接时，原400被原始500覆盖，暴露Prisma内部错误/地址并丢失统一响应。违反开发文档错误脱敏规则和统一响应约定。成功身份变更仍须审计同事务；失败审计不得覆盖原安全响应。
2. P3明确违约：管理端、API DTO与CLI/页面分别定义公开契约和权限码，违反工程基线的契约集中约定。应由 `@timenook/contracts` 统一供两端消费。
3. P3判断性建议（可能的Duplicated Code）：前端重复清理身份、MFA材料、审计和运行状态，建议小函数集中清理以免遗漏。

审查核对Vben固定上游14包385文件，非manifest源码的三处兼容修改有来源记录；未把原上游通用能力算作自造业务范围。

## Spec

初审：2项P2，均为看似实现但错误；轴内最严重为注销与MFA竞争。

1. T07要求落实注销。真实PG行锁控制交错，先MFA后logout排队，释放后得到MFA200、logout204、新Cookie仍可访问runtime200。旧挑战被旋转后，注销不得误报完整授权已撤销。
2. T07要求审计记录操作人、动作、请求标识和结果。有效管理员Cookie提交格式无效MFA，400审计却为 `admin.invalid / operatorId=null`。校验拒绝路径应安全解析有效身份并使用固定动作映射，不记录输入或URL。

没有额外范围扩张发现。正式管理员MFA、生产部署和真实供应商验收按已确认边界保留，不能由本地合成账号替代。

## 修复与复审

修复提交：`36efcd71a34f3bebfc9170a431168ede934fb3b5 fix(admin): preserve safe rejection and logout semantics (#8)`。复审增量为 `git diff edeccd67503c0de32ec9300490942916cb769908...36efcd71a34f3bebfc9170a431168ede934fb3b5`。

- Standards复审：原2项明确违约、1项判断性建议全部闭环；新增明确违约0、heuristic 0。审查Agent独立以不可连接合成数据库复现，得到标准400/INVALID_REQUEST/error+meta，无Prisma或数据库地址泄漏。
- Spec复审：原2项全部闭环；新增问题0、未解决问题0。审查Agent独立重跑5项真实PostgreSQL/Redis HTTP回归通过，包含固定行锁交错、正常注销与拒绝审计归属。

修复采用当前会话的条件撤销：旋转已消费旧挑战时返回401，不清新Cookie，不擅自注销其他设备；失败审计共用安全身份解析且不覆盖原安全响应。公开契约和权限码集中至共享contracts，前端统一清理身份状态。

最终本地检查：99项测试（前端35/API64）、2项锁定Chromium浏览器、类型检查、构建、OpenAPI和frozen install均通过。四组行为回归保留实际RED→GREEN日志，见[T07证据](T07.md)。测试资源清理完成，原迁移未改。

初始提交`edeccd6`的push/PR两条Linux CI均通过；修复后最终HEAD检查以[PR #36 Checks](https://github.com/brycezhang/timenook/pull/36/checks)为准，必须通过才合入。正式管理员MFA、共享域名和部署仍为外部待验收，不关闭#8。

最终轴内结论：Standards未解决0；Spec未解决0；两轴均无剩余严重项。
