# 独立 Web UI 部署

使用 [Deploy Fork Web UI](../.github/workflows/deploy-fork-webui.yml) 手动构建普通浏览器客户端，按需发布到你自己的 Cloudflare Pages。默认只生成 artifact；没有 push/tag 触发器，也不创建 release。

网页只托管客户端。daemon、agent 和工作目录仍在你自己的主机上。Desktop 的 Electron export 不用于此站点。

目标为 main 的 PR 若修改这个 workflow 或 `host-runtime.ts` / `host-runtime.test.ts`，会自动构建并上传 browser artifact，超时 30 分钟。这条窄验证不部署、不读取 Cloudflare token；产品源码固定为 PR 的实际 head SHA，而不是测试 merge SHA。它可在新手动 workflow 尚未集成 main 时提供首次导出证据。

## 首次准备

先由人类 review 并集成 workflow 与普通 web 的 `EXPO_PUBLIC_PASEO_AUTO_CONNECT` 入口补丁。GitHub 的默认分支 `main` 必须包含 workflow，Actions 才能发现并提供手动入口；本流程不会替你 merge 或推送。

所选产品源码也必须包含入口补丁。workflow 在构建前读取 `packages/app/src/runtime/host-runtime.ts`，检查准确变量标识是否存在；缺失就失败。环境变量不能让旧源码凭空获得行为。若 workflow 已集成但 main 尚无入口补丁，可选择经过 review 的准备分支作为 `source_ref`。静态标识检查不是浏览器运行 QA。

仅构建不需要 Cloudflare 配置。需要部署时，由你完成一次性配置：

1. 在自己的 Cloudflare 账户创建 **Direct Upload** Pages 项目，不关联 Git 仓库。记录 Account ID 与项目名称，生产分支设为 **`main`**。
2. 创建限于该账户的 API token，授予 Cloudflare Pages Edit 权限。token 保存在仓库 secret，不放进网页、公开环境变量或 artifact。
3. 在 fork 仓库的 Actions variables/secrets 中设置下表。

| 类型                | 名称                       | 内容                          |
| ------------------- | -------------------------- | ----------------------------- |
| Repository variable | `CLOUDFLARE_ACCOUNT_ID`    | 你自己的 Account ID           |
| Repository variable | `CLOUDFLARE_PAGES_PROJECT` | 你自己的 Direct Upload 项目名 |
| Repository secret   | `CLOUDFLARE_API_TOKEN`     | 该账户的 Pages API token      |

已有锁定依赖、并在自己的终端配置 Cloudflare 身份时，可由人类用下面的命令创建项目并明确生产分支：

```bash
npm exec --workspace=@getpaseo/app --no -- wrangler pages project create "<自有项目名>" --production-branch main
```

workflow 不创建项目，也不继承上游的 Account ID 或项目名。不要调用现有 `deploy:web` 来部署 fork：它带有上游项目名并再次构建。新 workflow 只调用 workspace 的锁定 Wrangler；`npm ci` 使用 package-lock，不临时下载新 Wrangler。

## 手动构建与发布

在 Actions 选择 **Deploy Fork Web UI → Run workflow**。workflow ref 是执行本次流程的代码版本；`source_ref` 是要构建的产品源码，两者可以不同。

| 输入         | 默认    | 用法                                                             |
| ------------ | ------- | ---------------------------------------------------------------- |
| `source_ref` | `main`  | 分支、tag 或完整 commit SHA；留空也取 main                       |
| `deploy`     | `false` | false 只归档；true 将本次已归档的静态文件部署到自己的 Pages 项目 |

每次运行只解析一次所选 ref，切换到解析出的完整 40 位 SHA 后构建。main 后续变化不会改变正在运行的源码；main 有新变更也不会自动更新网站，需要再次手动运行。回看结果时核对实际 SHA，不能只看分支名或 package version。

构建使用 Node 22、npm retry 和一次 `build:web`；该 npm script 已包含 app-deps 编译。环境关闭 dotenv，清除 Electron 平台与旧 localhost override，并固定：

```text
EXPO_PUBLIC_PASEO_AUTO_CONNECT=false
```

此入口关闭普通 web 的 automatic hint、环境 override 和默认 localhost bootstrap。它仍加载用户已保存的 hosts，并允许手动 Add Host。构建后改变 Cloudflare 环境变量不会改变已导出的 JS，需要重新构建。

仅手动事件允许 `deploy=true`；缺少 account/project/token 时，在依赖安装与构建前失败。账户、项目、token 权限的有效性由实际 Wrangler 部署确认；部署失败时，之前成功上传的 artifact 仍可查看。`deploy=false` 和 PR 构建不要求这些变量或 secret，也不调用 Cloudflare。

发布固定传 `--branch main`，并附上实际产品 SHA。**Cloudflare 项目的生产分支必须先设置为 main**；否则这个参数可能得到 preview 部署，不会替你修改项目设置。部署日志中的 URL 和 Cloudflare 项目页面用于核对实际 production 结果。这个 branch 参数不修改 Git main，也不表示准备分支已经合并。

## Artifact 与身份

部署前先检查每个导出文件不超过 **25 MiB（26,214,400 bytes）**，再打包和上传 `webui-<完整产品SHA>`，保留 7 天。任何超限文件都会使流程失败并阻止部署。

下载并解开 Actions ZIP 后，得到：

| 文件            | 用途                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `webui.tar.gz`  | 含 `dist/` 的普通 browser export                                                                                     |
| `manifest.json` | 请求 ref、实际产品 SHA/版本、workflow SHA/版本、构建参数/工具版本、各静态文件大小与 SHA256、25 MiB 上限及 tar SHA256 |
| `SHA256SUMS`    | 校验内层 tar 与 manifest                                                                                             |

Actions 外层 ZIP digest 见运行摘要/API；它与内层 tar、静态文件哈希分属不同层。摘要分别记录产品版本与 workflow 版本，不能用 workflow SHA 冒充产品源码。

只读核验下载文件时，在解开的 artifact 目录执行：

```bash
sha256sum -c SHA256SUMS
tar -tzf webui.tar.gz
```

artifact 上传成功只证明文件已归档；入口变量检查、构建成功、文件哈希都不能代替部署后的连接 QA。保留运行 URL、manifest、目标项目及实际部署 URL，便于复核和回滚。

## 独立 daemon 与连接 QA

使用独立 daemon 安装前缀、独立绝对 `PASEO_HOME` 和由 owner 确认可用的新端口。新 home 不会自动改变默认监听端口，也不隔离 OS 用户的 provider 凭据或同一工作副本。不要复用生产 `~/.paseo`、identity/keypair 或全局 PATH 的 `paseo`；不要重启已有实例。

需要配置新实例时，用它自己的绝对 CLI 入口并始终带新 home。例如以下仅配置已有独立安装，不启动服务：

```bash
node /绝对候选前缀/node_modules/@getpaseo/cli/dist/index.js daemon config set daemon.listen '127.0.0.1:<新端口>' --home '/绝对新home'
node /绝对候选前缀/node_modules/@getpaseo/cli/dist/index.js daemon config set daemon.cors.allowedOrigins '["https://<自有网页域名>"]' --home '/绝对新home'
node /绝对候选前缀/node_modules/@getpaseo/cli/dist/index.js daemon config set app.baseUrl 'https://<自有网页域名>' --home '/绝对新home'
```

密码通过同一个 CLI 的 `daemon set-password --home '/绝对新home'` 设置；不要直接写明文密码配置。由 owner 决定何时启动新实例。已运行 home 的配置写入可能触发该实例 reload，因此上述示例只用于新的目标 home。home、监听及连接约定见 [development.md](development.md)。

Cloudflare Pages 网页是 HTTPS。远程 direct 连接需要浏览器信任的 **WSS**：已有 TLS 代理把 `/ws` Upgrade 转给新 daemon 的 plain HTTP/WS，并提供所需 API。Add Host 填 daemon 的实际 host/TLS 端口并启用 SSL；不要把 HTTPS 网页指向明文 LAN WS，也不要用 `EXPO_PUBLIC_LOCAL_DAEMON` 代替通用 WSS/relay 配置。手机的 localhost 是手机自身。

新 daemon 的 `daemon.cors.allowedOrigins` 或 foreground 模式的 `PASEO_CORS_ORIGINS` 使用**网页完整 origin**，包含 scheme、host 和非默认端口。若 TLS 代理保留公网 Host，新 home 的 `daemon.hostnames` 也要允许该精确域名；Host allowlist 与网页 Origin 是不同配置。`app.baseUrl` 只决定配对链接指向哪一个网页，不能替代 endpoint 或 CORS。代理约定见 [service-proxy.md](service-proxy.md)。

managed `daemon start` 使用 home 的持久配置，会剥离部署环境覆盖；不要只给它套 `PASEO_LISTEN`/CORS/password 环境变量。需要 foreground/deployment 环境覆盖时用 `daemon run`，并明确新 home；不要把两种启动方式混用。配对也只针对新实例执行 `daemon pair --home '/绝对新home'`。

若选择 relay，先在新 home 明确启用它，并在 Add Host 手动粘贴新实例的配对连接。relay WSS 不要求公开 daemon loopback 端口；relay-only 文件下载仍可能需要 direct HTTPS 地址。认证与连接能力按所选 daemon 版本验收，不能仅凭配对链接声称密码强制或一次性邀请成立。

在独立浏览器 profile/origin 上完成以下 QA，避免旧 registry 自动连接已有 hosts：

- fresh profile 初次加载不自动探测 localhost:6767，不读入 automatic hint/override；旧 profile 中已保存 hosts 的恢复行为仍保留。
- 手动 Add Host 只连接新目标；记录浏览器网络、daemon PID/listen/serverId 与新 home，确认未命中已有实例。
- 核对实际 Pages production URL、HTTPS 证书、页面刷新/深链接、静态资源和 `/ws` Upgrade、精确 CORS/Host 规则。
- 验证认证、工作区、终端、重连和所需移动浏览器能力；若使用 relay，另验收 direct 文件下载与配对权限边界。

## 回滚

保留最后一次通过 QA 的 **产品完整 SHA** 与运行/部署记录。要回滚，在同一 workflow 中把 `source_ref` 改为该旧 SHA、`deploy=true`，重新构建、归档并发布到同一个生产项目的 `main` 槽。旧 SHA 必须包含手动连接入口补丁，否则前置检查会失败。

删除 Actions artifact 不会撤回网站，改变 Git 分支指向也不会自动更新 Pages。回滚需要一次明确的部署，完成后重复目标连接 QA，并记录这次实际部署 URL 与源码 SHA。
