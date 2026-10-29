# 内测项目的真实录音处理链路

[#98](https://github.com/brycezhang/timenook/issues/98)／[#99](https://github.com/brycezhang/timenook/issues/99) 在无付款内测项目上复用既有 `OssProbeObjects`、`DoubaoFileAsr`、`DeepSeekText` 和持久化生产 Worker。录音仍先由服务端校验与封存，再创建转写任务；追问按需发起，整理故事等待所选录音正式转写就绪。

## 受控配置

`INTERNAL_ACCEPTANCE_ENABLED=1` 启用内测准入；配置 `TIMENOOK_PRODUCT_OSS_BUCKET` 后才同时装配真实录音、照片、转写和整理。仅账号／项目准备不要求供应商配置。内部配置不启用付款、微信替身或首本制作权益。网页和独立隐私台账仍由既有配置提供。

```dotenv
INTERNAL_ACCEPTANCE_ENABLED=1
TIMENOOK_PRODUCT_STORAGE_ROOT=/data/server/timenook/runtime/internal
TIMENOOK_PRODUCT_OSS_BUCKET=timenook
TIMENOOK_PRODUCT_OSS_REGION=cn-shanghai
TIMENOOK_PRODUCT_OSS_KEY_PREFIX=timenook/product/internal
TIMENOOK_PRODUCT_OSS_ACCESS_KEY_ID=
TIMENOOK_PRODUCT_OSS_ACCESS_KEY_SECRET=
TIMENOOK_PRODUCT_DOUBAO_API_KEY=
TIMENOOK_PRODUCT_DOUBAO_RESOURCE_ID=volc.seedasr.auc
TIMENOOK_PRODUCT_DEEPSEEK_API_KEY=
TIMENOOK_PRODUCT_DEEPSEEK_BASE_URL=https://cf.api.fan/v1
TIMENOOK_PRODUCT_DEEPSEEK_MODEL=deepseek-flash
```

服务端沿用已授权的共用 AccessKey／DeepSeek 来源，单独映射产品变量；凭据不进 Git、浏览器或日志。产品前缀必须位于 `timenook/product/`，与 `timenook/probe/` 分离。客户端只获得精确暂存对象的短期表单，服务端私有保存、校验和 ASR 取源仍用原适配器。跨域上传需要 Bucket 实际允许网页域名，须以真实浏览器另验。

`internal-media-v1` 使用 600 秒 ASR 取源窗、3 秒轮询、10 分钟处理截止、4096 token 整理上限；每次供应商提交预留 1 分，仍受内测项目快照的次数、重试和总预算约束。照片采用 120×160 mm 内测候选版位。这些是内部受控参数，不表示商业 D04／D08 或印厂规格已通过。

独立 Worker 沿用 `node apps/api/dist/tasks/worker-main.js`；读取与 API 相同的私有环境，Redis 仅唤醒 PostgreSQL 中已持久化的任务，不需要新队列协议。

## 来源和确认

录音、照片、任务预算、可选追问和故事额度统一读取 `readProjectAdmissionIn`；已付款项目继续读订单快照，内测项目读不可变内测准入快照。两种来源不相互伪装。

内测故事确认与人工校正授权使用 `internal-participation-v1` 和客户端 `internal:` 操作意图。正式记录的渠道与会话由服务端解析真实 Session／WebSession，网页本人确认保存为 `self_web`；原生微信和协助方式分别保留。正文确认与允许入书仍是独立选择，修改版本不继承旧确认。

## 已验证与待验

定向集成覆盖真实 PostgreSQL／Redis、Cookie 登录、无付款项目、两账号邀请和用途授权、原件封存、ASR／整理协议、实际生产 Worker、确定故事确认与 `self_web` 记录；其中 OSS 传输和 AI 网络由明确替身承接。原有保存后处理、等待全部转录及内容确认可拒绝入书的相关用例继续通过。

真实供应商效果、手机设备录制、同域部署及完整 PDF 验收必须在实际运行记录中单独列出，不能由上述替身测试推定完成。

目标ECS的实际连接诊断发现Node默认网络族尝试很快以ETIMEDOUT结束；同一服务用户、systemd约束和DeepSeek适配器在`NODE_OPTIONS="--network-family-autoselection-attempt-timeout=1500"`下返回正常JSON。该配置已进入目标私有环境并重启API/Worker，保留20秒HTTP总超时与原任务不确定结果。实际修复后业务结果见[运行验收](delivery/2026-10-29/mobile-web-online.md)。
