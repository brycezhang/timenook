# T03 受控 AI probe

这是非生产候选协议验证入口，复用 [T02](development-audio-probe.md) 的独立 probe 身份、私有封存片段、owner/hash/storageScope。默认关闭，production 拒绝启用。没有产品采访、正式授权、额度扣减、自动任务队列、故事确认或 UI；人工持有合成/授权样本发起命令。真实账号、条款、授权样本、口音/事实质量、时延和费用仍待验收。[本轮证据](delivery/2026-10-22/evidence/T03.md)。

## 配置和运行

使用 Node22.23.4 / pnpm10.34.7，真实 PostgreSQL/Redis，先按 T02 配置私有 `.env.probe-local`（Git 忽略、mode600）和独立身份。`pnpm db:generate`、在**专用本地 schema**执行迁移、`pnpm --filter @timenook/contracts build && pnpm --filter @timenook/api build`，再 `pnpm probe:api`。内部前缀 `/v1/probes/ai`；受控公网探针目标为独立 API 域名下的 `/api/v1/probes/ai`，见 [ADR 0015](adr/0015-dedicated-domain-ingress.md)。

仅在完成账号/样本准入核验后，在私有配置中显式填写以下字段；没有示例密钥、生产默认模型或商业价格。

| 字段                                         | 要求                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROBE_ENABLED`                           | `candidate`；默认不注册任何 AI 路由                                                                                        |
| `TIMENOOK_PROBE_AI_CONFIG_VERSION`           | 1–80位字母/数字/点/下划线/连字符，记录该次候选参数版本                                                                     |
| `TIMENOOK_PROBE_DOUBAO_API_KEY`              | TimeNook 独立账户的新版 API Key；本适配器不混用 legacy App-Key/Access-Key                                                  |
| `TIMENOOK_PROBE_DOUBAO_RESOURCE_ID`          | 显式选择已开通标准版 `volc.bigasr.auc`（1.0）或 `volc.seedasr.auc`（2.0）；不支持极速/闲时版混用                           |
| `TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS` | 操作员经取源测试确定的窗口，整数1–43190秒；没有默认值或已实测承诺                                                          |
| `TIMENOOK_PROBE_DEEPSEEK_API_KEY`            | 按 [ADR 0011](adr/0011-shared-oss-and-deepseek.md) 复用 deed 的 DeepSeek API key，仅在私有文件保存                         |
| `TIMENOOK_PROBE_DEEPSEEK_BASE_URL`           | 当前按 deed 配置 Packy OpenAI 兼容基址 `https://cf.api.fan/v1`，请求路径追加 `/chat/completions`；旧调用省略时兼容官方地址 |
| `TIMENOOK_PROBE_DEEPSEEK_MODEL`              | 账号实际可用的明确模型 ID；官方当前示例 `deepseek-flash` 仅是候选资料，代码不将其设为默认                                  |
| `TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS`         | 明确的输出预算，整数1–32768；上限是探针保护界限，非已验证模型能力/套餐额度                                                 |

真实取源还需要 T02 的完整 `TIMENOOK_PROBE_OSS_*` STS 配置及 `AUDIO_PROBE_ENABLED=oss`。local-simulator 允许封存及创建记录，推进转写返回409；不会把本机地址发给供应商。测试仅替换外部网络，真实运行没有模拟模型回退。

根目录 `.env.probe-local` 的 `TIMENOOK_PROBE_DOUBAO_API_KEY` 是当前豆包 ASR key 的填写位置；同时填写资源 ID 和取源窗口。共用配置来源、尚缺的 STS/模型参数及启用条件见[共用服务配置](development-shared-services.md)。该入口只配置受控探针，不代表正式业务 Worker 已接通真实供应商。

每个 run 固定无秘密配置快照、提示词 `promptVersion=t03-v2`、输出契约 `outputContract=t03-v2` 及包含凭据的配置摘要。任何资源、模型、预算、配置/提示词/输出契约版本或 AI Key 改变，旧 run 的创建重放、非终态推进和新生成返回409；需恢复原配置查询原任务，或人工核实外部任务后创建明确的新测试 run，不能把新 run 宣称为原任务恢复。密钥只在进程配置里，数据库仅存不可逆摘要，响应不返回摘要或凭据。OSS STS 可更新，但必须仍是原 bucket/region。`t03-v1` 的既有结果可按原字段审计读取，不转换成新契约；不能用旧 UUID 执行 v2 提示词或结构。

## HTTP 命令

所有接口使用 T02 CLI 发放的 probe Bearer，不能以微信会话或 Admin Cookie 代替。响应 `Cache-Control: no-store`。请求 UUID 由调用方一次生成并持久保留，重试沿用同一值。

| 方法/路径                    | 行为                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `POST /runs`                 | 固定已封存 `clipId`、hash、样本版本与候选配置；同 UUID 同输入重放，输入/配置改变409     |
| `GET /runs/:id`              | 取回状态、独立原转录、生成尝试、时间、用量与 `cost:null`；其他 owner/storageScope 404   |
| `POST /runs/:id/advance`     | 首次提交；确定未外发的取源检查失败回ready；已提交/未知/重启后仅查原UUID；终态重放不外呼 |
| `POST /runs/:id/generations` | 仅对非空、成功转录按需生成 `question` 或 `story`；每次尝试有自己的 UUID                 |
| `POST /runs/:id/invalidate`  | 使当前输入和待完成结果失效，保留已有原转录及审计用量；不是删除个人资料                  |
| `GET /metrics`               | 当前身份/存储内按样本类别和完整候选配置分组，列出状态数量、终态失败率及报告用量         |

创建输入示例（UUID、时间和版本需替换成此次真实值）：

```json
{
  "requestId": "00000000-0000-4000-8000-000000000003",
  "clipId": "00000000-0000-4000-8000-000000000002",
  "inputVersion": "synthetic-v1",
  "sampleKind": "synthetic",
  "stoppedAt": "2026-10-22T01:00:00.000Z"
}
```

`sampleKind` 可为 `synthetic` 或 `authorized-sample`，仅是调用方声明，不替代授权证据。`stoppedAt` 是调用方声明的停录时间，不能晚于创建时刻；保存为测量来源 `caller-declared`，不假装真机遥测。输入版本不可修改；换片段/版本前先 invalidate 旧 run，再创建新 UUID。

`advance`、`invalidate` 使用空对象 `{}`。生成示例：

```json
{ "requestId": "00000000-0000-4000-8000-000000000004", "kind": "question" }
```

整理使用另一个 UUID 和 `"kind":"story"`。`question` 与 `story` 都不会覆盖原转录。成功稿仅为候选，`usable` 只表示该记录版本的结构通过且当前输入未失效，不是本人确认；finish/拒答/不适用没有可用问题或稿件。

可在 Git 忽略私有目录放置 mode600 的请求 JSON，用下面方式读取身份、发送并保存响应；不要把 token、签名源 URL、转录或供应商错误复制进终端/issue。调用时以环境变量提供 `PROBE_IDENTITY_FILE`、`PROBE_REQUEST_FILE`、`PROBE_RESPONSE_FILE`、`PROBE_PATH`（例如 `/runs`）、`PROBE_METHOD`，基址限本地受控 API：

```javascript
// 保存为 .probe-local/request.mjs；输出文件所在目录须为 mode700。
import { readFile, writeFile } from "node:fs/promises";
const e = process.env;
const { token } = JSON.parse(await readFile(e.PROBE_IDENTITY_FILE, "utf8"));
const method = e.PROBE_METHOD ?? "GET";
const response = await fetch(
  `http://127.0.0.1:3417/v1/probes/ai${e.PROBE_PATH}`,
  {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body:
      method === "GET"
        ? undefined
        : await readFile(e.PROBE_REQUEST_FILE, "utf8"),
  },
);
await writeFile(e.PROBE_RESPONSE_FILE, await response.text(), {
  mode: 0o600,
  flag: "wx",
});
console.log(`HTTP ${response.status}; response saved privately`);
```

## 状态、恢复和测量边界

ASR 的 UUID 在外部提交前写入 PostgreSQL；claim 使用行锁、30秒租约和 fence。命令返回后由操作员间隔查询，API 不挂起等待整段识别，不使用 BullMQ。进程丢失且租约过期时报告 unknown；第二个 API 实例只 query 原 UUID。旧实例结果不能覆盖新的 fence。若签名后等待导致取源窗口不足，适配器在进入网络前抛出专用检查错误；仅相同 fence 且仍处于 submitting 的 claim 可回到 ready、撤销此次 submitAttempts/提交时间。操作员下一次 advance 重签并提交原 UUID。此分支确定没有进入传输；进入传输后即使出现同类错误，也仍是 unknown，只能 query，不恢复为 ready。HTTP200和业务码20000000在 submit 只代表受理，在 query 才可成为成功；20000001处理中、20000002排队、20000003/45000002无语音，空白成功文本也不生成故事。45000132/45000151为明确大小/格式失败；45000001可能包含重复请求，550系列、缺码、非JSON、未知码或不一致 task_id 保留 unknown，不据此重提。

OSS 服务端签名只对当前封存 key，使用公网 HTTPS endpoint。签名有效期取显式取源窗口+5秒，STS须再至少多5秒；不足则拒绝签发，不缩短后仍声称覆盖。只在服务端传给豆包，不写数据库/响应/日志。V4签名最多受STS与URL较早期限限制。供应商实际可达性、实际取源时刻和云端授权仍需实测。

DeepSeek 单次非流式 `/chat/completions` 请求显式 `thinking:{type:"disabled"}`、JSON Output、无工具，输入只含本片段确定转录/来源；没有多轮、RAG或Agent。服务端检查完整 `finish_reason=stop`、assistant content、JSON字段、空值、单问题形状、当前clip/转录hash的sourceRefs允许清单、usage计数。拒答/不适用须返回无问题/无稿的严格结构。原转录中的指令只作为数据。模型是否中性、是否保留口音/模糊年代/矛盾和真实事实仍需人工核对，结构校验不能证明这些质量。

v2 的正常追问严格使用既定字段，例如：

```json
{
  "action": "ask",
  "question": "关于这段经历，您还想补充什么？",
  "intent": "specific_detail",
  "sourceRefs": ["transcript:<本次clip UUID>:<本次原转录SHA-256>"],
  "reasonCode": "DETAIL_AVAILABLE"
}
```

候选 intent/reasonCode 配对为 `scene/SCENE_AVAILABLE`、`specific_detail/DETAIL_AVAILABLE`、`feeling/FEELING_AVAILABLE`、`meaning/MEANING_AVAILABLE`。`action=finish` 时 question/intent 必须为 null，sourceRefs 必须为空；reasonCode 仅允许 `DECLINED`、`NOT_APPLICABLE`、`ENOUGH_DETAIL`、`USER_FINISHED`。前两者映射 declined/not_applicable，后两者映射 finished；都不标 usable，也不计成功追问时延。finished 是已知终态，计入终态统计。

正常整理稿严格使用既定字段，不带 status：

```json
{
  "title": "合成回忆",
  "paragraphs": [
    {
      "text": "我记得约在八十年代，也可能是九十年代。",
      "sourceRefs": ["transcript:<本次clip UUID>:<本次原转录SHA-256>"]
    }
  ],
  "theme": "年代不确定的合成回忆",
  "reviewItems": ["具体年代待本人核对"]
}
```

本探针只允许一条指向本次封存片段及原转录hash的来源字符串；示例占位符必须由服务端输入清单的真实引用替代。稿件拒答/不适用才允许额外 `status=declined|not_applicable`，同时 title/theme=null，paragraphs/reviewItems=[]；不允许 status 与正常稿混用。旧 sources/uncertainties、缺 theme/reviewItems、未知来源或多题均拒绝。主题和待核对项内容仍须人工验收，有引用不证明事实正确。

生成尝试在请求前持久化。网络未知后同 UUID 重放只返回unknown；进程中断留下的 generating 超过30秒也报告unknown，**不会自动重发**。DeepSeek此接口没有本探针可用的请求查询恢复路径；操作员先核对外部结果/费用，确需新尝试时显式生成新 UUID，可能再次收费。任何失效/身份撤销/封存输入改变都阻止新出站或迟到文本应用；已在网络途中的供应商处理无法由本探针撤销。迟到响应仍可记录经过白名单验证的usage，不保留其文本。

两家网络调用20秒截止、响应体上限1MiB是本地资源保护。超时为unknown，不是任务最终失败或真实业务时延目标达成。公开返回仅白名单字段，不保留 reasoning_content、供应商原始错误或签名源地址。

三段时延为成功转录时间减声明停录时间、成功追问时间减转录时间、成功稿时间减生成命令创建时间，包含各自的人工等待/轮询延迟；只有成功的对应段才有数值。终态失败率分母明确为已知终态，unknown/排队/处理/失效另列，不把这些合成最终失败。ASR `sealedAudioMs` 是T02实际解码时长的合计，**不是供应商计费时长**；DeepSeek用量仅累加实际响应报告的token，缺失数量另列。没有配置真实价格，所有cost保持null，不生成假账单。

测试完成后停止本轮 API，再按T02 `probe:identity --clean` 清理身份、对象及元数据；009外键cascade同时删除本片段AI探针记录。invalidate不删除原声/转录。私人样本、响应文件、费用证据及源地址继续留在Git外。

## 官方协议核对（2026-10-22）

- 豆包：[标准版总页](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelrecordingfilerecognitionstandardversionAPI?lang=zh)、[提交](https://docs.volcengine.com/docs/DoubaoVoice/task-submission-http-1?lang=zh)、[查询](https://docs.volcengine.com/docs/DoubaoVoice/result-query-http-1?lang=zh)、[模型列表](https://docs.volcengine.com/docs/DoubaoVoice/model-list?lang=zh)。两个POST固定 `/api/v3/auc/bigmodel/submit|query`；显式resource/API Key/请求UUID，submit的Sequence=-1，query空对象。兼容总页描述的空submit body；可选task_id必须与既存UUID一致。本代码只支持新版Key，不静默混入旧鉴权协议。
- DeepSeek：[Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[账号模型列表](https://api-docs.deepseek.com/api/list-models/)。Context7与官方页面交叉核对；未调用真实账号列模型。当前官方默认thinking已启用，探针显式关闭以固定候选请求，未宣称该模式质量更优。
- OSS：[V4 URL签名](https://help.aliyun.com/zh/oss/developer-reference/add-signatures-to-urls)、[STS有效期](https://help.aliyun.com/zh/oss/developer-reference/authorized-access-1)、[ali-oss公开SDK](https://github.com/ali-sdk/ali-oss#signatureurlv4method-expires-request-objectname-additionalheaders)。实际使用现有6.23.0的 `signatureUrlV4('GET', seconds, undefined, key)`。
