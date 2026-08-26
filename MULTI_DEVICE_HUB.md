# CodexPro 多设备 Hub

本功能让 ChatGPT 网页端只连接一个 Windows 总控机上的 MCP 地址，再由 Windows Hub 在已批准设备之间路由文件操作。

```text
ChatGPT 网页版
      |
      | HTTPS /mcp（唯一公开入口）
      v
Windows codexpro-hub
  |-- 本机 codexpro-agent
  `-- ssh -T <固定 Host 别名> codexpro-agent --policy <固定策略文件>
          `-- Linux / Windows 目标设备
```

设备、SSH 目标和文件系统 Root 只能由管理员在本地 JSON 文件中配置，ChatGPT 没有添加设备、修改 Root 或提交任意 SSH 地址的工具。

## 当前实现范围

首个版本提供：

- 一个 ChatGPT 可连接的 Streamable HTTP `/mcp` 入口；
- Windows 本机 Agent；
- 通过固定 SSH Host 别名启动的远程 Agent；
- 每个 ChatGPT MCP 会话独立的设备和工作区状态；
- 设备、Root 和项目子目录选择；
- 工作区或 Root 的 `tree`、`search`、`read`；
- 仅工作区内可用的 `write`、`edit`；
- 仅工作区内可用的 `git_status`、`git_diff`；
- 路径穿越、符号链接逃逸、敏感 glob、文件大小、SHA 并发校验和原子写入保护；
- Windows 与 Linux GitHub Actions 冒烟测试。

首个版本**不提供**：

- Bash、PowerShell 或任意命令执行；
- 由 ChatGPT 添加或修改设备；
- 任意 SSH 主机、用户名、端口或远端命令参数；
- 反向 WSS Agent；
- 远程 `apply_patch`、附件导入、图像查看和高级代码分析。

这些限制是有意设置的。先让文件访问边界稳定，再单独增加操作系统级命令沙箱。

## 权限模型

每台设备本地配置若干批准 Root：

| 范围 | 读取 | 写入 | 执行命令 |
|---|---:|---:|---:|
| 当前通过 `open_workspace` 打开的项目目录 | 允许 | 允许 | 不允许 |
| `workspace-parent` Root 中的其他目录 | 允许，只能使用 Root 只读范围 | 拒绝 | 不允许 |
| `read-only` Root | 允许 | 拒绝 | 不允许 |
| 未配置的设备目录 | 拒绝 | 拒绝 | 不允许 |
| `.env`、`.ssh`、私钥等 blocked globs | 拒绝 | 拒绝 | 不允许 |

“工作区外只读”并不等于“整台设备都能读”。只有管理员明确写进 Agent 策略的 Root 才能读取。

写工具没有 `root_id` 参数。每次写入必须携带当前 ChatGPT MCP 会话中由 Hub 返回的 `workspace_id`。目标设备断线时调用直接失败，不会回退到 Windows 本机。

## 1. 构建当前分支

在 Windows 总控机和每台目标设备安装 Node.js 20 或更高版本，然后构建同一版本的 CodexPro：

```bash
git switch feature/multi-device-hub
npm ci
npm run build
npm link
```

完成后应存在：

```bash
codexpro-hub --version
codexpro-agent --version
```

也可以不执行 `npm link`，在仓库目录使用：

```bash
node dist/hub.js --config path/to/hub.json
node dist/agent.js --policy path/to/agent.json
```

## 2. 配置 Windows 本机 Agent

复制示例：

```text
examples/multidevice/windows-agent.example.json
```

示例：

```json
{
  "schemaVersion": 1,
  "deviceId": "windows-main",
  "label": "Windows 总控机",
  "roots": [
    {
      "id": "projects",
      "label": "Windows 项目目录",
      "path": "D:\\code",
      "mode": "workspace-parent"
    },
    {
      "id": "reference",
      "label": "只读资料",
      "path": "D:\\reference",
      "mode": "read-only"
    }
  ],
  "blockedGlobs": [
    "**/secrets/**",
    "**/credentials/**"
  ]
}
```

要求：

- 每个 Root 必须已经存在并且是目录；
- `deviceId` 必须和 Hub 中该设备的 `id` 完全一致；
- Root ID 在同一设备内必须唯一；
- 策略文件中的相对 Root 路径以策略文件所在目录为基准；
- Agent 启动时会把 Root 解析为真实路径；
- 策略更新后需要重启对应 Agent 连接。

## 3. 配置 Linux 服务器 Agent

在 Linux 服务器保存策略，例如：

```text
~/.config/codexpro/agent.json
```

```json
{
  "schemaVersion": 1,
  "deviceId": "lab-server",
  "label": "实验室 Linux 服务器",
  "roots": [
    {
      "id": "projects",
      "label": "服务器项目",
      "path": "/srv/projects",
      "mode": "workspace-parent"
    },
    {
      "id": "app-logs",
      "label": "应用日志",
      "path": "/var/log/myapp",
      "mode": "read-only"
    }
  ]
}
```

建议专门创建低权限账号运行 Agent，并用操作系统权限进一步限制它能读取的目录。Agent 的 JSON 策略是应用层白名单，不应替代 Linux 用户权限或 Windows ACL。

## 4. 配置固定 SSH Host 别名

Windows 用户目录下的 SSH 配置示例：

```sshconfig
Host lab-server
    HostName 192.168.1.30
    User codex-agent
    IdentityFile ~/.ssh/codex-agent
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

先人工建立并验证 Host Key：

```bash
ssh lab-server codexpro-agent --version
```

Hub 固定使用：

- `BatchMode=yes`；
- `ClearAllForwardings=yes`；
- `StrictHostKeyChecking=yes`；
- 固定 Host 别名；
- 固定 `codexpro-agent --policy ...` 远端命令。

MCP 工具参数中没有主机地址、用户名、SSH 选项或远端命令，因此模型不能把 Hub 变成通用 SSH 跳板。

## 5. 配置 Windows Hub

复制：

```text
examples/multidevice/hub.example.json
```

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 8790,
  "maxSessions": 64,
  "sessionTtlMs": 1800000,
  "devices": [
    {
      "id": "windows-main",
      "label": "Windows 总控机",
      "transport": "local",
      "policyPath": "./windows-agent.json"
    },
    {
      "id": "lab-server",
      "label": "实验室 Linux 服务器",
      "transport": "ssh",
      "sshHostAlias": "lab-server",
      "policyPath": "~/.config/codexpro/agent.json"
    }
  ]
}
```

说明：

- 本机设备的 `policyPath` 相对于 Hub 配置文件解析，并且必须在 Windows 上存在；
- SSH 设备的 `policyPath` 是目标设备上的路径；
- SSH 的 `sshHostAlias` 只能是简单固定别名；
- Hub 配置只能在 Windows 本地编辑，不通过 MCP 暴露。

## 6. 启动 Hub

生成高强度令牌：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

PowerShell：

```powershell
$env:CODEXPRO_HTTP_TOKEN = "粘贴上一步生成的令牌"
codexpro-hub --config "C:\path\to\hub.json"
```

默认 MCP 地址：

```text
http://127.0.0.1:8790/mcp
```

仅用于可信本机测试时可以关闭令牌：

```powershell
$env:CODEXPRO_ALLOW_NO_HTTP_TOKEN = "1"
codexpro-hub --config "C:\path\to\hub.json"
```

无令牌模式只允许 loopback 绑定。不要把它和隧道、LAN 地址或端口转发一起使用。

## 7. 暴露给 ChatGPT

Hub 本身只负责 MCP 路由。可继续使用现有 Cloudflare、ngrok 或 Tailscale 方式，把 Windows 的 `127.0.0.1:8790` 暴露为 HTTPS。

认证优先使用：

```http
Authorization: Bearer <CODEXPRO_HTTP_TOKEN>
```

若所用 MCP 客户端只能在 URL 中保存令牌，Hub 兼容：

```text
https://your-domain.example/mcp?codexpro_token=<TOKEN>
```

URL 令牌可能被代理或历史记录保存，能使用 Bearer Header 时不要使用查询参数。

ChatGPT 只配置这个 Hub URL，不需要分别连接各台服务器。

## 8. ChatGPT 工具调用流程

```text
list_devices
  -> list_device_roots(device_id="lab-server")
  -> open_workspace(
       device_id="lab-server",
       root_id="projects",
       relative_dir="eventvad"
     )
  -> 返回 hws_... 工作区 ID
  -> read/tree/search 使用该 workspace_id
  -> write/edit 必须显式使用该 workspace_id
```

查看工作区外的批准目录时：

```text
read(
  device_id="lab-server",
  root_id="app-logs",
  path="service.log"
)
```

Root 只读调用不能转换成写操作。

## 9. 会话隔离

每个 MCP 会话拥有独立的 Hub 工作区 ID 映射：

```text
ChatGPT 会话 A -> lab-server:/srv/projects/a
ChatGPT 会话 B -> windows-main:D:\code\b
```

Hub 工作区 ID 包含会话随机量。另一个 MCP 会话不能直接复用旧的 Hub 工作区 ID。目标 Agent 的工作区 ID也只在对应 Agent 连接中有效。

## 10. 安全注意事项

- 不要批准包含私钥、浏览器资料、云凭据或数据库备份的宽泛 Root；
- 不建议把磁盘根目录、用户主目录或 `/` 整体配置成只读 Root；
- blocked globs 是附加保护，不应被当成完整的数据分类系统；
- 避免在批准 Root 内创建指向敏感文件的硬链接。文件系统无法仅根据硬链接路径判断另一名字位于哪里；
- SSH 私钥应使用专用账号和最小权限；
- 目标设备策略文件应只允许管理员修改；
- Hub 的公网入口必须使用 HTTPS 和强令牌；
- 首版没有操作系统命令沙箱，因此完全不暴露命令执行工具。

## 11. 常见错误

### `Agent identity mismatch`

Hub 设备 `id` 和远端策略的 `deviceId` 不一致。两处必须完全相同。

### `StrictHostKeyChecking` 或 Host Key 错误

先在 Windows 终端人工执行 `ssh <别名>`，核对并保存正确 Host Key。不要通过关闭 Host Key 校验解决。

### `codexpro-agent: command not found`

在目标设备执行 `npm link` 或全局安装包含该命令的包，或者确保非交互 SSH 会话的 PATH 能找到 `codexpro-agent`。

### `Root ... is read-only`

`read-only` Root 不能通过 `open_workspace` 打开。需要写入的项目必须位于 `workspace-parent` Root 下。

### `Unknown workspace_id`

工作区 ID 只属于创建它的当前 MCP 会话。重新连接后再次调用 `open_workspace`。

### 设备断线

Hub 会把该设备标记为 offline，并让当前调用失败。它不会把操作自动转到其他设备或 Windows 本机。修复 SSH 或 Agent 后，下次调用会重新建立连接。

## 12. 验证

```bash
npm run build
npm run multidevice:smoke
```

冒烟测试覆盖：

- Agent 不暴露 Bash 或 Shell 工具；
- `read-only` Root 不能打开成工作区；
- 工作区和 Root 的读取；
- 工作区内写入和编辑；
- 工作区外 `..` 写入被拒绝；
- `.env` 路径被拒绝；
- 伪造工作区 ID 被拒绝；
- Agent 描述不泄露批准 Root 的绝对路径。
