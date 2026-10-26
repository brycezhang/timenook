# 撤回、活动访问与生产暂停（T24）

本票 [#25](https://github.com/brycezhang/timenook/issues/25) 在 T23 固定生产尝试基础上贯通撤回。仅沿用隔离合成入口；D06/D08、供应商处理与双端设备仍须实际验收。

本人在参与页分别拒绝或撤回采集、AI 处理和共享。无个人微信的讲述者可同机表达当次选择，或由客服代录并按冻结 D08 核验；付款身份不能直接调用本人的用途命令。客服撤回工单可指定单项用途，省略时沿用三项全部撤回的既有契约。

## 访问与恢复

`POST /v1/projects/:id/consents[/revoke]`、当次协助拒绝、客服核验和换绑复用 T11/T12。本人/客服撤回及换绑先在同一数据库事务提交用途拒绝、epoch 和最少 `project_access_revocations` 记录，再执行可补扫联动。后续执行失败不撤回已提交的拒绝。记录以 UUID 为主键，并保存单调序号、旧 Session、精确 task id/fence 和当时生产尝试编号；这些目标及用途、原因、project/epoch、创建时间不能改写，执行结果一经记录不能覆盖。恢复不按当前同 epoch 队列或创建时间重新圈定目标。

T12 的同机用途互相独立：拒绝一个用途新增该用途 Session fence，不改变其他用途或全局 epoch；相关旧任务仍失效。全局撤回和账号换绑保留既有 epoch 语义。`Participation.reconcileRevocations(projectId?)` 处理未执行记录；受控服务每秒补扫，状态查询亦可恢复未执行记录。新确认/任务/首本/交接仍由其原用例在当前授权及项目锁下重验，不能凭旧结果重新放行。旧候选遗留的未执行记录缺少精确目标时保持待人工，迁移不拿后来的同 epoch 工作替它补填目标。

私有原声、书中原声、照片、用户 PDF 和运营交接 PDF 采用同一 `ProjectStreams.guard(projectId, epoch, bytes, check, authorization?, capturedSequence?)` 边界。入口在文件 I/O 前用 `userFence`/`fence` 固定 epoch 与单调撤回序号；旧补扫只关闭该序号之前的相关流，新授权后的同 epoch 流不受旧记录影响。每块最多 64 KiB，发送前核对当前 epoch、会话及调用者的版本/用途/期限检查；同进程在已提交撤权后关闭活动流，其他进程和背压空闲流每 100 ms 查 PostgreSQL 补验。该机制不依赖 Redis 才能拒绝访问，也不声称能取回传给设备/网络的字节。Range 仍按实际范围及完整长度返回，禁止 OSS 跳转。

受控原声页每秒重新解析固定书中版本；故事、校对、照片、项目、书稿、确认和生产页定期重验当前授权，失效时清除显示、私人草稿及临时回听/预览。照片采集页沿本次 collection-check（含 assistedSessionId）复验，不用是否授权共享来判断采集许可。离页与切号继续清理。用户本机原录音、主动另存的 PDF/导出和实物无法远程回收；缓存清理不能代替资料删除。

## 任务与生产

撤回事务捕获的旧 task ID 永久拒绝，不因重新授权或领取新 lease 而恢复。转写、追问、故事整理在原项目授权锁内，领取、外部发送前及结果落库时查询不可改写的撤回目标；书稿渲染的领取与产物接纳沿同一目标检查。该检查读取已提交记录，不等待 cleanup 或其 appliedAt。重试入口与 retryable 同样拒绝旧 ID，重新授权后创建的不同 task ID 继续按原规则处理。

补扫按捕获的 task ID 失效当时的当前任务，使用读取的当前 fence 做 CAS，不再用捕获时的 lease fence 作为是否属于旧任务的判断。旧任务按原 kind 进入 `invalidated`/`obsolete` 并增加 fence，迟到结果不能生效。仅尚未进入外部传输的 `preparing` 费用预留释放；已经进入供应商传输或结果未知的尝试保留核实依据。

采集、共享或全部撤回使交接前的尝试停止；已经交接、接单或发货进入取消待核实，运营继续沿 T23 的印厂回执处理。已交付的纸书保留交付事实。AI 单项撤回不自行取消实物。预留/已消费的首本权益和 PaymentOrder 商业冻结不由撤回来释放或清除。换绑保留 subject 和历史确认，不作为全项目删除。

`GET /v1/projects/:id/withdrawal-status` 允许当前发起人/讲述者在内容访问停止后查询最少处置状态，不返回姓名、故事、PDF 或地址。原账号换绑后不能查询。本人参与页/同机页提供“查看撤回处置进度”，共享运营工单详情展示范围、系统联动和实际生产阶段、负责人及期限。

## 本地复现

使用回环 PostgreSQL/Redis；不要把云端数据库配置传入测试。安装锁定依赖、生成 Prisma Client 后，先按开发说明准备固定字体与 Chromium。下面的环境值只用于本机容器：

```sh
DATABASE_URL=postgresql://timenook:local-development-only@127.0.0.1:54329/timenook_t24 REDIS_URL=redis://127.0.0.1:63791 pnpm --filter @timenook/api exec sh -c 'tsc -p tsconfig.test.json && node --test dist-test/test/withdrawal.test.js'
pnpm exec tsx --test tests/book-audio-page.test.ts tests/production-page.test.ts tests/participation-page.test.ts
pnpm check:native
```

数据库 `timenook_t24` 为本地测试容器内独立数据库，测试继续使用随机 schema 和 Redis 前缀。实际浏览器回归使用既有 `production-shipping.spec.mjs`，只用合成私人内容与协议替身。运行时避开其他测试占用的 5190/3440/3443 端口。

真实 D08 本人核验、D06 人工渠道/期限、印厂取消回执及微信双端清理尚未取得；T24 保持 OPEN，不据本地结果开售。
