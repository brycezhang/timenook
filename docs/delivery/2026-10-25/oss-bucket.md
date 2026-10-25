# 2026-10-25 OSS 独立 Bucket 切换

按用户要求及 [ADR 0013](../../adr/0013-dedicated-oss-bucket.md)，TimeNook 已于 2026-10-25 21:44（Asia/Shanghai）切换到独立私有 Bucket `timenook`，地域 `cn-shanghai`。服务端 OSS AccessKey 继续沿用 deed，探针对象前缀保留 `timenook/probe/`。

## 配置与切换

阿里云 [Bucket 创建说明](https://www.alibabacloud.com/help/en/oss/user-guide/create-a-bucket-4)明确 Bucket 不能直接改名。本轮已核实同一账号下的 `timenook` Bucket 存在，配置为 private / Standard / ZRS，且整个 Bucket 为空；旧 `lawyer-agents` 的 `timenook/` 前缀为空，云端 probe、录音、照片的素材及意图记录均为 0，无需迁移对象或改写 `storageScope`。

| 配置位置                                | 已完成调整                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| 本机 `.env.shared-local`                | `ALI_OSS_BUCKET=timenook`；mode 600                                                 |
| 本机 `.env.probe-local`                 | `TIMENOOK_PROBE_OSS_BUCKET=timenook`；mode 600                                      |
| ECS `/data/server/timenook/shared/.env` | 仅修改 `TIMENOOK_PROBE_OSS_BUCKET`，保留 root:timenook、mode 640                    |
| 服务                                    | 只重启 `timenook-api.service`，继续回环监听 `127.0.0.1:4310`                        |
| 应用产物                                | 沿用 `/data/server/timenook/releases/20261025-packy-045625`，本轮没有代码或依赖变更 |

服务端原配置备份为 `/data/server/timenook/shared/.env.before-bucket-timenook-20261025T134427748Z`，mode 600。后续回退须先核对新 Bucket 是否已有素材；不能在已有新素材后直接恢复旧 Bucket 配置。配置文档与示例已更新，重新映射 deed 凭据时不得覆盖本项目 Bucket 名。

deed 环境文件的切换前后 SHA256 一致，API / Worker / Web 的 PID 未变化，三项服务均 active；旧 Bucket 未被修改或清空。

## 真实运行验证

使用新建的短期 probe 身份和既有 8.637 秒固定合成中文音频，通过公网 API 验证，未使用私人素材。

| 检查                                                   | 结果                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 公网 `/timenook/health/live`、`/timenook/health/ready` | 均 200                                                                                                    |
| deed 公网 `/v1/health`                                 | 200                                                                                                       |
| 上传授权                                               | 返回地址为 `https://timenook.oss-cn-shanghai.aliyuncs.com`，精确 key 位于 `timenook/probe/staging/`       |
| 真实 V4 PostObject                                     | 204                                                                                                       |
| API 封存                                               | 201，状态 sealed，时长 8637 ms；数据库 `storageScope` 对应新 Bucket                                       |
| 鉴权回听                                               | 200，下载 SHA256 与上传一致                                                                               |
| 无 Bearer 回听 / OSS 未签名访问                        | 分别为 401 / 403                                                                                          |
| 部署适配器的 ASR 取源签名                              | 新 Bucket 的限时 HTTPS URL 返回 200，SHA256 与封存记录一致                                                |
| 清理                                                   | 本轮身份已撤销，测试对象和元数据已清理；probe clips / AI runs 为 0，新旧 Bucket 的 `timenook/` 对象均为 0 |
| 重启后日志                                             | 检查窗口内 error / fatal / exception 行为 0                                                               |
| 本地回归                                               | API 测试 TypeScript 编译成功；`oss-config.test.ts`、`oss-probe.test.ts` 共 7/7 通过                       |

本轮未重复调用豆包或 Packy；此前完整 AI 链路结果仍按[原记录](cloud-integration.md)的 Bucket 和配置范围适用。本轮证明新 Bucket 的上传、封存、私有读取及签名取源，不代替浏览器 CORS、真机录音或正式发布验收。

原始结果保存在 Git 忽略目录 `.probe-local/oss-bucket-2026-10-25/`；服务器摘要为 `/data/server/timenook/shared/bucket-timenook-switch.json`、`bucket-timenook-verify.json`。凭据和短期身份不进入 Git。
