# CodexPro 多设备 Hub

本功能让 ChatGPT 网页端只连接 Windows 总控机上的一个 MCP 地址，再由 Windows Hub 在管理员预先批准的设备、Root 和项目目录之间路由文件操作。

```text
ChatGPT 网页版
      |
      | HTTPS /mcp（唯一公开入口）
      v
Windows codexpro-hub
  |-- 本机 codexpro-agent
  `-- ssh -T <固定 Host 别名> codexpro-agent --policy <固定策略文件>
          `-- Linux / macOS 目标设备
```

设备注册、SSH 目标、Agent 策略和文件系统 Root 只能在本地配置文件中修改。ChatGPT 没有添加设备、扩大 Root、提交任意主机地址或运行任意远端命令的工具。

## 当前实现范围

首个版本提供：

- 一个 ChatGPT 可连接的 Streamable HTTP `/mcp` 入口；
- Windows 本机 Agent；
- 通过固定 SSH Host 别名启动的 Linux/macOS 远程 Agent；
- 每个 ChatGPT MCP 会话独立的 Hub 工作区 ID；
- 设备、Root 和项目子目录选择；
- 工作区或批准 Root 的 `tree`、`search`、`read`；
- 仅显式工作区内可用的 `write`、`edit`；
- 仅显式工作区内可用的 `git_status`、`git_diff`；
- 路径穿越、绝对路径、符号链接或 junction 逃逸、敏感 glob、文件大小、SHA 并发校验和原子写入保护；
- 强制 HTTP 令牌认证、会话数量和空闲时间限制；
- Agent 身份握手、断线失败和本地诊断；
- 面向 Windows 与 Linux 的 Agent/Hub 冒烟测试脚本。

首个版本**不提供**：

- Bash、PowerShell 或任意命令执行；
- 由 ChatGPT 添加、删除或修改设备；
- 任意 SSH 主机、用户名、端口、转发或远端命令参数；
- 通过当前 SSH 传输连接远程 Windows Agent；
- 反向 WSS Agent；
- 远程 `apply_patch`、附件导入、图像查看和高级代码分析。

这些限制是有意设置的。先稳定文件访问边界，再单独设计操作系统级命令沙箱和远程 Windows 传输。

## 权限模型

每台设备本地配置若干批准 Root：

| 范围 | 读取 | 写入 | 执行命令 |
|---|---:|---:|---:|
| 当前通过 `open_workspace` 打开的项目目录 | 允许 | 允许 | 不允许 |
| `workspace-parent` Root 中的其他目录 | 允许，只能使用 Root 只读范围 | 拒绝 | 不允许 |
| `read-only` Root | 允许 | 拒绝 | 不允许 |
| 未配置的设备目录 | 拒绝 | 拒绝 | 不允许 |
| `.env`、`.ssh`、私钥等 blocked globs | 拒绝 | 拒绝 | 不允许 |

“工作区外只读”不等于“整台设备都能读”。只有管理员明确写进目标 Agent 策略的 Root 才能读取。

公开写工具没有 `device_id` 或 `root_id` 参数。每次写入必须携带当前 ChatGPT MCP 会话中由 Hub 返回的 `workspace_id`。目标设备断线时调用直接失败，不会回退到 Windows 本机或其他设备。

## 控制平面文件必须放在 Root 外

以下文件决定权限边界：

- Agent 策略文件；
- Windows Hub 配置文件；
- SSH 配置和私钥。

Agent 和 Hub 启动时会拒绝以下危险布局：

```text
D:\code\project\agent.json   # D:\code 是批准 Root
D:\code\hub.json             # D:\code 是本机批准 Root
```

推荐放置位置：

```text
Windows:
  C:\Users\<user>\.config\codexpro\hub.json
  C:\Users\<user>\.config\codexpro\windows-agent.json

Linux:
  ~/.config/codexpro/agent.json
```

策略和 Hub 配置还应使用操作系统权限限制为仅管理员或运行账号可写。

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

Hub 和远程 Agent 应使用相同的 CodexPro 版本。

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
- Agent 策略文件必须位于所有批准 Root 之外；
- 策略文件中的相对 Root 路径以策略文件所在目录为基准；
- Agent 启动时会把 Root 解析为真实路径；
- 策略更新后需要断开并重新建立对应 Agent 连接。

## 3. 配置 Linux/macOS 服务器 Agent

在目标服务器保存策略，例如：

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

建议专门创建低权限账号运行 Agent，并用操作系统权限进一步限制它能读取的目录。Agent JSON 策略是应用层白名单，不替代 Linux 用户权限、macOS 权限或 Windows ACL。

当前 SSH 命令使用 POSIX shell 引号，因此远程 SSH Agent 目标应为 Linux 或 macOS。Windows 本机 Agent 已支持；远程 Windows 传输尚未加入。

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

先人工建立并核对 Host Key：

```bash
ssh lab-server codexpro-agent --version
```

Hub 对每次 Agent 连接固定使用：

- `BatchMode=yes`；
- `ClearAllForwardings=yes`；
- `ForwardAgent=no`；
- `ForwardX11=no`；
- `RequestTTY=no`；
- `PermitLocalCommand=no`；
- `ControlMaster=no`；
- `StrictHostKeyChecking=yes`；
- 固定 Host 别名；
- 固定 `codexpro-agent --policy ...` 远端命令。

MCP 工具参数中没有主机地址、用户名、SSH 选项或远端命令，因此模型不能把 Hub 变成通用 SSH 跳板。

服务器端还可以用专用 SSH 用户、`authorized_keys` 限制和防火墙进一步收紧权限。

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

- Hub 配置文件必须位于所有本机批准 Root 之外；
- 本机设备的 `policyPath` 相对于 Hub 配置文件解析，并且必须在 Windows 上存在；
- 本机 Agent 策略的 `deviceId` 必须和 Hub 设备 `id` 一致；
- SSH 设备的 `policyPath` 是目标设备上的路径；
- `sshHostAlias` 只能是简单固定别名；
- Hub 配置只能在 Windows 本地编辑，不通过 MCP 暴露。

## 6. 启动 Hub

生成高强度令牌：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

PowerShell：

```powershell
$env:CODEXPRO_HTTP_TOKEN = "粘贴上一步生成的令牌"
codexpro-hub --config "C:\Users\<user>\.config\codexpro\hub.json"
```

默认 MCP 地址：

```text
http://127.0.0.1:8790/mcp
```

`CODEXPRO_HTTP_TOKEN` 是强制项，即使 Hub 仅绑定 loopback 也不能关闭。令牌至少需要 24 个 UTF-8 字节。

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

URL 令牌可能被代理日志、浏览器历史或终端历史保存。能使用 Bearer Header 时不要使用查询参数。

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

## 9. 会话隔离与状态上限

每个 MCP 会话拥有独立的 Hub 工作区 ID 映射：

```text
ChatGPT 会话 A -> lab-server:/srv/projects/a
ChatGPT 会话 B -> windows-main:D:\code\b
```

Hub 工作区 ID 包含会话随机量。另一个 MCP 会话不能直接复用旧的 Hub 工作区 ID。目标 Agent 的工作区 ID 也只在对应 Agent 进程中有效。

为防止长期运行时无界增长：

- 每个 ChatGPT MCP 会话最多保留 128 个 Hub 工作区；
- 每个目标 Agent 连接最多保留 256 个工作区；
- Hub HTTP 会话数量和空闲时间由 `maxSessions`、`sessionTtlMs` 控制；
- 超出上限时最久未使用的工作区 ID 会失效，不会重新指向其他目录。

重新连接或收到 `Unknown workspace_id` 后，应再次调用 `open_workspace`。

## 10. 安全注意事项

- 不要批准包含私钥、浏览器资料、云凭据或数据库备份的宽泛 Root；
- 不建议把磁盘根目录、用户主目录或 `/` 整体配置成只读 Root；
- Agent 策略和 Hub 配置必须放在所有批准 Root 之外；
- blocked globs 是附加保护，不应被当成完整的数据分类系统；
- 避免在批准 Root 内创建指向敏感文件的硬链接。文件系统无法仅根据一个硬链接名字判断它的其他名字位于哪里；
- SSH 私钥应使用专用账号、专用密钥和最小权限；
- 目标设备策略文件应只允许管理员或 Agent 运行账号修改；
- Hub 的公网入口必须使用 HTTPS 和强令牌；
- 首版没有操作系统命令沙箱，因此完全不暴露命令执行工具。

## 11. 常见错误

### `Agent identity mismatch`

Hub 设备 `id` 和远端策略的 `deviceId` 不一致。两处必须完全相同。

### `Agent policy must be stored outside every approved root`

Agent 策略位于批准 Root 内。把策略移动到用户配置目录，并更新 Hub 中的 `policyPath`。

### `Hub config must be stored outside every approved local root`

Hub 配置位于本机批准 Root 内。把它移动到 Windows 用户配置目录。

### `StrictHostKeyChecking` 或 Host Key 错误

先在 Windows 终端人工执行 `ssh <别名>`，核对并保存正确 Host Key。不要通过关闭 Host Key 校验解决。

### `codexpro-agent: command not found`

在目标设备执行 `npm link` 或全局安装包含该命令的包，并确保非交互 SSH 会话的 PATH 能找到 `codexpro-agent`。

### `Root ... is read-only`

`read-only` Root 不能通过 `open_workspace` 打开。需要写入的项目必须位于 `workspace-parent` Root 下。

### `Unknown workspace_id`

工作区 ID 只属于创建它的当前 MCP 会话，并且可能因状态上限或 Agent 重连而失效。再次调用 `open_workspace`。

### 设备断线

Hub 会把该设备标记为 offline，并让当前调用失败。它不会把操作自动转到其他设备或 Windows 本机。修复 SSH 或 Agent 后，下次调用会重新建立连接。

## 12. 验证

```bash
npm run build
npm run multidevice:smoke
```

测试脚本覆盖：

- Agent 和 Hub 不暴露 Bash、PowerShell 或 Shell 工具；
- Hub 缺少令牌或令牌过弱时拒绝启动；
- 未授权 HTTP 请求被拒绝；
- `read-only` Root 不能打开成工作区；
- 工作区和 Root 的读取；
- 工作区内写入和编辑；
- 工作区外 `..`、绝对路径和符号链接或 junction 逃逸被拒绝；
- `.env` 路径被拒绝；
- 伪造或跨 MCP 会话复用工作区 ID 被拒绝；
- Agent 和 Hub 结果不泄露批准 Root、策略文件或 Hub 配置的绝对路径；
- Agent 策略和 Hub 配置不能位于批准 Root 内。

当前 PR 保持草稿状态，直到 Windows 与 Linux CI 实际完成这些构建和测试。
