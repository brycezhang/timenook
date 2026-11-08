# 时光故事 · Web

让每一段往事，都有处安放。

配色取自小程序 `miniprogram/styles/tokens.wxss`，精确保留全部 12 个颜色 token。网页沿用暖白纸色、棕色操作与橄榄绿状态；shadcn 式细边框、8px 按钮圆角和清晰层次承载项目、故事、录音、书稿与我的。

## 有意调整

网页使用 15px 正文、18px 阅读字号；手机优先，所有主要触控目标至少 44px。桌面侧栏与手机底栏共享同一组目的地。这里只提供浅色主题；无外部字体。

组件 Button、Input、Status、ProjectCard 为本轮网页设计新增，使用语义 HTML；业务 UI 使用 Vue 3 实现。

## 语义映射

background → paper；foreground → ink；card → surface；primary → brown；primary-foreground → surface；secondary → sand；muted-foreground → muted；border → line；ring → brown；destructive → danger。原生 muted 是文字颜色，网页 muted 是底色，因此保留原生名称并为网页使用显式别名。

## 组件原则

主要操作每个区域一个；状态包含文字。边框 line 仅作装饰分隔，表单另用 muted 形成可识别边界，键盘焦点用 brown。阅读正文用宋体配 1.95 行高，其余使用系统无衬线字体。

## 来源

小程序 token 与字号来自上述源码；组件结构参考 https://shadcn-vue.com/docs/theming 。样例项目与故事均为设计演示，不表示真实用户资料或已生成的书稿。
