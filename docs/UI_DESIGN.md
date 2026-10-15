# 现代 UI 选型与实施

调研与实施日期：2026-10-15。新增依赖使用精确版本并进入 npm lockfile：Mantine core/hooks/modals 9.7.2、Tabler Icons React 3.49.0。

## 选型结论

采用 Mantine 作为通用组件和设计系统，Tabler 作为 SVG 图标库。保留 React Router、ArtPlayer 和现有通信模块。以下适配评价是结合本项目结构作出的工程判断。

| 方案 | 官方提供的能力 | 本项目取舍 |
| --- | --- | --- |
| [Mantine](https://mantine.dev/guides/vite/) | React/Vite 接入、主题、表单控件、布局、反馈与弹窗组件 | 选用。统一主题和交互行为，适合私人影院与工作台混合页面，不需要引入另一个 CSS 框架 |
| [Ant Design](https://ant.design/docs/react/introduce/) | 完整 React 组件及主题体系 | 可行，尤其适合复杂管理后台；当前项目主要是放映、聊天和少量表单，Mantine 已能覆盖需要 |
| [shadcn/ui](https://ui.shadcn.com/docs) | 将组件源代码加入业务仓库，便于定制 | 灵活，但组件源码的后续维护仍归项目；这次希望将通用 UI 维护交给依赖库，所以未采用 |
| [Tabler Icons React](https://docs.tabler.io/icons/libraries/react) | 可按需导入的 React SVG 图标 | 选用，用于导航、上传、成员和消息操作，无外部图标字体请求 |
| [Axios](https://axios-http.com/docs/intro) | HTTP 客户端及请求配置能力 | 暂不迁移；现有 fetch 封装已有 CSRF、同源凭证、响应信封、类型化错误和 AbortSignal 支持，替换没有直接解决本次 UI 问题 |
| [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview) | 服务端数据获取、缓存和失效管理 | 可在资料库分页和跨页缓存需求增长时采用；播放真值与实时消息目前由 WebSocket 管理，不应接入默认缓存重放或自动重试 mutation |

## 视觉与页面

采用深色影院风格：深蓝黑背景、琥珀色主操作、克制的描边，青绿色表示在线和可放映状态，红色表示危险操作。主题色、字体、圆角、通用组件默认属性集中在 `web/src/theme.ts`，主色按钮启用自动文字对比度。

- 登录和注册：左右分区，左侧介绍同步观影，右侧独立表单卡片；手机上纵向排列。使用 PasswordInput 的密码可见性控制和提交 loading 状态。
- 首页：房间与影片统计、新建房间、影片上传、房间卡片、影片卡片。提供骨架屏、语义化错误提示、影片名称搜索和有下一步指引的空状态。
- 邀请：电影票式的单卡片入口，保留昵称输入、身份识别与加入状态。
- 房间：桌面上影片与聊天分栏，窄屏改为纵向；房主影片切换与播放器分开。聊天与成员使用 Mantine Tabs，支持方向键与对应 tabpanel 语义。发送按钮、成员头像和操作使用库组件。
- 确认：删除影片、离开房间和关闭房间使用同一套确认弹窗，支持 Escape、焦点约束及关闭后的焦点恢复。

## 样式与运行时边界

`main.tsx` 只创建一个 MantineProvider 和 ModalsProvider。先导入库的编译后 CSS，再导入业务布局 CSS。当前业务 CSS 使用标准语法，不依赖 Mantine PostCSS 宏。

原先 `button`、`input`、`select`、`label` 和通用标题的全局外观规则已移除。通用控件由 Mantine 管理；`styles.css` 负责品牌排版、页面组合、响应式布局、聊天气泡和播放器适配。不要重新添加全局输入框/按钮外观规则。库组件优先通过 props、theme 或 Styles API 定制。

播放器仍由 ArtPlayer 管理，避免把 React 的表单样式套到其内部控件。广播仍是 RoomBroadcastStream 驱动的独立临时展示，保留接收后 8 秒失效、全员即时展示、不随拖动和重连重播的语义，层级仍为 55。全屏尺寸和移动端 safe-area 适配继续保留。

页面使用 React.lazy + Suspense 分包：登录和邀请不加载播放器实现。生产构建的入口 JS 约 354 kB（gzip 111 kB），房间分包约 178 kB（gzip 49 kB）；完整 Mantine 加业务 CSS 约 261 kB（gzip 39 kB）。这些是本次构建的产物大小，不代表实际网络性能测量。

上传继续通过现有上传服务直达对象存储，保留 multipart、ETag 检查、取消与超时逻辑。邀请链接始终以可选择的链接显示，剪贴板权限被拒绝时仍可手工复制。

关闭房间请求成功后直接更新本地房间状态，避免 WebSocket 先关闭而漏掉最后一个房间事件时无法显示“重新开放房间”。

## 验证与兼容范围

执行前端单元测试、TypeScript/Vite 构建、Go 测试及构建，并用 Playwright Chromium 验证：

- 注册、创建房间、邀请游客、上传、双浏览器播放同步、聊天与刷新恢复。
- 无影片、暂停、播放、换源、拖动、重连时的强制实时广播；实际遮挡检测。
- 全屏、视口旋转、隐藏控制栏和减少动态效果。
- 1440px 桌面与 390px 手机布局、水平溢出检测、标签键盘切换、确认框取消与焦点恢复、房间关闭后重新开放。
- 上传成功与缺少 ETag 的失败路径。

新增 UI 测试位于 `web/e2e/ui.spec.ts`，截图输出到 Playwright 的测试产物目录。复测命令：

```bash
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
npm --prefix web run test:player
# 实际服务测试需要 MinIO，详见 README 的端到端测试说明
cd web && npx playwright test
```

本次实际浏览器验证使用 Chromium。没有把手机尺寸模拟等同于 iOS 真机验证；Mantine 自身的支持范围见[官方浏览器说明](https://mantine.dev/browser-support/)。播放器的 iPhone 系统视频全屏限制继续见 [PLAYER_MIGRATION.md](PLAYER_MIGRATION.md)。v1.1.0 的界面升级没有新增数据库迁移；v1.2.0 的账户体系执行迁移 003，见[账户管理说明](ACCOUNT_MANAGEMENT.md)。

## 播放器内聊天输入

播放器底部和侧栏均使用 `ChatComposer`，由房间级 `useChatComposer` 共享草稿、连接状态、正在发送及错误信息。任一入口编辑后，另一入口同步更新；切换成员侧栏和媒体来源不会丢失草稿。

两处发送统一调用现有 `chat.send` WebSocket 命令，不增加本地乐观消息，也不单独发布广播。服务器的 `event.chat.message` 是记录与实时广播的共同来源，避免重复显示。等待 ACK 期间限制重复发送；成功后仅清理本次提交的草稿，保留等待期间输入的下一条消息；失败和断线不自动重试，保留草稿供用户确认后再次发送。

播放器输入框通过 ArtPlayer 的 `controls.add({ name: "room-chat", position: "right", index: 1, html })` 注册为原生控制器，React portal 只负责渲染和同步房间状态。它与播放、音量、设置按钮共用 `.art-bottom`，由 ArtPlayer 管理鼠标活动唤起、移动端点击切换和播放中约 3 秒闲置收起；没有独立的显隐定时器，也不在视频外部保留输入栏。尚未选择影片时通过侧栏发送消息。

全屏按钮和桌面双击均使用 ArtPlayer 自身画布的全屏容器，输入框随原生控制栏进入全屏；视频继续使用完整视口。窄播放器通过容器查询收起时间、画中画和同步状态开关，为聊天输入及主要播放操作留出空间。源码注入样式具有较高选择器优先级，适配规则限定在本播放器并明确覆盖对应原生控件，避免依赖 CSS 注入先后顺序。

输入框或发送按钮持有焦点时保持原生控制栏可见（包括 Tab 进入），焦点离开后重新开始原生闲置倒计时。播放中闲置隐藏，暂停时沿用播放器默认的控制栏显示规则。iPhone 回退到系统视频全屏时仍无法显示 HTML 输入框，需要退出系统全屏后输入；支持元素全屏的浏览器可直接使用。

共享输入组件隔离媒体快捷键，并区分中文输入法确认与提交。输入期间不会因为空格或方向键触发播放与 seek。对应回归覆盖双客户端双向发送、草稿同步、ACK、失败保留、断线重连、按钮/双击全屏、视口旋转和换源。

## 系统管理中心

复用 Mantine 主题和控件，使用系统概览、用户、房间、影片四个管理入口；桌面显示侧栏与资源表格，窄屏改为两列导航和可滚动表格。表单、确认、搜索、分页与反馈由组件库提供。权限、资源依赖与初始化设计见[账户管理说明](ACCOUNT_MANAGEMENT.md)。
