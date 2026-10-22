# T02 受控音频 probe

这是独立的非生产测试链路，不创建产品账号、采访、转写、计费或授权记录。T03 的[受控 AI probe](development-ai-probe.md)可按需复用其封存片段，仍不创建产品授权/故事记录。默认关闭；服务端production拒绝probe配置，小程序默认构建关闭且release页面拒绝进入。CLI是唯一身份发放入口；微信bearer、Admin Cookie与probe身份互不代替。

## 本地重现

先按[本地开发](development.md)启动真实PostgreSQL/Redis，执行 `pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm db:migrate`。使用Node22.23.4/pnpm10.34.7。

1. 复制 `.env.probe-local.example` 到Git忽略的 `.env.probe-local`，权限600，填入本项目 `.probe-local` 的绝对路径。数据库/Redis继续从根 `.env` 读取。默认local-simulator用mode700目录、mode600文件模拟私有对象；不代表OSS。
2. 安装FFmpeg/ffprobe8.1.1，或运行 `bash scripts/setup-audio-tools.sh /absolute/private/tools/ffmpeg` 并在私有环境文件设两个binary路径。脚本锁定官方源码SHA-256，只启用MP3解码及必要协议/PCM输出；CI运行同一脚本，产物在runner临时目录。
3. `pnpm --filter @timenook/contracts build && pnpm --filter @timenook/api build`。
4. `pnpm probe:identity /absolute/path/to/timenook/.probe-local/session.json`。文件mode600，不输出token。默认1小时到期，可配置1–3600秒；没有公开发token端点。Redis丢失会令测试身份失效。
5. `pnpm probe:api` 启动独立本地API进程。另一个终端执行 `TIMENOOK_AUDIO_PROBE_BUILD=1 TIMENOOK_API_BASE_URL=http://127.0.0.1:3417/v1 pnpm build:frontend`；开发工具打开项目，编译入口选 `pages/audio-probe/index`。本地构建不等于真机接入。
6. 在受控页粘贴身份文件内容（密码输入框，连接后清空）。只录合成声音或已获同意样本。停录后文件与清单均成功才提示本机保存；再手动上传。HTTP204只是暂存，服务端解码、复制/hash复验及事务提交后才sealed。模拟明确显示“本地模拟封存”，OSS复验才显示“云端已保存（受控测试样本）”。
7. 离开页面停止回听并清理下载临时文件；清理失败明确提示，不启动新下载。原始本机录音为重试保留；测试结束用开发工具清理本小程序文件/存储，不把缓存清理称为删除原始录音。
8. 停止**本轮probe API进程**后，运行 `pnpm probe:identity --clean /absolute/path/to/timenook/.probe-local/session.json`。撤销此身份，删除当前存储配置下此身份的暂存/最终对象及元数据，最后删除身份文件；过期身份也可清理，不触碰其他身份/产品数据。失败保留文件供重试。不要在仍有上传/封存请求时清理。

## 接口与参数

内部前缀 `/v1/probes/audio`；未来公网由ADR0009添加 `/timenook`。模拟上传保留完整API基址，OSS上传用绝对Bucket HTTPS地址。

| 接口                   | 行为                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| POST /clips            | probe bearer；clientClipId UUID、bytes、sha256；真实PG锁/唯一性保证重复/并发同一片段，输入变更409 |
| GET /clips/:id         | 当前身份及存储配置的片段；外来身份或不同存储配置404                                               |
| POST /clips/:id/upload | 精确staging key/长度/短时表单；本地为Redis capability，OSS为SDK V4签名                            |
| POST /objects          | 仅本地multipart模拟，file最后、1文件/2MiB；越key/过期拒绝；sealed后不可写                         |
| POST /clips/:id/seal   | 原始hash/大小、MP3/16kHz/mono、完整解码≤300秒；复制到客户端不可写sealed key并读回复验；事务提交   |
| GET /clips/:id/content | 下载前后鉴权，private/no-store；200/单Range206/非法Range416；未封存409；不发公共媒体URL           |

候选录音参数为MP3、16kHz、单声道、48kbps、RecorderManager最大300000ms。服务端硬上限2MiB、完整解码300000ms。MP3填充、平台格式差异及保存能力仍需双端验证；页面时长取停止回调，封存时长取PCM样本数，不混称。1秒合成夹具包含1080ms音频帧。失败按完整文件重试，不宣传字节级断点续传。

FFmpeg采用file/pipe协议白名单、MP3 demux/codec白名单、单线程、每子进程15秒、单次分配16MiB、诊断64KiB、PCM输出9.6MB上限；finally删除临时解码目录。单次分配限制不是OS内存隔离，不把受控probe当成生产不可信媒体沙箱。

API重启保留数据库/对象。复制成功但落库失败可能留下不可访问的孤立最终对象；重试核验暂存并覆盖/复验同一最终key，清理命令删除两区。设备已下载副本不承诺远程擦除。测试身份过期后不能继续访问旧数据；用原身份文件清理后重新发起测试。

## OSS 候选代码与真实待验收

oss模式只用独立 `TIMENOOK_PROBE_OSS_*` 配置，无其他应用凭据回退。操作员提供已有短时STS，过期后更新私有文件并重启本轮probe；没有自动AssumeRole轮换。客户端表单不含AccessKeySecret，只含精确key、private ACL、长度限制及STS安全令牌。过期时间取上传TTL、120秒硬上限、STS过期前5秒中的最小值；最终key永不授予客户端。

真实 `ali-oss@6.23.0` 执行V4签名、私有复制、读取与删除。nock只截获HTTPS网络边界，检查真实SDK的method/header与结果；签名有独立Python hmac/hashlib固定夹具。这是**候选契约代码验证，未证明真实OSS/RAM接受**。

真实联调需独立TimeNook private Bucket并禁止公共访问、最小RAM/STS权限（暂存Put/Get/Delete，最终仅服务端Put/Get/Delete，限制ACL操作）、生命周期及合法uploadFile/downloadFile域名、独立AppID。匿名读取、越key、过期policy/STS需云端实测；不得改成公共桶绕过配置。

依据：[PostObject](https://help.aliyun.com/zh/oss/developer-reference/postobject)、[POST V4](https://help.aliyun.com/zh/oss/developer-reference/signature-version-4-recommend)、[ali-oss](https://github.com/ali-sdk/ali-oss#signpostobjectpolicyv4policy-date)、[FFmpeg协议](https://ffmpeg.org/ffmpeg-protocols.html)。微信官方网页本轮访问失败；候选参数对照已安装官方miniprogram-api-typings，sha256等仍需真实基础库/双端验证。
