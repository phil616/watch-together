# 部署：systemd + Gitea Runner 自动发布

仓库提供：

- `deploy/movie-sync.service`：目标服务器上的 systemd 单元文件。
- `.gitea/workflows/deploy.yml`：Gitea Actions 工作流，负责构建 Go 二进制、通过 SSH 覆盖目标服务器上的二进制并重启服务。

## 1. 目标服务器准备

### 创建用户和目录

```bash
sudo useradd --system --home /opt/movie-sync --shell /usr/sbin/nologin movie-sync
sudo mkdir -p /opt/movie-sync /var/lib/watchtogether
sudo chown movie-sync:movie-sync /opt/movie-sync /var/lib/watchtogether
```

### 放置配置

把 `.env` 放到 `/opt/movie-sync/.env`：

```bash
sudo tee /opt/movie-sync/.env >/dev/null <<'EOF'
APP_ENV=production
APP_BASE_URL=https://watch.example.com
HTTP_LISTEN_ADDR=127.0.0.1:8080
DATABASE_PATH=/var/lib/watchtogether/application.db
DATA_DIR=/var/lib/watchtogether
SESSION_TTL=720h
ROOM_MAX_MEMBERS=20
MAX_MEDIA_SIZE_BYTES=21474836480
ALLOWED_ORIGINS=https://watch.example.com
LOG_LEVEL=info

S3_ENDPOINT=https://oss-<region>.aliyuncs.com
S3_PUBLIC_ENDPOINT=https://oss-<region>.aliyuncs.com
S3_REGION=<region>
S3_BUCKET=your-movie-bucket
S3_ACCESS_KEY_ID=your-access-key-id
S3_SECRET_ACCESS_KEY=your-access-key-secret
S3_PATH_STYLE=true
S3_UPLOAD_URL_TTL=1h
S3_MEDIA_URL_TTL=6h
EOF

sudo chown movie-sync:movie-sync /opt/movie-sync/.env
sudo chmod 600 /opt/movie-sync/.env
```

### 安装 systemd 服务

```bash
sudo cp deploy/movie-sync.service /etc/systemd/system/movie-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now movie-sync
```

验证：

```bash
systemctl status movie-sync
sudo journalctl -u movie-sync -f
```

## 2. Gitea Runner 变量/密钥

> 如果你的 Gitea Runner 标签不是 `ubuntu-latest`，请把 `.gitea/workflows/deploy.yml` 中的 `runs-on: ubuntu-latest` 改成你的 runner 标签，例如 `runs-on: self-hosted`。

在 Gitea 仓库的 **Settings → Actions → Secrets** 中设置：

| 名称 | 示例 | 说明 |
|---|---|---|
| `DEPLOY_SSH_KEY` | `(粘贴 SSH 私钥完整内容)` | 目标服务器 deploy 用户的 SSH 私钥，保密 |

在 **Settings → Actions → Variables** 中设置：

| 名称 | 示例 | 说明 |
|---|---|---|
| `DEPLOY_SSH_HOST` | `203.0.113.10` | 目标服务器地址 |
| `DEPLOY_SSH_USER` | `deploy` | SSH 登录用户 |
| `DEPLOY_SSH_PORT` | `22` | SSH 端口，可省略，默认 `22` |
| `DEPLOY_APP_DIR` | `/opt/movie-sync` | 二进制目录，可省略；需与 systemd `ExecStart` 里的路径一致 |
| `DEPLOY_SERVICE_NAME` | `movie-sync` | systemd 服务名，可省略 |

如果你的 Gitea 版本不支持 Variables，可以把 `DEPLOY_SSH_HOST`、`DEPLOY_SSH_PORT`、`DEPLOY_SSH_USER` 也放到 Secrets，并把 workflow 里对应的 `vars.` 改成 `secrets.`。

### 目标服务器上的 SSH 用户权限

工作流会执行：

```text
# 如果 movie-sync 用户不存在，则自动创建
id -u movie-sync || sudo useradd --system --home /opt/movie-sync --shell /usr/sbin/nologin movie-sync

# scp 先把二进制上传到 /tmp/movie-sync-watchtogether.new
sudo mkdir -p /opt/movie-sync /var/lib/watchtogether
sudo chown movie-sync:movie-sync /opt/movie-sync /var/lib/watchtogether

# 先停止服务，避免覆盖正在运行的二进制时出现 Text file busy
sudo systemctl stop movie-sync || true

sudo mv -f /tmp/movie-sync-watchtogether.new /opt/movie-sync/watchtogether
sudo chown movie-sync:movie-sync /opt/movie-sync/watchtogether
sudo chmod 0755 /opt/movie-sync/watchtogether
sudo systemctl start movie-sync
```

因此 `DEPLOY_SSH_USER` 对应的用户需要能免密执行这些命令。最小化 sudo 示例（在目标服务器执行 `sudo visudo -f /etc/sudoers.d/movie-sync-deploy`）：

```text
deploy ALL=(root) NOPASSWD: /usr/bin/useradd --system --home /opt/movie-sync --shell /usr/sbin/nologin movie-sync, /usr/bin/mkdir -p /opt/movie-sync /var/lib/watchtogether, /usr/bin/chown movie-sync:movie-sync /opt/movie-sync /var/lib/watchtogether, /usr/bin/systemctl stop movie-sync, /usr/bin/mv -f /tmp/movie-sync-watchtogether.new /opt/movie-sync/watchtogether, /usr/bin/chown movie-sync:movie-sync /opt/movie-sync/watchtogether, /usr/bin/chmod 0755 /opt/movie-sync/watchtogether, /usr/bin/systemctl start movie-sync
```

如果不想维护最小权限，也可以把 `deploy` 加入 sudo 组并允许 NOPASSWD，但生产环境建议使用上面的最小权限规则。

## 3. 缓存

工作流已加入 Gitea Actions 缓存：

- Go：缓存 `~/.cache/go-build` 和 `~/go/pkg/mod`，key 基于 `go.sum`。
- npm：缓存 `~/.npm`，key 基于 `web/package-lock.json`。

这样没有变更依赖时，`go mod download` 和 `npm ci` 会直接命中缓存，避免重复下载。

`Setup Go` 和 `Setup Node` 不再传 `cache: false`，避免某些 Gitea Actions 版本的 `setup-node` 把 `false` 当成缓存类型而报 `Caching for 'false' is not supported`。

> 需要 Gitea 启用 Actions Cache 功能。如果缓存步骤报错，请先检查 Gitea 版本和 Actions Cache 配置。

## 4. 触发发布

- 推送到 `main` 分支自动触发。
- 也可以在 Gitea Actions 页面手动运行 `Build and Deploy`。

工作流会先构建前端（`npm run build`），再构建 Go 二进制，然后：

1. `scp` 上传到目标服务器 `/tmp/movie-sync-watchtogether.new`。
2. SSH 先 `systemctl stop movie-sync`，避免替换正在运行的二进制时报 `Text file busy`。
3. SSH 执行 `mv` 替换 `/opt/movie-sync/watchtogether`。
4. `systemctl start movie-sync` 启动新版本。

### 如果 systemd 报 `Text file busy` / `status=203/EXEC`

原因是替换二进制时服务仍然在运行，systemd 尝试执行一个正在被写入/替换的文件。现在工作流已经改为“先 stop → 替换 → 再 start”。

如果服务器当前已经处于失败循环，可手动修复：

```bash
sudo systemctl stop movie-sync
sudo mv -f /tmp/movie-sync-watchtogether.new /opt/movie-sync/watchtogether
sudo chown movie-sync:movie-sync /opt/movie-sync/watchtogether
sudo chmod 0755 /opt/movie-sync/watchtogether
sudo systemctl start movie-sync
```

### 如果部署卡在 SSH 步骤

工作流已经加了 `BatchMode=yes`，SSH/SCP 不会等待密码或 passphrase 输入；如果密钥认证失败会直接报错退出。

常见原因：

- `DEPLOY_SSH_KEY` 不是目标服务器上 `DEPLOY_SSH_USER` 已授权的私钥。
- 私钥有 passphrase，但 Gitea 环境无法交互输入。
- 目标服务器禁止该用户使用公钥登录，例如 `root` 未开启 `PermitRootLogin` 公钥登录。
- `DEPLOY_SSH_HOST` / `DEPLOY_SSH_PORT` / `DEPLOY_SSH_USER` 与目标服务器实际 SSH 配置不一致。
