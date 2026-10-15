# 播放器与实时广播的架构调整（Issue #4）

日期：2026-10-15。关联 [#4](https://github.com/phil616/watch-together/issues/4)、[#3](https://github.com/phil616/watch-together/issues/3)。

## 业务语义与根因

房间消息是即时广播：在线成员收到后应立即展示一次，发送者也接收服务器广播。它不属于影片时间轴，不应等待开始播放、随着暂停停止、被 seek 重播，或者在重新连接后补播。

前面的原型把 `event.chat.message` 转成了 `artplayer-plugin-danmuku.emit({text,time})`。但插件的 emit 实际是把文本加入保留的时间轴队列：

- update 只有在 `art.playing` 时才处理；pause/waiting 会停止渲染循环。
- ready 条件是媒体 `currentTime` 到达消息的 time（约 ±0.1 秒窗口）。
- 队列保留已经显示的文本，回退进度可以再次命中。
- show/hide 与房间过滤开关曾有两份状态，造成插件已开、实时消息却被丢弃的情况。

因此，修正 time 或同步开关只能处理局部现象。即使某次播放中的浏览器测试通过，也不能证明暂停、无影片、重连等情况下符合实时广播语义。

## 最终架构

```text
chat.send → 服务端鉴权、限流、保存 → Room Actor 广播给全部在线成员
                                               │
                                   event.chat.message
                                               │
                              RoomBroadcastStream（房间级）
                                │                  │
                         实时广播展示层         消息栏记录
                         接收即显示一次
                         接收后 8 秒过期

历史消息 API ───────────────────────────────────→ 消息栏记录
播放状态 → SyncController → video              （不进入实时展示层）
```

`RoomBroadcastStream` 是仅消费实时事件的通知通道。订阅时不返回历史消息，不提供回放接口。最近 4096 个消息 ID 用于连接期间去重；通道本身不保存待播放的文本队列。服务端当前协议不补播历史事件，播放器和重连 snapshot 都不向该通道写入消息。

`LiveBroadcastOverlay` 没有 video、currentTime、playbackRate 或房间播放状态引用。它使用接收端单调时钟计算展示截止时间，直接显示文本，八秒后删除。即使动画被关闭、视频暂停或没有影片，也能展示和过期。后台页面恢复时清除已经过期的提示，避免浏览器节流计时器导致旧消息重新出现。

展示层必须遵守播放器的堆叠顺序。实测 ArtPlayer 的 video=10、poster=11、layers=40、播放遮罩=50、controls=60；广播容器现设为 55，位于视频和遮罩上方、控件下方。此前容器 z-index=3，消息已有 DOM 和正确边界却被视频完全覆盖。几何断言与 toBeVisible 无法检测这种遮挡，因此浏览器回归额外在消息中心临时启用命中测试，确认最上层实际是广播卡片，再恢复 pointer-events:none，并结合截图检查。

展示采用画面上的短时消息卡片，不使用影片弹幕队列。没有静音、隐藏、类型过滤或样式面板控制消息是否被接收，旧版 `movie-sync:danmaku=off` 偏好不再生效。减少动态效果只取消入场动画，不隐藏广播。消息栏继续保留纯文本记录，历史记录不会变成新的屏幕广播。

播放器重建仅移动同一个 portal 容器。展示组件和接收时间不重置，因此换源既不会回放旧消息，也不会延长正在展示的消息寿命。容器位于播放器根节点中，使标准元素全屏仍能包含广播。iPhone 原生视频全屏不包含 HTML 层，仍受浏览器系统限制。

服务端发送消息时不再查询播放 snapshot，也不再为新广播分配 `mediaPositionMs`。数据库中的旧可空字段保留以兼容已有记录，无需迁移或清除历史数据。前端消息时间显示发送时间，不再提供点击聊天跳转影片进度的入口。

“全员强制”指当前房间在线连接统一接收、前端不按角色或偏好过滤；断线期间不承诺送达或补播，也不声称已经验证用户阅读。服务端发送队列满时会断开慢连接，客户端重连恢复房间状态。

## 播放器候选与最终选型

数据来自 npm 元数据及上游源码。modified 是包元数据时间，不等于最后源码提交；大小是 npm 解包大小，不是网络传输量。

| 方案 | 维护信号、许可证 | 依赖规模 | 结论 |
| --- | --- | --- | --- |
| [ArtPlayer](https://github.com/zhw2590582/ArtPlayer) 5.4.0 | npm modified 2026-03-12；MIT | 约 544 KB；依赖 option-validator | 保留，用于媒体、控件、设置和全屏；通过 PlayerAdapter 接现有 SyncController |
| artplayer-plugin-danmuku 5.3.0 | npm modified 2026-03-12；MIT | 约 187 KB；无运行时依赖 | 原型验证后移除：时间轴语义与强制实时广播不符，不再为它放宽 CSP worker-src |
| [DPlayer](https://github.com/DIYgod/DPlayer) 1.27.1 | npm modified 2023-01-22；MIT | 约 959 KB；axios 1.2.3、balloon-css、promise-polyfill | 不采用：需额外适配控制和弹幕后端；其弹幕时间轴也不解决实时广播语义 |
| 原生 video + 完全自研控制 | 浏览器维护媒体接口，UI 由项目维护 | 无新增播放器依赖 | 不采用：控制栏、移动触摸、全屏等维护量仍较大 |

ArtPlayer 的播放、暂停、进度、公共倍速继续通过 PlayerAdapter 进入 SyncController。远端校准使用绑定原生媒体方法的直接视图，不从原生媒体事件反推用户指令，避免同步回环。成员修改公共进度仍由同步控制器及服务端鉴权拦截。音量、画中画属于本地操作。字幕接口由 ArtPlayer 支持，但本项目尚无字幕源管理，本次未增加字幕上传功能。

## 验证

- `cd web && npm test`：即时扇出、去重、不重放给晚订阅者、无媒体显示、单调时钟过期、后台恢复清理、文本安全及原有同步算法回归。
- `cd web && npm run test:player`：真实浏览器验证无影片、暂停、缓冲、倍速、回退进度、换源保留原截止时间、减少动态效果、四种全屏尺寸及控制栏隐藏。
- `web/e2e/broadcast.spec.ts`：完整服务和两个独立浏览器，验证在线全员接收、暂停与无影片时即时展示、旧关闭偏好无效、刷新不重放、断线不补播及重连后新消息展示。检查文字实际位于画面内，且通过命中测试确认未被视频遮挡，而非仅有 DOM 节点。
- `web/e2e/watch-together.spec.ts`：保留两浏览器上传、加入、播放同步、进度、消息和恢复测试。
- `go test ./...`、前端 TypeScript/生产构建与 Go 构建。

浏览器测试需要 Playwright Chromium 和 ffmpeg，完整服务测试还需要 MinIO。最终主 JS 约 413 KB，gzip 约 124 KB。Android/iOS 的系统全屏仍需要真机验证。
