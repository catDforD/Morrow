# Repository Guidelines

## 项目结构

Rust workspace（2024 edition，rustfmt 默认格式），源码位于 `crates/`，测试就近放在同一 crate 的 `#[cfg(test)]` 模块中：

- `crates/agent-cli`：CLI 入口、参数解析、REPL、JSONL 输出、`session` / `hooks` 子命令，以及 server 启动装配。
- `crates/agent-core`：agent turn 状态机、`Model` / `ToolRuntime` 端口、中间件链和事件流。
- `crates/agent-runtime`：turn 编排、上下文压缩、SessionStore 与 v7 fact log 持久化、MCP 装配和 Subagent 监督。
- `crates/agent-protocol`：共享协议类型，例如 `Message`、`Thread`、`Turn`、Session fact 和事件。
- `crates/agent-model`：OpenAI-compatible 模型客户端和 SSE 解析。
- `crates/agent-tools`：内置文件与 shell 工具、ToolRegistry、MCP 适配和 `web_fetch`。
- `crates/agent-sandbox`：workspace 路径约束与权限判定。
- `crates/agent-config`：`morrow.toml` 配置加载与校验。
- `crates/agent-hooks`：命令 Hook 与中间件适配器（before_prompt、before_tool、permission_request、after_tool、after_turn、pre/post compact），含项目 Hook 指纹信任。
- `crates/agent-server`：HTTP/WebSocket 浏览器仪表盘、审批与取消、Subagent/MCP/命令设置。
- `crates/agent-eval`：确定性回归评估：脚本化模型与工具驱动真实 turn 循环，断言行为并执行效率预算棘轮。

新代码按职责归位：协议与数据类型放 `agent-protocol`，turn 状态机放 `agent-core`，会话编排与持久化放 `agent-runtime`，CLI 参数与 REPL 放 `agent-cli`，Web/HTTP 放 `agent-server`。GitHub/PR 相关配置放 `.github/`。

## 常用命令

提交前必须全部通过（与 CI 一致）：

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
cargo run --locked -p agent-eval -- run
```

- `cargo run -p agent-cli -- "hello"`：本地运行 CLI。
- `cargo run -p agent-cli -- --session work "continue"`：使用指定持久化 session 运行（`--thread` 是旧别名，新代码请用 `--session`）。
- 新增或调整 eval 场景后，用 `cargo run -p agent-eval -- run --update-baseline` 更新效率基线，基线变更随场景一并提交。

## 测试指南

新增逻辑就近添加单元测试，测试命名要描述行为，例如 `failed_turn_emits_error_and_does_not_update_thread`。CLI 存储相关测试使用临时目录，避免读写真实的 `~/.morrow`。涉及 agent 循环、工具结果回灌、审批、轮次上限或消息链的变更，应在 `crates/agent-eval/src/suite.rs` 增加或调整场景。

## Commit 与 Pull Request 规范

- 每个 commit 尽量只包含一个逻辑变更，提交信息使用 Conventional Commits 格式：`type(scope): subject` 或 `type: subject`，例如 `feat(cli): persist sessions`、`fix(model): handle empty stream`。
- PR 标题同样使用标准前缀格式，例如 `feat: persistent CLI sessions`、`fix: thread store error handling`。
- 新建分支使用 `feat/xxx`、`fix/xxx` 等形式，名称保持简短并使用小写短横线。
- PR 内容参照 `.github/pull_request_template.md`；涉及 CLI 参数、session 持久化、配置、协议/事件格式或 eval 场景变化时需明确说明。

## 架构决策记录（ADR）

改动涉及模块职责、协议／存储格式、权限与信任边界、并发模型或重要依赖选型，且存在值得权衡的替代方案时，写 ADR：

- 在决策形成时（不是事后补写）于 `docs/adr/` 新建编号记录：复制 `docs/adr/template.md`，编号不复用，状态保持 `Proposed`，并加入 `docs/adr/README.md` 索引。
- 状态只能由维护者改为 `Accepted`／`Rejected`：不要自行接受，也不要替旧设计补造理由；追记需标注并说明证据缺口。
- PR 描述里引用 ADR 编号，或写明「不涉及 ADR」及理由。
- 普通 bug 修复、改名、样式调整和常规工具实现不写 ADR。
- 改到权限、协议或持久化相关代码前，先读 `docs/adr/README.md`，检查是否触发某条已接受记录的「重评条件」。

## 安全与配置提示

- **密钥**：不要提交本地密钥。`morrow.toml` 已被忽略，可能包含本地测试用 API key；优先使用 `OPENAI_API_KEY` 等环境变量。
- **本地私有数据**：持久化 session 保存在 `~/.morrow/sessions/`，持久化 Subagent 保存在 `~/.morrow/subagent-sessions/`，可能包含用户输入和模型回复。
- **审批不是 OS 沙箱**：workspace-write 模式下 workspace 内的文件变更默认自动放行，需要逐次确认时显式开启 `workspace_write_require_approval`。
- **项目 Hook**：`<workspace>/.morrow/hooks.toml` 在显式 `morrow hooks trust` 前默认禁用；Hook 命令以用户身份执行，审查后再信任。
- **MCP 工具**：默认纳入审批管线，server 标注 `readOnlyHint` 的只读工具直接执行，其余工具每次调用都需批准，除非在 `[mcp_servers.*]` 里显式 `require_approval = false`。
