# 独立管理员与本地管理入口

T07 管理身份独立于小程序账号。只有受控 CLI 可建号，未提供注册 API、默认管理员或默认口令。管理员只持有明确列出的 `ops:read`（运行信息）和 `audit:read`（最近100条审计）权限；空权限账号可以登录但不能查看这两类信息。管理员身份没有私人内容权限。

## 配置与建号

首先执行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm --filter @timenook/api build`。API 使用 `.env` 的独立 PostgreSQL/Redis；管理员另配置 `ADMIN_ORIGIN` 和 `ADMIN_ENCRYPTION_KEY`，生产缺少配置时拒绝启动。本地可放在 `.env.admin-local`（Git 忽略且600），启动 API 时显式加载：

```sh
node --env-file=.env --env-file=.env.admin-local apps/api/dist/main.js
```

`ADMIN_ORIGIN` 必须是不带路径的 HTTPS origin；本地 `https://localhost:3443`，目标生产 `https://lawyerapi.threeminreading.com`。`ADMIN_ENCRYPTION_KEY` 为密码学随机32字节的base64字符串，服务端保管，用于 AES-256-GCM 加密 TOTP 种子与派生 CSRF；不填到 Vite 环境变量、不输出或提交。不复用其他应用密钥。密钥丢失会阻止现有 MFA 验证；正式备份/轮换流程由发布验收另行验证。

以安全编辑器在受限目录创建 mode-600 JSON 文件，字段为 `username`、`password`、`permissions` 和 `realm`。账号格式为3–64位小写字母/数字/点/下划线/连字符；密码16–128字符且使用独立随机强密码；permissions 只接受上述两项；本地 realm 为 `local`，生产为 `production`。不要把密码放进 shell 命令、argv、聊天、截图或日志。

```sh
pnpm admin:create --input-file /absolute/private/admin-create.json
```

CLI 拒绝符号链接、非当前用户所有、组/其他用户可读、超过8KiB的文件，拒绝同realm重名和realm不匹配；只输出管理员UUID、realm和待MFA初始化状态。完成后移除输入文件中的密码或安全删除该一次性文件。本地账号不在生产realm中查找，不能用于生产登录。

生产从已发布目录调用 `node --env-file=/private/production.env dist/admin/admin-cli.js create --input-file /private/admin-create.json`，仅加载该生产环境文件。使用独立生产数据库、Redis前缀、加密密钥和强口令，由实际管理员登录后在自己的身份验证器中添加 TimeNook 并完成一次有效TOTP。没有生产账号或MFA种子随源码发布。

## 会话规则

- 密码通过仅获得5分钟挑战；首次MFA初始化数据仅在该挑战且账号尚未完成初始化时可读取。完整会话必须再通过六位TOTP。
- 采用标准30秒TOTP，接受当前及前一时间步；成功时间步以PG锁和事务全局消费，重复、并发或旧验证码拒绝。Redis按账号/IP限速，Redis不可用时不继续尝试密码/MFA。
- 完整会话绝对有效期8小时，挑战默认5分钟；可通过 `ADMIN_SESSION_TTL_SECONDS` / `ADMIN_CHALLENGE_TTL_SECONDS` 缩短，最大仍为8小时/5分钟。没有静默续期。数据库持久化会话，所以 API 重启保留未到期会话，到期/注销后不可恢复。
- 专用 `__Secure-timenook_admin` Cookie：Secure、HttpOnly、SameSite=Strict、host-only、Path=`/timenook/v1/admin`。不覆盖 legal-agent 的 Cookie，不发往其 `/v1` 或小程序身份接口。Cookie Path 是浏览器发送范围，同源其他应用的 XSS 仍属于共享源风险；身份权限仍由独立账号/会话表验证。
- 所有写请求必须携带与当前Cookie绑定的 `X-CSRF-Token`，Origin必须精确匹配配置；跨站请求拒绝。密码/MFA成功会轮换并撤销旧挑战；退出同时撤销服务端会话和清Cookie。前端在完整会话或MFA挑战失效后恢复登录。
- 若 MFA/密码轮换已先消费旧挑战，并发退出该旧挑战返回401且不清除新Cookie；调用方须用当前会话重新退出，不能把旧挑战的退出失败当作新会话已撤销。该规则只作用于当前会话，不注销其他设备。
- 会话创建/轮换/注销与成功审计同PG事务，事务提交后才发送Cookie。审计失败导致事务回滚，不会发出新的有效身份。审计只记录operatorId、固定action、服务端生成requestId、result和时间；不记录请求体、密码、验证码、种子、Cookie/CSRF令牌、云key或完整地址。
- DTO、跨站或会话阶段拒绝也从有效Cookie解析已知操作者，使用固定路由动作；无法识别时记录空操作者。失败审计不可用时保留原安全HTTP错误，不返回原始数据库异常。

## 验证与部署边界

`pnpm check` 含既有小程序测试、API真实数据库测试以及管理端类型/构建；`pnpm api:openapi` 导出契约；`pnpm test:admin-browser` 走实际CLI、真实PG/Redis、HTTPS浏览器路径（独立临时schema和前缀，自动清理）。管理端开发与浏览器要求见 [apps/admin/README.md](../apps/admin/README.md)。

本地通过只证明实现和本地合成账号流程。真实管理员MFA初始化、生产机运行与重启、TLS/Nginx静态入口、正式数据库/Redis与密钥保管、与legal-agent共域回归仍待T29及真实管理员验收；本票保持未关闭。
