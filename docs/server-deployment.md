# 服务器部署与 GitHub 交接

MasspecLib2 由 Windows 管理员端和 Linux 交付服务组成。服务器负责客户交付、共享谱库查询和自动更新。Test1 的主项目位于 `/workspace/ptk-master2`。

## Test1 目录

| 路径 | 内容 |
| --- | --- |
| `scripts/customer-delivery/` | 交付服务入口、自动更新、来源配置及下载模块 |
| `outputs/usability_revision_20261029/candidate-source/` | 交付服务实际加载的源码 |
| `outputs/usability_revision_20261029/candidate-data/` | 交付状态、客户模板、数据库登记、更新任务及新增谱图 |
| `.server/test1/config.json` | Test1 生效的配置，含当前网关、地址和数据库路径 |
| `.server/test1/secrets/` | 数据库凭据、HTTPS 证书和交付签名密钥 |
| `.server/test1/mysql/my.cnf` | 保留当前 MySQL 参数的配置副本，可配合项目内的 MySQL 运行环境使用 |
| `.runtime/test1/` | Node.js 和 MySQL 运行环境的 Test1 副本 |
| `/workspace/DATA` 和 `/workspace/LocalDataSet` | 已登记的谱库 SQLite 源文件 |
| `/workspace/mysql-masspeclib2/data` 和 `/workspace/mysql-masspeclib2/run/mysql.sock` | MySQL 数据目录与当前运行实例的 Unix 套接字 |

Test1 的 `candidate-data/config.json` 指向 `.server/test1/config.json`。交付服务通过 TCP 8445 提供 HTTPS，并通过现有套接字连接 MySQL。当前 MySQL 是独立运行的数据库服务。自动更新通过系统 `python3` 运行，下载模块随源码交付并使用 Python 标准库。

## 启动与核验 Test1

```bash
cd /workspace/ptk-master2
python3 scripts/customer-delivery/start.py
curl -fk https://127.0.0.1:8445/health
```

此处的 `curl -k` 用于 Test1 本机的健康检查。通过远程地址访问时，使用与证书匹配的主机名并验证证书。

启动程序从配置读取源码目录和状态目录。若实例已在运行，程序会报告 PID。维护人员可用 `--foreground` 在前台运行，或用 `--config` 与 `--node` 指定配置和 Node.js。同步变更时同时更新项目源码和实际运行目录，再检查 `/health` 与受影响功能。

## 从 GitHub 部署到另一台服务器

把 GitHub 的源码 ZIP 解压到 Linux 服务器和 Windows 构建机，或在两台机器上检出同一 Git 提交。从源码目录（含 `package.json`）执行下列命令。

### 初始化新服务器

准备 Linux、Node.js 22.13 或更高的 22.x 版本、Python 3.10 或更高版本、OpenSSL 和 MySQL 8.0。MySQL 需已运行。确认 Unix 套接字路径和可用密码的本机 MySQL `root` 账号。构建机和部署后的客户端需要能够访问下方设置的 HTTPS 地址。

```bash
npm ci --ignore-scripts
install -d -m 0700 .server/test1
export MSL_PROJECT="$PWD"
export MSL_DELIVERY_DIR="$PWD/.server/test1"
export MSL_MYSQL_SOCKET=/run/mysqld/mysqld.sock
export MSL_MYSQL_ROOT_CREDENTIALS="$MSL_DELIVERY_DIR/mysql-maintenance.json"
export MSL_DELIVERY_URL=https://delivery.example.org:8445
export MSL_DELIVERY_HOST=0.0.0.0
python3 - <<'PY'
import getpass
import json
import os

fd = os.open(os.environ['MSL_MYSQL_ROOT_CREDENTIALS'],
             os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'root': getpass.getpass('本机 MySQL root 密码: ')}, stream)
PY
node scripts/customer-delivery/bootstrap.cjs
python3 scripts/customer-delivery/start.py --foreground
```

执行前把 `delivery.example.org` 换成客户端实际使用的域名或 IP，把套接字换成本机路径，并开放对应防火墙端口。仅本机访问可用 `https://localhost:8445` 和 `127.0.0.1`。端口默认从 HTTPS 地址读取，服务绑定端口不同时可另设 `MSL_DELIVERY_PORT`。如需单独存放上传数据，初始化前将 `MSL_UPLOAD_ROOT` 设置为服务账号可写的绝对路径。

初始化生成 MySQL 目录及只读交付账号、管理员账号、统一工作台、TLS 证书和交付签名。完成后以相同服务账号在另一个终端检查。

```bash
curl --fail --cacert .server/test1/tls-cert.pem https://delivery.example.org:8445/health
```

返回产品名及版本后，将 `.server/test1/admin-profile.json` 安全传给 Windows 构建机。首登账号和密码在 `.server/test1/initial-admin-login.txt`，在管理员端首次登录后修改密码。长期运行时将前台启动命令交给服务器的服务管理器，设置开机启动及异常重启。自动更新由此服务执行。

### 恢复 Test1 的既有状态

要恢复原有谱库、分类、账户、交付记录或自动更新任务，从授权备份恢复 MySQL 数据、SQLite 源文件和交付状态目录，再依照 [配置样例](../scripts/customer-delivery/config.example.json) 核对路径、监听地址、模板、TLS 及签名密钥。保留凭据保险库密钥与已有状态的配对，并恢复客户模板 ZIP 和同名 `.indexed.json`。既有环境的配置和密钥应从备份复制，`bootstrap.cjs` 用于新环境。当前引力波库的原生分类识别依赖登记路径 `/workspace/DATA/引力波质谱数据库.sqlite`，恢复该库时应保留这个路径。

新环境登录后，在「数据库管理」上传或登记需要使用的谱库，检查格式并发布。自动更新目录内的来源、下载路径和手动更新网站随源码提供。需要自动检查的来源在「数据源更新」里配置，启用后按北京时间每月 15 日 03:00 起依次检查。

## 构建管理员交付版

Windows x64 构建机需安装 Node.js 22.13 或更高的 22.x 版本及 PowerShell 7。获取 WiX 3.14.1 的 `wix314-binaries.zip`。 [WiX 官方发布页](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm)

在源码根目录执行。把命令中的两个输入路径改成已下载的 WiX ZIP 与服务器生成的管理员配置路径。

```powershell
$delivery = Join-Path (Get-Location).Path '.server/windows-build'
New-Item -ItemType Directory -Force -Path "$delivery/packaging-tools" | Out-Null
Expand-Archive -LiteralPath 'C:\Downloads\wix314-binaries.zip' -DestinationPath "$delivery/packaging-tools/wix"
Copy-Item -LiteralPath 'C:\Downloads\admin-profile.json' -Destination "$delivery/admin-profile.json"
Copy-Item -LiteralPath 'build/icon.ico' -Destination "$delivery/packaging-tools/icon.ico"
if (!(Test-Path -LiteralPath 'resources/shared-server.json')) {
  Copy-Item 'resources/shared-server.example.json' 'resources/shared-server.json'
}
$env:MSL_PROJECT = (Get-Location).Path
$env:MSL_DELIVERY = $delivery
npm ci --ignore-scripts
npm run db:gen
npm run delivery:build-editions
pwsh -NoProfile -File scripts/customer-delivery/build-installers.ps1 -DeliveryDirectory $delivery
```

这里跳过 npm 安装脚本，避免 Windows 尝试为可选的 `cpu-features` 编译本机模块。构建仍会由 Electron Builder 获取 Electron，Prisma 由上面的命令单独生成。

产物在 `.server/windows-build/releases/<版本>/`。安装 `MasspecLib2-管理员端-<版本>-x64.msi`。将 `client-template.zip` 与 `client-template.zip.indexed.json` 一同传到服务器，放到 `config.json` 的 `templateFile` 对应位置。默认是 `.server/test1/client-template.zip`，标记文件与其同目录。推送或部署前，比对两边 ZIP 的 SHA-256 与标记文件的值。现在可从管理员端创建交付和生成客户 MSI。

共享谱库通过服务器 API 使用。另有直连 MySQL 或 SSH 隧道部署时，管理员端在「更多 → 设置」配置相应连接。需要按 Test1 的方式预设连接时，由维护人员在构建前提供该环境的 `resources/shared-server.json`。客户模板使用关闭直连的配置。

### 交付验收

1. 用管理员 MSI 登录新服务，确认工作台加载，登记一个小型测试库并发布。查询化合物、谱峰、液相方法和分类。
2. 在数据源更新中心核对自动更新来源和手动来源官网。先配置一个小范围更新任务，使用「检查更新」验证下载、校验与入库，并核对下次检查日期。
3. 用测试库中的几条记录创建交付，选择要展示的功能和字段，生成并安装客户 MSI。核对客户端可见范围、列表、详情，以及实际选择的联机或离线模式。

化合物分类补全脚本读取 `docs/classification-sources/who-aware-2023.xlsx`。需要运行该脚本时，获取 2023 年版工作簿并放到该路径。 [WHO 2023 AWaRe 发布页](https://www.who.int/publications/i/item/WHO-MHP-HPS-EML-2023.04)

## GitHub 提交范围

仓库包含源码、公开配置样例、依赖锁文件、测试和说明。`.server/`、`.runtime/`、`outputs/`、数据库文件、私钥和真实连接配置由 `.gitignore` 排除。需要转交源码压缩包时，可用 `git archive --format=zip --output=MasspecLib2-source.zip HEAD`。外部运行时、WiX 与 npm 依赖按上文安装。

```bash
git status --short
git log -1 --oneline
git check-ignore .server/test1/config.json .runtime/test1/node/bin/node
git push -u origin main
```

推送前确认 `origin` 指向预期的 GitHub 仓库。自动更新的操作和落盘路径见 [数据源更新](source-updates.md)。
