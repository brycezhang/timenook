# T08 本地关系目录与套餐预览

本轮仅完成本地准备。#9 仍受 #5、#6、#8 原生 blocked-by 约束；D01、D02–D08 真实冻结/准入证据和首批 D10 未通过。没有正式发布/开售接口、销售开关、支付、订单或部署。预览冻结不会验证审核记录真实性，也不会授予销售权限。

## 运行与入口

沿用 [本地开发](../../development.md) 与 [管理端说明](../../../apps/admin/README.md) 配置 PostgreSQL、Redis、管理员 HTTPS/MFA；不要打印 `.env` 或密钥。使用 Node 22.23.4 / pnpm 10.34.7。

```sh
export PATH=/tmp/timenook-toolchain/node_modules/.bin:$PATH
pnpm db:generate
pnpm db:migrate
pnpm dev:api
```

API 启动后另开终端运行 `pnpm dev:admin`。管理员按需授予 `catalog:read`、`catalog:write`、`catalog:freeze`；`ops:read` 不授予写权限。管理页“关系与套餐”可新增关系、编辑称呼/排序、启停关系；代码创建后不可改。默认无任何关系 seed，测试称呼不代表已冻结 D10。

“套餐草稿”支持保存缺参、重开草稿、修改名称及重新导入参数；修改使用当前 revision，冲突要求重新打开最新草稿。冻结仅处理已保存的修订；同一草稿修订重放返回同一版本，新修订生成新版本，旧版本内容与 SHA-256 保持不变。

浏览器预览可连接同一个本地 API：

```sh
TIMENOOK_API_BASE_URL=http://127.0.0.1:5173/timenook/v1 \
TIMENOOK_PREVIEW_API_TARGET=http://127.0.0.1:3417 pnpm dev
```

在浏览器开发工具将 `localStorage.setItem("timenook.mode.v1", JSON.stringify("live"))` 后刷新，点击“查看套餐与赠礼称呼”。预览桥接只支持两个公开目录 GET，不伪造微信登录。小程序原生构建沿用 `TIMENOOK_API_BASE_URL`，正式目标须合法 HTTPS 域名与 `/timenook/v1` 前缀；本地 HTTP 仅用于浏览器检查。

## 导入格式

管理端接受 128 KB 以内的 JSON（服务端也逐项校验），四个顶层字段：

| 字段                   | 内容                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `title`                | 套餐名称，1–100 字符                                                              |
| `d01`                  | 下述印刷参数；缺参时可为 `{}`                                                     |
| `admission`            | T05 `commerce-decisions.json` 的完整对象；沿用原检查器，不复制商业规则            |
| `shippingRegionLabels` | D05 支持/不支持地区 code 到公开名称的映射，必须精确覆盖两份清单，不能额外加入地区 |

可从下面的空草稿开始，未填值不生成销售承诺：

```json
{ "title": "套餐草稿", "d01": {}, "admission": {}, "shippingRegionLabels": {} }
```

D01 必填：`widthMm`、`heightMm`、`paper`、`binding`、`color`、`minPages`、`maxPages`、`bleedMm`、`pdfFormat`、`embeddedFonts: true`、`fontLicenseRef`；`review` 含 `state: "frozen"`、`ownerRef`、`decisionRef`、UTC `decidedAt`，还须 `photoMinDpi`。数值没有业务默认值；尺寸/页数/DPI为正整数，出血可为0，最大页数不能小于最小页数。字体许可与审核记录仅保存 `record:` 引用，禁止放入密钥或私人证据正文。T04 候选打样配置不是 D01 冻结记录。

结构完整检查、人工审批真实性、销售状态相互独立：完整文件仍显示 `approval: not_verified`、`salesAuthorized: false`。仅非生产 realm 能冻结 `local_preview`；生产 realm 不能冻结或读取本地预览。数据库按 `(realm, draft_id, draft_revision)` 唯一，并以触发器拒绝版本 UPDATE/DELETE；事务提交版本与成功审计，失败回滚。

测试文件 `apps/api/test/fixtures/catalog-synthetic.json` 仅为隔离测试夹具，里面的期限、额度、地区、印刷规格、商户/AppID和证据引用全部是合成值，不能导入正式运行数据或用于售卖。

## 公开接口与后续消费

- `GET /v1/recipient-types`：仅启用关系的 code、称呼和 revision；支持自定义称呼且不推断身份权限。
- `GET /v1/packages/current`：`purchasable` 恒 false；无版本时为 `PACKAGE_PREPARING`，本地版本为 `PREVIEW_ONLY`。白名单 DTO 只含价格、范围、消费者条款、版本和 hash，不包含完整 admission、证据引用、负责人、供应商材料、商户/AppID或成本预算。
- 管理端 `GET/POST /v1/admin/catalog/recipient-types`、`PUT .../recipient-types/:code`；`GET/POST .../package-drafts`、`PUT .../package-drafts/:id`、`POST .../package-drafts/:id/preview-versions`、`GET .../package-versions`。写命令需要完整会话、相同 Origin、会话绑定 CSRF及对应权限。

后续订单票可消费 `RecipientSelection`：目录选择 `{recipientCode, recipientRevision, customLabel:null}`；自定义选择 `{recipientCode:null, recipientRevision:null, customLabel}`。T08 仅维护当前页面选择，未实现订单/项目持久化或销售快照。T10 必须重新核验启用状态、关系修订与正式销售版本，并冻结自己的快照，不能把本地选择当授权。

小程序 live 模式失败时清空旧套餐并明确提供重试；不会回退妈妈/爸爸静态目录或创建演示项目。demo 模式仍独立使用已有本机体验。任何情况下本票不调用微信付款。
