# CodexPro Control Center

`codexpro-client` 是多设备 Hub 的本地 Windows 管理客户端。它启动一个只绑定 `127.0.0.1` 的管理页面，用来代替手工编辑 Hub/Agent JSON。

## 能做什么

- 配置 Hub 监听地址、端口、MCP 会话上限和超时；
- 添加 Windows 本机设备；
- 添加固定 SSH Host Alias 的 Linux/macOS 设备；
- 编辑 Windows 本机 Agent 的批准 Root；
- 为每个 Root 选择 `workspace-parent` 或 `read-only`；
- 测试本机/SSH Agent 连接；
- 启动、停止、重启由客户端管理的 Hub；
- 查看 Hub 运行日志；
- 自动生成和保存 Hub HTTP Token；
- 显示本地 MCP URL；
- 输入公网 HTTPS 域名后生成可粘贴到 ChatGPT 的 MCP URL。

管理页面不会暴露给 ChatGPT，也没有“任意 SSH 命令”或“扩大远程 Root”的 MCP 工具。

## 安装

在当前功能分支：

```powershell
git fetch origin
git switch feature/multi-device-hub
git pull
npm ci
npm run build
npm link
```

确认三个命令都存在：

```powershell
codexpro-client --version
codexpro-hub --version
codexpro-agent --version
```

## 启动

最简单：

```powershell
codexpro-client
```

默认使用：

```text
Hub 配置：%USERPROFILE%\.config\codexpro\hub.json
管理界面：http://127.0.0.1:8791/
```

浏览器会自动打开。若不希望自动打开：

```powershell
codexpro-client --no-open
```

指定已有配置：

```powershell
codexpro-client --config "$HOME\.config\codexpro\hub.json"
```

指定客户端 UI 端口：

```powershell
codexpro-client --port 8791
```

## 第一次配置 Windows 本机

1. 点击 **+ Windows 本机**。
2. `Device ID` 建议保留 `windows-main`。
3. `Agent Policy` 默认保存在 Hub 配置目录旁边。
4. 在“批准 Root”里填写例如 `D:\code`。
5. 权限选择 `workspace-parent`。
6. 如果还需要只读资料目录，再增加一个 Root，例如 `D:\reference`，权限选择 `read-only`。
7. 点击 **保存**。
8. 点击 **测试连接**。
9. 测试通过后点击 **启动**。

`workspace-parent` 并不意味着整个 Root 都可写。ChatGPT 通过 `open_workspace` 选中的项目目录才获得写权限，同 Root 的其他项目仍只能通过 Root 只读范围访问。

## 添加 SSH 服务器

Windows 的 `~/.ssh/config` 先准备固定别名，例如：

```sshconfig
Host lab-server
    HostName 192.168.1.30
    User codex-agent
    IdentityFile ~/.ssh/codex-agent
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

目标服务器已经安装相同分支/版本，并准备：

```text
~/.config/codexpro/agent.json
```

然后客户端点击 **+ SSH 服务器**，填写：

```text
Device ID:      lab-server
SSH Host Alias: lab-server
Agent Policy:   ~/.config/codexpro/agent.json
```

点击 **保存**，再点 **测试连接**。

客户端不会通过管理页面直接改远程 Agent policy。远程 Root 权限仍由目标服务器本地配置和操作系统账号权限共同控制，避免 Windows Hub 被利用来扩大远程权限。

## ChatGPT 连接

客户端会显示本地 MCP 地址，例如：

```text
http://127.0.0.1:8790/mcp
```

ChatGPT Web 无法直接访问该地址，因此仍需 Cloudflare / Tailscale Funnel / ngrok 等 HTTPS 入口。

假设公网基础地址为：

```text
https://codexpro.example.com
```

在客户端的“公网 HTTPS 基础地址”中填入它，会生成：

```text
https://codexpro.example.com/mcp?codexpro_token=...
```

如果 ChatGPT/MCP 配置界面支持 Bearer Header，优先使用：

```text
Server URL: https://codexpro.example.com/mcp
Authorization: Bearer <Hub Token>
```

这样 Token 不会进入 URL、代理日志或浏览器历史。

## Token 保存位置

如果没有显式设置 `CODEXPRO_HTTP_TOKEN`，客户端自动生成 32 字节随机 Token，并保存在 Hub 配置目录：

```text
.codexpro-hub-token
```

如果环境变量已经提供至少 24 字节的 `CODEXPRO_HTTP_TOKEN`，客户端优先使用环境变量。

## 安全边界

管理 UI 固定绑定：

```text
127.0.0.1
```

不能通过客户端参数改成公网地址。

此外：

- API 需要进程启动时生成的随机本地 admin token；
- 不启用 CORS；
- 拒绝非 loopback `Host`；
- 页面禁止被 iframe 嵌入；
- Hub/Agent 配置仍执行原有路径和权限校验；
- Agent policy 与 Hub config 必须位于批准 Root 外；
- 客户端只能停止自己启动的 Hub 子进程，不会随意杀其他进程。

## 测试

客户端有独立 smoke：

```powershell
npm run client:smoke
```

完整多设备验收：

```powershell
npm run multidevice:smoke
```

该测试包含 Control Center 页面/API、设备测试、配置保存、Hub 启停和健康检查。
