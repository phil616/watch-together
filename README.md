# 远程放映室

> 注:项目采用开放注册和开放端口,建议再套一层零信任保护项目,避免流量被盗刷产生添加账单,七夕快乐

远程放映室是一个可自行部署的异地同步观影应用。房主维护唯一公共时间线，成员从私有 S3-compatible 对象存储直接读取视频，Go 服务只传递权限、播放状态与文字聊天。页面刷新或 WebSocket 重连后，客户端用完整 snapshot 恢复，不依赖补放历史事件。

## 架构

```text
Browser ── HTTPS Range/PUT ── S3-compatible private bucket
   │
   └──── HTTPS/WSS ────────── Go server ── SQLite (WAL)
                                 │
                                 └── embedded React SPA
```

每个活跃房间由一个 goroutine + channel 的 Room Actor 串行修改。播放位置由 `anchorPositionMs + (serverNow - anchorServerTimeMs) × playbackRate` 推导；成员每 750ms 本地检查漂移，通过双阈值滞回、渐进变速、持续偏差确认与 seek 冷却抵抗网络和媒体事件抖动。房主播放器是物理参考，绝不会因自己的心跳锚点被反向 seek。具体状态机与参数见 [同步算法说明](docs/SYNC_ALGORITHM.md)。视频字节不会经过 Go 或 WebSocket。

## 功能

- 注册、Argon2id 密码、Opaque Cookie Session、游客邀请会话和 CSRF 防护
- 房间、邀请、房主转让、移除成员、房主断线宽限与在线成员
- 房主离线后暂停并保留房间，返回时恢复；只有房主明确操作才永久关闭，历史误关闭房间会在升级时恢复一次
- S3 单 PUT 与 32 MiB Multipart 直传、HeadObject 校验、私有播放票据
- 自定义 HTML5 播放器、聊天气泡与实时弹幕、服务器时钟同步、revision、漂移纠正、缓冲协调
- WebSocket snapshot、ACK、指数退避重连、有界发送队列和 16 KiB 限制
- 纯文本聊天、媒体时间点、历史记录和 token-bucket 限流
- SQLite migration、WAL、checkpoint、结构化 JSON 日志、健康检查和优雅关闭
- 手机/平板/桌面响应式 React SPA、单二进制嵌入、Docker 与 Nginx 配置

## 依赖

- Go 1.26+
- Node.js 24+（只用于构建前端）
- Git LFS 3+（用于仓库内确需版本控制的二进制资产与测试素材）
- 私有 S3-compatible bucket（AWS S3、R2、MinIO、RustFS 等）
- 正式环境的 HTTPS 反向代理

Go 和 npm 的确切依赖已分别锁定在 `go.mod`/`go.sum` 与 `web/package-lock.json`。后端使用 `net/http`、`github.com/coder/websocket`、`modernc.org/sqlite` 和 AWS SDK for Go V2。

## Git 与大文件

克隆仓库后执行一次：

```bash
git lfs install
git lfs pull
```

仓库内确需维护的图片、音视频测试素材、字体、PDF、WASM 和设计源文件由 `.gitattributes` 自动交给 Git LFS。用户上传的影片属于运行时数据，应存放在对象存储中；本地数据库、`data/` 目录、编译出的 `watchtogether` 和前端生成物均由 `.gitignore` 排除，不应加入 Git 或 Git LFS。

## 本地开发

最省事的方式是启动含 MinIO 的完整环境：

```bash
docker compose up --build
```

打开 `http://localhost:8080`，MinIO Console 位于 `http://localhost:9001`。Compose 内的默认凭证仅用于本机开发，不能用于公网环境。

分开开发前后端：

```bash
cp .env.example .env
cd web && npm ci && npm run dev
```

另一个终端导出 `.env` 中的变量后运行：

```bash
go run ./cmd/watchtogether serve
```

Vite 在 `http://localhost:5173` 提供页面并代理 API。应用本身不会解析 `.env` 文件；生产环境应由 systemd、容器平台或 shell 注入环境变量，避免把 secrets 意外读入日志或提交到 Git。

## S3 配置

bucket 必须保持私有。自定义 endpoint 时通常同时设置 `S3_PATH_STYLE=true`；AWS S3 一般留空 endpoint 并使用 virtual-hosted style。

浏览器必须能直接访问 endpoint，且 bucket CORS 至少允许应用 origin 的 `GET`、`HEAD`、`PUT`，并暴露 Multipart 所需的 `ETag`：

```json
[
  {
    "AllowedOrigins": ["https://watch.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

播放依赖 Range 请求。若上传成功但无法播放，先在浏览器 Network 面板确认对象响应支持 `Range`/`206 Partial Content`，再检查 CORS 和 MIME type。数据库不保存 presigned URL 或 S3 密钥。

MinIO 版本对 bucket-level CORS API 的支持存在差异，本仓库的 Compose 通过 `MINIO_API_CORS_ALLOW_ORIGIN` 配置开发 origins；AWS S3/R2 等服务应在 bucket 控制台或 IaC 中应用上面的规则。

## 环境变量

完整模板见 [.env.example](.env.example)。主要变量如下：

| 变量 | 用途 |
|---|---|
| `APP_ENV` | `production` 会启用 Secure Cookie |
| `APP_BASE_URL` | 唯一公开 HTTPS origin，也是邀请链接前缀 |
| `HTTP_LISTEN_ADDR` | 建议正式环境为 `127.0.0.1:8080` |
| `DATABASE_PATH` | 本机可靠磁盘上的 SQLite 文件 |
| `SESSION_TTL` | 正式用户 session 生命周期，默认 720h |
| `ROOM_MAX_MEMBERS` | 单房间上限，默认 20 |
| `MAX_MEDIA_SIZE_BYTES` | 声明大小与 HeadObject 实际大小都会检查 |
| `S3_*` | endpoint、region、bucket、凭证与 path-style；容器内外地址不同时设置 `S3_PUBLIC_ENDPOINT` |
| `S3_UPLOAD_URL_TTL` | 上传签名时长，默认 1h |
| `S3_MEDIA_URL_TTL` | 播放签名时长，默认 6h |
| `ALLOWED_ORIGINS` | 逗号分隔的精确 Web/WS origins，生产环境不能为 `*` |

## 构建和运行

```bash
make build
./watchtogether migrate
./watchtogether doctor
./watchtogether serve
```

`make build` 先构建 React 到 `internal/webui/dist`，再嵌入 Go 二进制。正式服务器不需要 Node.js。`doctor` 会检查数据库和 S3 bucket；S3 临时不可用不会让运行中的 `/readyz` 失败或杀死进程。

管理命令：

```text
watchtogether serve    启动 API、WebSocket 和 SPA
watchtogether migrate  应用尚未执行的事务化 migration
watchtogether doctor   检查数据库与对象存储配置
```

## 正式部署

容器部署时必须把 `/data` 挂载到持久卷。SQLite 不应放在 NFS、SMB 等共享网络文件系统上。

```bash
docker build -t movie-sync:1.0.0 .
docker run --env-file /etc/movie-sync.env -v movie-sync-data:/data -p 127.0.0.1:8080:8080 movie-sync:1.0.0
```

Nginx/OpenResty TLS 终止示例见 [deploy/nginx.conf.example](deploy/nginx.conf.example)。WebSocket 路径必须透传 HTTP/1.1 `Upgrade` 与 `Connection`，公开页面、`/api/`、`/assets/` 必须使用同一 origin。外部仅暴露 443；Go 保持监听 loopback。

## 备份、恢复与升级

备份 SQLite 时不要只复制主 `.db` 而遗漏 WAL。推荐使用 SQLite 在线备份命令：

```bash
sqlite3 /var/lib/watchtogether/application.db ".backup '/backup/application-$(date +%F).db'"
```

S3 对象应通过 bucket versioning/lifecycle 单独保护。恢复时先停止应用，恢复数据库和所对应的 bucket，再运行 `watchtogether migrate` 与 `watchtogether doctor`。

升级流程：备份、构建新二进制、停止旧进程、运行 migration、启动新进程、检查 `/readyz`。Migration 按版本在事务内只执行一次。服务器重启后已有房间会从 checkpoint 以暂停状态恢复，不会把离线时间直接推进到播放轴。

## 健康与日志

- `GET /healthz`：进程存活
- `GET /readyz`：配置、Room Registry 和 SQLite 可用
- `GET /diagnostics`：仅 loopback 可访问，返回活跃房间与 WebSocket 数

日志为一行一个 JSON 对象，带 HTTP/WebSocket request ID。密码、Cookie、session/invite token、S3 secret 和完整 presigned URL 永不写入日志。

## 测试

```bash
make test
```

该命令运行 Go 单元/SQLite/WebSocket 双客户端集成测试、Vitest 确定性同步算法测试、TypeScript 检查、前端生产构建和 Go 构建。

本地浏览器 E2E 需要 Docker/MinIO 与 Playwright Chromium：

```bash
cd web && npx playwright install chromium
cd .. && make e2e
```

## 常见故障

- **登录返回 CSRF 错误**：确认页面与 API 同 origin，`APP_BASE_URL`、`ALLOWED_ORIGINS` 与代理传入的 origin 完全一致。
- **WebSocket 403**：检查 Origin 白名单及 Nginx Upgrade headers；不要把 session token 放在 URL。
- **上传拿不到 ETag**：对象已经上传但浏览器不能读响应头，给 bucket CORS 加 `ExposeHeaders: ETag`。
- **视频无法 seek**：确认对象支持 Range、返回正确 MIME，并且目标已进入 `video.seekable`。
- **数据库 locked**：确认只有一个实例使用此 SQLite 文件，文件位于本机可靠存储，且 WAL/`busy_timeout` 生效。
- **自动播放被阻止**：在播放器左上角点击“继续播放”；这是浏览器对有声媒体的用户激活要求。
- **S3 短暂故障**：`/readyz` 仍可正常；修复 endpoint/凭证后用 `doctor` 验证。

## 安全边界

正式环境必须启用 HTTPS/WSS、私有 bucket、Secure Cookie 和严格 origin 白名单。成员权限在 Go Room Actor 中再次校验，隐藏前端按钮不是安全控制。聊天只按文本渲染，不使用 `dangerouslySetInnerHTML`。Secrets 只能通过服务器环境变量提供。
