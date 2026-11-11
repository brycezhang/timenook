# MP07 项目照片交付记录

范围：[#172](https://github.com/brycezhang/timenook/issues/172)，消费 MP01 的公共样式、登录和 `tn-navigation` 契约（集成基线 `cac00f8`）。本票实现与运行验收分别记录，不代表已部署或真机验收。

## 当前接口

- `ProjectPhoto` 归项目；`PhotoIntent` 删除 `interviewId/actualQuestionId`，SQL 同步删除旧复合外键，`PhotoReference(projectId, photoId)` 只接受同项目素材。采访仍有不可变 `PhotoMaterials`，保留历史故事/书稿快照。
- `GET/POST /projects/:id/photos` 列表/预约；`/:photoId/status|upload|seal|release` 复用可靠上传与封存。封存只计一次素材额度，不自动建立采访；release 仅取消未完成上传。
- `GET /projects/:id/photos/:photoId/assets/:assetId/content` 通过项目授权、内容 hash 校验和活动流权限检查下载。`PhotoFiles.open(projectId)` 按账号/项目保留本机待上传原图；`privatePhotoPreview(projectId, photoId, asset, current)` 不再接收采访 ID。
- `GET/POST /projects/:id/interviews/:interviewId/photo-materials` 读取/替换本次照片选择，`/:snapshotId` 读取固定版本；`/:photoId/crop` 为本次关联生成派生快照。重复引用不产生新素材或额外额度，去关联不删除旧引用。
- 封面候选直接读取项目印刷素材，零故事也可选封面。`BookPhoto` 删除不再成立的采访归属字段。
- 原生 `/pages/photos/index?projectId=...` 展示项目空态/两列照片、添加、预览、选择开讲。带 `interviewId` 或 `storyId` 时选择项目素材并明确保存到该次讲述/故事；照片起讲先建采访并追加选图快照，再进入实际录音准备。
- 网页照片页、故事照片、录音展示与封面消费者同步新接口；素材仍通过 Cookie/CSRF 或小程序 Bearer 进行当前权限核验。
- erasure-registry 及 SQL 注册现有 `photo_assets` 和 `photo_references.caption` 均以 project_id 定位。本次只移除 PhotoIntent 的旧外键列，没有新增私有载荷或独立清理路径；当前原图/派生图/冻结快照删除约束沿用。

## 工程验证

- 真实 PostgreSQL/Redis：零采访创建/列表、跨采访复用、一次配额、跨项目拒绝、并发封存与恢复、原图/派生图完整性、裁切和不可变关联、首次故事冻结照片均已执行。
- 零故事封面候选/保存与已有封面冻结 PDF 测试通过。首次 PDF 测试因新工作树缺少固定字体失败；复用已校验的本机字体缓存后通过，未改渲染实现。
- 132 项照片/采访/故事/会话定向页面回归通过；原生与网页类型检查、29 页正式原生编译通过。
- Chromium 与 WebKit 对真实 API/数据库的照片上传中断重试、故事补图/说明、移除关联、项目选图起讲及录音照片显示均通过。测试图片、登录/存储与麦克风输入为隔离夹具，不能据此声明真实微信/OSS/设备采集通过。
- 集成 `dbc58f4` 上补验真实 PostgreSQL/Redis 的历史载荷与文件删除回归通过：`deletion.test.ts` 的 `all historical payloads and owned files disappear while minimum version and financial shells reject restoration`。覆盖当前项目素材与冻结快照清理，未使用线上资料。

## 原生设计与外部验收

主责画板为 `Photos`；390px/320px 原生截图与实际点击流程正在补齐。真实手机相册/相机、微信账号、OSS 和麦克风验收仍另记；本票未部署、未上传体验包、未提审。
