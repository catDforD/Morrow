<div align="center">

# Morrow

**本地优先的编码 Agent，支持 CLI、Web 与多智能体协作。**

[![Release](https://img.shields.io/github/v/release/catDforD/morrow?style=flat-square)](https://github.com/catDforD/morrow/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-2024%20edition-orange?style=flat-square)](Cargo.toml)

**简体中文** · [English](README.en.md)

![Morrow Web 仪表盘](web_design/dashboard_v2.png)

</div>

Morrow 将你配置的 OpenAI 兼容 Chat Completions 端点接入 Rust Agent 运行时。通过 CLI 或浏览器仪表盘读写代码、按权限执行命令和续接项目会话；Web 会话还支持按角色分配后台子任务，完成探索、规划、实现与审查。

[快速上手](#快速上手) · [多智能体协作](#多智能体协作) · [配置](#配置) · [开发](#开发)

## 功能特性

- **CLI 与 Web** —— 单次提示、交互式 REPL 和浏览器仪表盘共用运行时，支持 JSONL 自动化输出。
- **模型与工具接入** —— OpenAI 兼容模型、内置文件/搜索/shell 工具，以及 stdio 和 Streamable HTTP MCP。
- **多智能体协作** —— 在后台分工探索、规划、实现与审查，自定义角色配置、姓名和头像。
- **持久上下文** —— 按项目保存会话、续接子任务，并自动压缩长对话。
- **执行控制** —— 权限档案、审批队列、项目指令和用于验收的生命周期 Hook。

## 安装

macOS 和 Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/catDforD/morrow/main/install.sh | sh
morrow init
```

可通过安装脚本的 `MORROW_VERSION` / `MORROW_INSTALL_DIR` 环境变量指定版本或目录。Windows 可从 GitHub Releases 下载 `morrow-x86_64-pc-windows-msvc.zip`，将 `morrow.exe` 与 `morrow-rg.exe` 解压到同一目录并加入 `PATH`。

从源码安装：

```bash
cargo install --git https://github.com/catDforD/morrow --locked -p agent-cli
```

## 快速上手

```bash
morrow "summarize this repository"   # 单次提示
morrow                               # 交互模式
morrow server                        # Web 仪表盘，默认 127.0.0.1:3000
```

在项目目录中运行上述命令。使用 Web 时，打开终端打印的登录链接，浏览器会获得 `HttpOnly` 会话 Cookie。服务默认监听 `127.0.0.1:3000`；尚未配置模型时也能启动，可在 **设置 → 模型设置** 中添加服务商。

Web 按 turn 选择权限，默认 `workspace_write`；可用 `--permission-ceiling` 或 `[server] permission_ceiling` 限制可选范围。`[permissions]` 配置 CLI 权限。服务请保持监听本机；`--no-auth` 可用于本地调试。

## 多智能体协作

在 Web 会话中，主智能体可以把任务分配给持久化子智能体，再收集各自的结果。每个实例保留独立的对话上下文和执行记录，主智能体本轮结束后，子任务仍可继续运行。

### 角色与身份

打开 **设置 → 子智能体**，配置你的协作团队：

| 设置 | 可配置内容 |
| --- | --- |
| 角色能力 | 为各角色选择模型与推理级别、追加指令，并设置超时和最大工具轮次 |
| 身份外观 | 搜索全局名单、修改姓名、上传 PNG/JPEG/WebP 头像，支持新增、删除和恢复默认身份 |

角色决定工具与权限上限，身份名单提供展示用的姓名和头像。新建名单条目后，该身份可供后续任务使用；实际任务由主智能体在对话中创建子智能体来执行。

<p align="center">
  <img src="web_design/subagents.png" alt="子智能体设置：可搜索的全局名单、自定义姓名与头像" width="900">
</p>

*自定义名单示例。姓名与头像均可在设置中修改。*

| 角色 | 适合的任务 | 工具权限 |
| --- | --- | --- |
| `explore` | 探索代码、定位相关文件 | 读取、列目录、搜索；禁止 shell |
| `plan` | 分析需求、制定实现方案 | 读取、列目录、搜索；禁止 shell |
| `worker` | 执行代码修改 | 文件读写、补丁；shell 需审批 |
| `reviewer` | 审查改动、运行检查 | 读取、列目录、搜索；shell 需审批，不提供文件写工具 |

例如，可以向主智能体提出：

> 请让 explore 定位这个问题涉及的代码，再让 plan 给出实现方案；由 worker 完成修改，最后交给 reviewer 检查 diff 并运行相关测试。汇总改动和测试结果。

### 在仪表盘中跟进任务

打开会话中的 **子智能体** 检查器，查看状态、消息、工具执行过程和结果。可以使用已有上下文向空闲或中断实例追加任务、取消活跃任务，或删除非活跃实例。父子智能体的审批请求进入同一队列，并标明来源。

每个会话最多保留 **8 个持久实例，同时执行 4 个任务**。读取可以并行；主智能体文件写入与 shell、worker 任务和获批的 reviewer 命令共用工作区写锁。实际访问范围受父权限、角色上限与工具过滤共同约束。子智能体不提供 MCP 和继续委派工具。

CLI 通过 `delegate_task` 提供临时、同步、只读的任务委派；持久任务管理与检查器用于 Web 会话。

<details>
<summary>运行配置与持久化细节</summary>

- 持久任务使用 `spawn_subagent`、`send_subagent`、`inspect_subagent`、`wait_subagents` 和 `cancel_subagent` 管理。
- 每个角色可追加最多 4,000 字符的指令，设置 30–1,800 秒超时和 1–99 个工具轮次。角色设置和身份姓名在实例创建时保存快照。
- 设置保存在 `~/.morrow/subagents.json`；任务记录保存在 `~/.morrow/subagent-sessions/<workspace-scope>/<session>/`。
- 子智能体在工作区内的写入自动放行，不受 `workspace_write_require_approval` 影响；父权限允许的 shell 命令仍需审批。获批文件修改在写入前会重新验证预览。
- 重启后，未完成任务转为 `interrupted`，待处理审批与锁被清除；需要显式继续实例来恢复工作。
- 事件日志达到 16 MiB 后停止保留流式增量，继续记录消息、工具、审批和终态事件。任务运行时的模型凭据仅驻留内存。

</details>

## 配置

`morrow init` 写入 `~/.morrow/config.toml` 并提示输入 API key。配置查找顺序：`--config` → 当前目录 `morrow.toml` → `~/.morrow/config.toml`。

```toml
[model]
base_url = "https://api.openai.com/v1"
model = "gpt-4.1"
api_key_env = "OPENAI_API_KEY"
context_window_tokens = 128000
reserved_output_tokens = 8192

[permissions]
mode = "read_only"
shell = "deny"
```

`context_window_tokens` 是 CLI 模型配置的必填项，应按模型支持的上下文大小设置。内联的 `OPENAI_API_KEY` 优先；否则读取 `api_key_env` 对应的环境变量。请勿提交含真实密钥的配置。

Web 端的模型、MCP 服务器、命令与子智能体设置通过仪表盘管理，保存在 `~/.morrow/`。完整选项和上下文压缩参数见 [`morrow.example.toml`](morrow.example.toml)。

### 项目指令

Morrow 读取工作区根目录的 `AGENTS.md`，将项目规范加入主智能体与子智能体的系统提示词。每个 turn 检查修改时间并按需重读，修改在下一轮生效。每轮还会追加 `<environment>` 块，包含工作区、操作系统/架构、日期和可用时的 Git 分支。`AGENTS.md` 不能突破当前权限限制，其内容会发给模型服务商，请勿写入密钥。

只加载根目录的普通 UTF-8 文件，大小上限为 32 KiB；不跟随符号链接或查找嵌套文件。读取问题会在终端和 **设置 → 关于** 中显示。

### MCP 工具

可在配置中注册 stdio 与 Streamable HTTP MCP 服务器，发现后的工具以 `mcp__server__tool` 形式暴露给模型：

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
enabled = true
```

服务端未标注 `readOnlyHint` 的 MCP 工具默认每次调用都需审批；可在对应服务器配置中设置 `require_approval = false` 关闭。启用服务器或关闭审批前，请审查其命令和端点。

可用 `[tools] allow` / `deny` 限制主智能体可见的工具，支持内置工具名、整个 MCP 服务器（如 `mcp__filesystem`）和前缀通配符（如 `mcp__filesystem__*`）。`deny` 优先，空 `allow` 表示全部允许；跳过的 MCP 工具会显示在启动诊断中。

### 策略 Hook

Hook 在 `before_prompt`、`before_tool`、`permission_request`、`after_tool`、`after_turn` 及压缩前后执行。用户级配置位于 `~/.morrow/hooks.toml`，项目级配置位于 `<workspace>/.morrow/hooks.toml`。项目 Hook 默认禁用，需执行 **`morrow hooks trust`** 信任该配置的 SHA-256 指纹，可用 `morrow hooks revoke` 撤销。Hook 以当前用户权限执行，请审查命令后再信任。

`after_turn` Hook 在模型自称完成、turn 被接受之前执行。它收到最终文本与 turn 摘要（`final_text`、`tool_call_count`、`turn_message_count`、`tool_names`），返回 `{"decision": "complete" | "continue" | "fail"}`：`continue` 把 `additional_context` 注入对话并再跑一轮模型（每 turn 最多 3 次，超限强制完成并发出警告），`fail` 以给定理由判负该 turn。例如一个 turn 结束前跑测试的验收门：

```toml
[[hooks]]
id = "verify-tests"
event = "after_turn"
command = ["/bin/sh", "-c", "cargo test --workspace >/dev/null 2>&1 && printf '%s' '{\"decision\":\"complete\"}' || printf '%s' '{\"decision\":\"continue\",\"additional_context\":[\"cargo test 仍为红色；先修复再结束\"]}'"]
```

### Web 自定义命令

**设置 → 命令** 管理 `~/.morrow/commands/*.md` 中的斜杠命令（仅 Web 可用）。在输入框键入 `/` 可搜索；`$ARGUMENTS` 会被替换为传入参数。

## 权限

| `permissions.mode` | 行为 |
| --- | --- |
| `read_only` | 拒绝写入类工具 |
| `workspace_write` | 文件修改限制在工作区内并自动放行（可用下文 `workspace_write_require_approval` 恢复逐次审批） |
| `danger_full_access` | 可访问工作区外路径 |

| `permissions.shell` | 行为 |
| --- | --- |
| `deny` | 拒绝 shell |
| `prompt` | shell 需批准 |
| `allow` | shell 直接执行 |

Shell 策略是 Agent 层的审批边界，不是 OS 级只读沙箱。获批命令会继承 Morrow 进程用户的操作系统权限，命令本身仍可能修改文件；批准前应检查命令，需要更强隔离时请配合外部沙箱。

`workspace_write` 模式下，工作区内写入自动放行，越界写入直接拒绝。Shell 按其独立策略执行，非只读 MCP 工具默认需审批。若要对主智能体的每次文件修改进行审批：

```toml
[permissions]
workspace_write_require_approval = true
```

默认配置为 `read_only` + `shell = "deny"`。单次运行可覆盖：

```bash
morrow --permission workspace-write "update the README"
morrow --allow-shell "run the test suite and explain failures"
```

## 会话

会话按项目保存在 `~/.morrow/sessions/`：

```bash
morrow --session work "continue the refactor"
morrow --session work --reset-session "start over in the same project"
morrow session list
morrow session show work
morrow session export work --output work-session.json
morrow session rename work backend-refactor
morrow session delete backend-refactor
```

REPL 常用命令：`/status`、`/permissions ...`、`/compact`、`/reset`、`/exit`。兼容别名 `--thread` / `--reset-thread` 仍可用，新用法请优先 `--session` / `--reset-session`。

## 自动化

```bash
morrow --jsonl "inspect this crate" > events.jsonl
```

JSONL 模式要求提供提示词，不可用于交互模式或 session 子命令。

## 开发

crate 边界、turn 生命周期与扩展点见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

本文介绍 `crates/` 中的 Rust workspace。下一代运行时实验见独立的 [vnext 文档](vnext/README.md)。

<p align="center">
  <img src="docs/architecture/architecture-ports.svg" alt="Morrow 架构 —— 核心定义端口，适配器实现端口" width="720">
</p>

<details>
<summary>Workspace crate 职责</summary>

| Crate | 职责 |
| --- | --- |
| `agent-cli` | CLI、REPL、JSONL、`session`/`hooks` 子命令与服务装配 |
| `agent-config` | 配置加载 |
| `agent-core` | Turn 执行、端口、中间件与事件流 |
| `agent-eval` | Agent 循环确定性回归套件 |
| `agent-hooks` | 命令 Hook 与中间件适配器 |
| `agent-model` | OpenAI 兼容客户端与流式解析 |
| `agent-protocol` | 共享协议类型 |
| `agent-runtime` | 会话、压缩、工作区与 turn 辅助 |
| `agent-server` | HTTP/WebSocket 浏览器仪表盘 |
| `agent-sandbox` | 权限判定 |
| `agent-tools` | 内置文件与 shell 工具 |

</details>

```bash
cargo build --workspace
cargo test --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p agent-eval -- run   # agent 循环回归套件

cargo run -p agent-cli -- "hello"
cargo run -p agent-cli -- server
```

Web 前端通过 Vite 代理 API 与 WebSocket。先在一个终端启动本地后端：

```bash
cargo run -p agent-cli -- server --no-auth
```

再在另一个终端启动前端：

```bash
cd crates/agent-server/web
pnpm install --frozen-lockfile
pnpm dev
```

打与 workspace 版本一致的 tag（如 `v0.4.0`）会触发 GitHub Actions 发布 CLI 压缩包与校验文件。

## 卸载

从安装目录移除 CLI 与随附的搜索程序：

```bash
rm -f ~/.local/bin/morrow ~/.local/bin/morrow-rg
```

会话、配置和密钥仍保存在 `~/.morrow/`。如需同时清除这些本地数据，再删除该目录。

## 许可证

[MIT](LICENSE) © 2026 Gargantua
