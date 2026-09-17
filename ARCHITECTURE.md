# Morrow 架构

> 核对日期：2026-09-17。本文只描述当前实现，不作为功能待办。
> [项目状态](STATUS.md) · [架构决策](docs/adr/README.md) · [Session 一致性协议](docs/session-consistency-protocol.md)

## 1. 一张地图

Morrow 是本地 coding agent：CLI 与浏览器共用运行时，运行时装配模型、工具和会话，核心状态机推进一次用户请求。

```text
CLI / Web                        接收输入、展示事件、审批与取消入口
    │
    ▼
agent-runtime                    上下文准备、工具装配、会话持久化、子代理监督
    │
    ▼
agent-core                       模型／工具循环、调度、审批恢复、中间件
    ├── Model 端口       ← agent-model：OpenAI-compatible HTTP / SSE
    └── ToolRuntime 端口 ← agent-tools：内置工具 / MCP
                                  └── agent-sandbox：路径与权限判断

agent-protocol：共享数据类型     agent-config：配置加载与校验
agent-hooks：中间件适配器        agent-eval：确定性回归，不进入生产运行时
```

**依赖原则：core 定义接口，适配器实现接口。** core 不依赖具体模型客户端、工具实现、CLI 或文件存储。CLI/server 创建模型客户端并注入 runtime；换模型或新增工具，通常不需要改 turn 状态机。

## 2. 一次请求怎样完成

1. **准备**：入口加载配置和 Session；runtime 准备项目指令、权限、工具定义及中间件，并按需压缩上下文。
2. **调用模型**：core 将系统提示、活动历史和本次输入组成模型请求，逐步输出文本事件。
3. **调用工具**：模型返回结构化工具调用；core 调度工具，必要时等待审批，将结果写回对话，再调用模型。
4. **收尾**：模型给出最终回答后，`after_turn` 中间件可接受、要求继续或判定失败；错误、取消和上限也会结束执行。
5. **记录与展示**：runtime 在执行过程中将相应事件转换为持久化事实，并向 CLI/Web 分发事件；结束时收束 turn。

实现是 `AgentTurnStream`，不是后台自动运行的黑盒：runtime 持续轮询它，它保存正在等待的模型流、工具 future、审批和待发事件。

调度约束：可并发工具最多同时执行 4 个，结果按模型原始调用顺序回灌；串行工具形成调度屏障。默认最多 99 轮工具调用，`after_turn` 最多接受 3 次继续请求。turn 内上下文超限时，尝试一次不带工具的总结调用。

## 3. 状态与持久化

| 概念 | 含义 |
| --- | --- |
| `Thread` | 下一次模型调用使用的活动消息历史 |
| `Turn` / `TurnRecord` | 一次用户请求的执行状态，以及该次产生的消息链 |
| `Session` | 完整会话的聚合投影：活动上下文、turn 历史和压缩状态 |

必须保持的不变量：

- **成功与失败分开**：成功 turn 的消息进入活动上下文；失败 turn 保留审计记录，但不直接追加到活动上下文。
- **消息链完整**：保留 user、assistant 工具调用、tool 结果和最终回答，不能只保存最终文本。
- **压缩不是删除历史**：压缩改变模型可见上下文，不删除完整审计历史。
- **事实与展示分开**：Session fact log 是持久化事实源；实时事件流不是另一份独立会话真相。
- **单写者**：通过 `SessionHandle` 和跨进程文件锁追加事实，不绕过它直接改日志。

当前 Session fact log 为 v7，事件 envelope 为 v8，Session 订阅流为 v3。协议变更、迁移和恢复细节以 [Session 一致性协议](docs/session-consistency-protocol.md) 为准；类型的 JSON 形状也是外部契约。

## 4. 权限、取消与子代理边界

审批必须发生在副作用之前，并校验请求身份；它不是操作系统级沙箱。取消是协作式停止，**不是撤销整个 turn 的副作用**。已提交的文件修改不会因后续失败自动恢复；远端模型与 MCP 操作能否停止取决于对端。

| 子代理机制 | 生命周期与边界 |
| --- | --- |
| `delegate_task` | 一次性委派、独立 Thread、只读禁 shell、随父 turn 取消；每父 turn 最多启动 4 次，单次超时 300 秒 |
| 持久子代理 | Web 提供创建、续发、检查、等待、取消；跨父 turn 存活，每会话最多 8 个实例、4 个并发 run |

持久子代理按 explore / plan / worker / reviewer 角色裁剪能力，有效权限不超过父权限和角色上限；写操作有共享写租约协调。`send_subagent` 只能在实例空闲时开始下一次执行，`wait_subagents` 超时不取消任务。重启将活跃任务标为 interrupted，不自动重放。

子代理不提供 MCP 或递归委派；只读角色仍可使用获准的 `web_fetch`，不等于离线。项目 Hook 需显式信任；MCP 的只读声明属于对外部 server 的信任边界。

## 5. 修改应该放在哪里

| 修改内容 | 位置／阅读入口 |
| --- | --- |
| 消息、turn、事实与事件类型 | `crates/agent-protocol/src/` |
| 模型／工具循环、审批恢复与调度 | `crates/agent-core/src/agent.rs`；端口见 `model.rs`、`tool.rs` |
| 模型 HTTP 请求和 SSE 转换 | `crates/agent-model/src/` |
| 内置工具、工具注册与 MCP | `crates/agent-tools/src/` |
| 路径与权限决策 | `crates/agent-sandbox/src/` |
| 上下文、持久化、子代理编排 | `crates/agent-runtime/src/turn.rs`、`session_handle.rs`、`subagent_supervisor.rs` |
| 配置、入口与界面 | `agent-config`、`agent-cli`、`agent-server` |
| Hook 策略扩展 | `crates/agent-hooks/src/` |
| 核心行为回归 | `crates/agent-eval/src/suite.rs` |

测试按边界分层：core/eval 使用假模型与工具验证循环；适配器测试协议转换；runtime 测试持久化与编排；server/Web 测试交互。确定性 eval 通过不代表真实模型任务成功率。

## 6. 文档怎样维护

- 改变已实现的模块边界、主流程或不变量时，更新本文。
- 进度与验证结果只写入 [STATUS.md](STATUS.md)，不在这里堆待办。
- 重要选择的背景、备选方案与代价记录为 [ADR](docs/adr/README.md)，不把历史设计补写成刚刚批准的决策。
