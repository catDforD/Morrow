# 01 · agent-protocol:一切共享类型的起点

> 阅读对象:本笔记梳理 `crates/agent-protocol`(9 文件,2306 行,其中测试 784 行)。
> 它是整个 workspace 依赖图的根:没有任何内部依赖,其余 10 个 crate 直接或间接都依赖它。

## 0. 这个 crate 是干什么的

agent-protocol 是 Morrow 的**通用语言层**:所有跨 crate 流动的数据结构——消息、turn、session、审批、subagent、事件、fact log——都定义在这里。它只有类型(纯数据 + 构造器/状态迁移方法),没有 I/O、没有状态机驱动逻辑、没有 tokio。

看 Cargo.toml 就一目了然:`agent-protocol -> (无内部依赖)`,只有 serde/serde_json 之类的生态依赖。

**为什么所有类型都要带 `Serialize + Deserialize`?** 因为这些类型会出现在三个截然不同的边界上:

1. **模型线路格式**:`Message`/`ToolCall`/`ToolDefinition` 按 OpenAI chat completions 的 JSON 形状序列化,直接发给兼容 API(agent-model 使用)。
2. **磁盘持久化**:`SessionDocument`(schema v7)、fact log 的每一条 JSONL 行(agent-runtime 使用)。
3. **浏览器协议**:`SessionSnapshot`/`SessionStreamFrame` 通过 agent-server 的 WebSocket 发给仪表盘。

一套类型三处复用,这正是"协议层独立成 crate"的理由:改任何字段,编译器会立刻告诉你哪些消费方被波及。

## 1. lib.rs:flat 门面

```rust
mod chat;
pub use chat::*;
mod events;
pub use events::*;
// ... facts, projection, session, subagent, turn 同理
```

只有 19 行。每个领域一个模块,然后全部 `pub use` 平铺回 crate 根。于是外部永远写 `agent_protocol::Message`,而不是 `agent_protocol::chat::Message`。

三个细节值得注意:

- 模块内部用 `use super::*` 引入彼此(而不是互相 `use crate::chat::...`),因为 lib.rs 的 glob re-export 把所有类型都抬到了根,模块里"感觉不到模块存在"。测试模块 `tests.rs` 也这么做,所以测试代码直接写 `Message::user(...)`。
- `#[cfg(test)] mod tests` 把 784 行测试隔离在发布构建之外。
- 这是近期 `3e282e0 refactor(protocol): split lib.rs into domain modules` 的产物:先拆文件、保持对外 API 不变,是典型的"先切面再动刀"重构。

## 2. chat.rs:消息与对话的线格式(233 行)

### 2.1 Message:一条消息的所有形态

```rust
pub struct Message {
    pub role: Role,                          // system | user | assistant | tool
    pub content: Option<String>,
    pub reasoning_content: Option<String>,   // 推理模型的思考内容
    pub tool_calls: Option<Vec<ToolCall>>,   // assistant 发起的工具调用
    pub tool_call_id: Option<String>,        // tool 角色回灌结果时对应的调用 id
}
```

一个 struct 同时表达四种角色,靠 `role` 区分,字段按需填充。这与 OpenAI 的 wire format 一一对应,所以它实现了完整的"消息族构造器":

| 构造器 | 产出的形态 |
|---|---|
| `system/user/assistant(content)` | 普通 text 消息 |
| `assistant_tool_calls(tool_calls)` | 纯工具调用消息(content=None) |
| `assistant_tool_calls_with_content(content, tool_calls)` | 边说话边调用工具 |
| `tool_result(tool_call_id, content)` | 工具结果回灌,`tool_call_id` 挂回调用 |

模型"边解说边调工具"在协议上就是 `assistant_tool_calls_with_content`,这是一个容易被忽略但很重要的形态(有些模型总是先输出一段文字再发起调用)。

`with_reasoning_content` 有个小细节:

```rust
self.reasoning_content = (!reasoning_content.is_empty()).then_some(reasoning_content);
```

空字符串会被吞掉变成 `None`,保证序列化时字段干脆地消失,而不是产出 `"reasoning_content": ""` 噪音。

两个类型系统细节:

- `Message` 实现了 `Eq`——它是纯字符串数据,可以逐字段比较,session 落盘前后 diff 测试依赖这一点。
- 对比 `ToolDefinition`(chat.rs:95)只有 `Partial PartialEq` 没有 `Eq`,因为它内嵌 `serde_json::Value`(JSON 数字没有自然的全序/相等语义,`serde_json` 不给 `Eq`)。这解释了为什么"参数 schema"是全 crate 唯一的"不完美可比"类型。

### 2.2 ToolDefinition / ToolCall:请求与响应的不对称

```rust
pub struct ToolDefinition {   // 注册侧:告诉模型有哪些工具
    #[serde(rename = "type")] pub kind: ToolDefinitionKind,   // 恒为 "function"
    pub function: ToolFunctionDefinition { name, description, parameters },
}
pub struct ToolCall {         // 调用侧:模型发回的调用
    pub id: String,           // 关联用的调用 id
    #[serde(rename = "type")] pub kind: ToolCallKind,
    pub function: ToolFunctionCall { name, arguments },       // arguments 是 String!
}
```

`arguments` 是 JSON 字符串而不是已解析对象——这是 OpenAI 协议的原样保留,解析发生在工具执行层。`ToolCallKind`/`ToolDefinitionKind` 两个单变体枚举看似多余,实则是为了把 `"type": "function"` 字段钉死在序列化输出里(测试 `serializes_assistant_tool_call_and_tool_result_messages` 验证了这个形状)。

### 2.3 Conversation vs Thread:两份消息列表的分工

- `Conversation`:一次性模型调用的完整输入(system prompt + 上下文 + 用户输入),由 core 每次组装。
- `Thread`:**长期存活**的对话主线。注意测试名:`thread_serializes_long_term_messages_without_system_prompt`——system prompt 属于 Conversation,不进 Thread,因为 prompt 每轮可能重建(AGENTS.md 热重载、hook 注入),不能烙死在持久层。

### 2.4 版本化文档信封

```rust
pub const THREAD_DOCUMENT_SCHEMA_VERSION: u32 = 2;
pub struct ThreadDocument { pub schema_version: u32, pub thread: Thread }
```

Thread 的磁盘格式是 v2。对比 session.rs 的 `SESSION_DOCUMENT_SCHEMA_VERSION = 7` 和 projection.rs 的 `SESSION_STREAM_SCHEMA_VERSION = 3`:**三种格式各自独立演进版本号**,互不牵连。

### 2.5 MCP 参数截断:协议层管 UI 体验

```rust
pub const MCP_ARGUMENTS_MAX_BYTES: usize = 2048;

pub(crate) fn truncate_mcp_arguments(arguments: &str) -> String {
    let mut end = MCP_ARGUMENTS_MAX_BYTES;
    while !arguments.is_char_boundary(end) { end -= 1; }   // UTF-8 字符边界回退
    format!("{}…(truncated)", &arguments[..end])
}
```

MCP 工具调用参数超过 2KB 就截断。截断发生在 `ApprovalRequest::mcp_tool` 构造时(见 turn.rs),即**进入审批流之前**——超大参数不会淹没审批界面,也不会进 fact log。回退到 `char_boundary` 是因为中文/emoji 参数按字节切会 panic,这个小函数是 UTF-8 安全截断的标准写法。`pub(crate)` 说明它是协议内部的实现细节,不外泄。

## 3. turn.rs:一次 turn 的生命周期与审批(367 行)

### 3.1 Turn 与 TurnStep:粗细两级状态

```rust
pub struct Turn {
    pub status: TurnStatus,            // Running | Completed | Failed
    pub user_message: Message,
    pub assistant_message: Option<Message>,
    pub model: Option<ModelInvocation>,        // 本轮实际用的模型(审计用)
    pub steps: Vec<TurnStep>,
    pub error: Option<String>,
}
pub struct TurnStep {
    pub kind: TurnStepKind,            // ModelCall | ToolCall
    pub status: TurnStatus,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub error: Option<String>,
}
```

Turn 记录"用户输入了什么、模型回了什么、中间经过哪些步骤"。`Turn::running` 的初始 `steps` 里已经预置了第一个 `ModelCall` 步骤——turn 从模型调用开始,之后的每次工具调用和回灌各加一步。

`Turn::fail` 里有一句关键注释和配套逻辑:

```rust
// 并发工具可能同时处于 Running;turn 收束后不能留下"仍在运行"的持久化状态。
for step in self.steps.iter_mut().filter(|step| step.status == TurnStatus::Running) {
    step.fail(error.clone());
}
```

并行工具调用意味着多个 step 同时 Running;turn 整体失败时必须把所有悬挂的 step 一并收束,否则持久化出来的记录永远"停在运行中"。这是协议层就守住的不变式,测试 `failed_turn_closes_every_running_step` 专门验证。

注意 `TurnStatus` 只有三个状态:**没有 Cancelled/Interrupted**。取消在协议里分成两个世界表达——文档模型里 turn 要么成要么败,而 fact log 的 `SessionTurnStatus` 有五个状态(见 §5)。原因:文档是"最终账本",取消最终会以失败或完成收束;而 fact log 要记录"中途发生了什么"。

### 3.2 审批四件套

```rust
pub enum ApprovalAction {          // 要批准的动作本身
    ShellCommand { command, cwd, timeout_secs },
    FileChanges { files: Vec<FileChangeSummary>, diff },
    McpTool { server, tool, arguments },
}
pub enum ApprovalOrigin {          // 这个请求从哪冒出来的
    Unknown,                       // 默认;序列化时整个字段跳过
    ParentTurn { turn_id, tool_call_id },
    SubagentRun { instance_id, run_id, role, identity_id, identity_name, tool_call_id },
}
pub struct ApprovalRequest { id, action, reason, origin }
pub struct ApprovalDecision { request_id, approved }
```

`ApprovalOrigin` 解决一个真实问题:subagent 干活触发的审批,UI 必须能标明"是哪个 subagent、哪个 run 要的权限",否则用户面对一个来源不明的 shell 命令很难下判断。`Unknown` 变体 + `skip_serializing_if = "ApprovalOrigin::is_unknown"` 让旧数据兼容、JSON 更干净——origin 为 Unknown 时这个字段根本不出现。

三个 `shell_command/file_changes/mcp_tool` 构造器都把 origin 固定为 `Unknown`,需要时用 `with_origin(...)` 链式补上。这是 Rust 常见的 builder 风格:默认值 + `with_*` 修饰。

### 3.3 工具执行摘要:结构化的"发生了什么"

`FileChangeSummary`(路径、add/update/delete 操作、替换次数、created/overwritten/deleted 标志)、`ShellCommandSummary`(命令、退出码、是否超时、stdout/stderr 是否被截断)、以及聚合容器:

```rust
pub struct ToolExecutionSummary {
    pub files: Vec<FileChangeSummary>,
    pub diff: Option<String>,
    pub shell: Option<ShellCommandSummary>,
    pub error: Option<String>,
    pub subagent: Option<Box<SubagentExecutionSummary>>,   // Box 打断递归大小
}
```

subagent 的执行结果嵌在 subagent 工具的摘要里——`Box` 是因为 `SubagentExecutionSummary` 不小,直接内嵌会撑大整个枚举/clippy 会报 `large_enum_variant`。这套摘要既是 fact log 的审计数据,也是 UI 上"这次工具调用改了 3 个文件"的展示来源。所有字段 `skip_serializing_if` 掉空值,测试 `omits_empty_tool_execution_summary` 断言空摘要序列化出来几乎不含字段。

### 3.4 TurnRecord:turn + 消息链的打包

```rust
pub struct TurnRecord { pub turn: Turn, pub messages: Vec<Message> }
```

`messages` 是这轮 turn 实际产生的消息链(user → assistant(+tool_calls) → tool 结果 → assistant…),`failed_user_prompt` 构造器处理"还没进模型就失败"的最小 turn:只有用户消息,turn 直接标失败。

## 4. session.rs:可持久化会话与权限模型(221 行)

### 4.1 Session 与 apply_turn:唯一的写入口

```rust
pub struct Session {
    pub active_thread: Thread,     // 下一轮模型会看到的上下文
    pub turns: Vec<TurnRecord>,    // 全部 turn 的审计历史
    pub context: SessionContext,   // 压缩摘要状态
}
pub struct SessionContext { pub summary: Option<String>, pub summarized_turns: usize }
```

写入口只有一个,而且是一条不变式:

```rust
pub fn try_apply_turn(&mut self, record: TurnRecord) -> Result<(), SessionApplyError> {
    if record.turn.status == TurnStatus::Running { return Err(SessionApplyError); }
    if record.turn.status == TurnStatus::Completed {
        self.active_thread.messages.extend(record.messages.iter().cloned());
    }
    self.turns.push(record);
    Ok(())
}
```

三条规则一次讲清:

1. **Running 的 turn 禁止落账**(方法名里的 `try_` 和 `SessionApplyError` 就是为此存在,`apply_turn` 只是 panic 版包装,注释明说"only terminal turn records may be applied")。
2. **只有 Completed 的消息链才进 active_thread**——失败 turn 的残骸(比如半截 tool 结果)不会污染下一轮模型上下文。这就是 eval 套件里 `failed_turn_emits_error_and_does_not_update_thread` 场景的协议依据。
3. **无论成败都进 `turns` 历史**——失败也要留审计记录。

### 4.2 权限模型:mode 与 shell 策略解耦

```rust
pub enum PermissionMode { ReadOnly, WorkspaceWrite, DangerFullAccess }   // 有序,severity 0/1/2
pub enum ShellPolicy { Deny, Prompt, Allow }
pub struct PermissionProfile { pub mode: PermissionMode, pub shell: ShellPolicy }
```

- `PermissionMode::severity()` 给三种模式排序,`clamp(ceiling)` 取"更严的那个"——web 会话的 permission ceiling(commit `436a38a`)就靠它:服务器上限 WorkspaceWrite,会话自己想要 DangerFullAccess 也会被钳到 WorkspaceWrite。测试 `permission_mode_clamp_picks_the_more_restrictive_mode` 验证。
- `PermissionProfile::for_mode` 给出默认组合:ReadOnly/WorkspaceWrite → shell 需审批(Prompt),DangerFullAccess → shell 直接放行(Allow)。mode 和 shell 策略拆开存,是为了将来允许"WorkspaceWrite 但 shell 默认拒绝"这类组合。

### 4.3 模型选择与推理档位

```rust
pub enum ReasoningLevel { Off, High, Max }        // as_str 直接当 API 参数
pub enum ReasoningProfile { None, Deepseek }      // 供应商差异的挂载点
pub struct ModelSelection  { provider_id, model_id, reasoning }        // 用户想要什么
pub struct ModelInvocation { provider_id, provider_name, model_id, model_name, reasoning }  // 实际用了什么
```

Selection 和 Invocation 分开:前者是配置意图,后者带冗余的 display name,烙进每条 fact/turn 记录里——即使配置后来改了,历史记录仍能回答"这轮当时用的是哪家哪个模型"。

### 4.4 SessionProjectionDocument

session.rs 末尾还放了一个 `SessionProjectionDocument`(包装 `SessionProjection`,复用 v7 版本号)。它是投影世界的持久化信封,具体投影见 §6。

## 5. facts.rs:Session fact log 的事件语言(115 行)

这是**事件溯源(event sourcing)**的写侧:session 的一切变化都以"事实"逐条追加。

```rust
pub struct SessionLogHeader { schema_version, session_id, created_at_ms }

pub struct SessionFactEnvelope {     // 每行 JSONL 的信封
    pub revision: u64,               // 单调递增,投影据此对齐
    pub timestamp_ms: u64,
    pub operation_id: Option<String>,   // 关联一次操作(发起/取消…)
    pub turn_id: Option<String>,        // 关联所属 turn
    pub fact: SessionFact,
}

#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum SessionFact {
    TurnStarted { user_message, model: ModelInvocation, permissions: PermissionProfile,
                  #[serde(default)] system_prompt: String },   // v7 起记录模型实际看到的完整 system prompt
    NoticeRecorded { message },
    ModelCallStarted { model_call_id },
    ModelMessageCommitted { model_call_id, message },
    ToolCallStarted { tool_call },
    ApprovalRequested { request },
    ApprovalResolved { decision },
    ToolCallFinished { tool_call_id, result, ok, summary },
    TurnCompleted / TurnFailed { error } / TurnCancelled { reason } / TurnInterrupted { reason },
    ContextCompacted { summary, covered_through_turn_id },
    MiddlewareFinished { invocation: MiddlewareInvocationFinished },
    PromptRejected { prompt, reasons },          // 只审计,不进投影上下文
    LegacyContextCheckpoint { source_schema, messages, diagnostic },  // 旧格式迁移锚点
}
```

值得咀嚼的细节:

- **打标方式与 turn.rs 不同**:`SessionFact` 用的是 adjacent tagging(`tag="type", content="data"`),即 `{"type":"tool_call_finished","data":{...}}`;而 `ApprovalAction` 等用 internally tagged(`tag="kind"`,字段平铺在同级)。为什么?fact 是"一条日志行只讲一件事"的记录,type/data 外壳对日志分析工具最友好;而 action 需要和 `id`/`reason` 同层出现。
- **`system_prompt` 与 `#[serde(default)]`**:v7 把"模型可见输入"完整记档(commit `26ba8a0`),注释明说 v6 及更早的行没有此字段、反序列化成空串。`ToolCallFinished.summary`、`MiddlewareFinished.injected_context` 同理。测试 `v6_fact_lines_without_model_visible_fields_still_parse` 是回归保护:**旧日志必须永远能被新代码读**。
- **`LegacyContextCheckpoint`**:从快照格式(v≤6)迁移到纯 fact log 时,旧上下文整体作为一条"检查点事实"入账,来源 schema 和诊断信息都保留。这就是"从头重建投影也能对上历史"的桥。
- **`ModelCallStarted` 只带 id**:消息内容等到 `ModelMessageCommitted` 才落账——流式过程中的部分文本不进事实流,提交才算数。
- 尾部三个枚举 `SessionTurnStatus`(Running/Completed/Failed/Cancelled/Interrupted)、`SessionStepStatus`(多一个 **OutcomeUnknown**)、`SessionStepKind` 是投影世界用的状态集。`OutcomeUnknown` 值得单独记住:崩溃/断电后重启,日志里最后一条 step 只有 Started 没有 Finished,投影只能如实说"结局不明"——事件溯源系统对不确定性的诚实表达。

## 6. projection.rs:从 fact 流折叠出的"现在"(164 行)

写侧是 facts,读侧就是 projection。schema 独立版本号:`SESSION_STREAM_SCHEMA_VERSION = 3`。

```rust
pub struct SessionProjection {      // 对一个 session 的完整读视图
    pub session_id: String,
    pub revision: u64,              // 对齐 fact envelope 的 revision
    pub turns: Vec<TurnProjection>,
    pub context: ModelContextProjection,   // summary + 覆盖到哪个 turn + 消息列表
    pub middleware_audit: Vec<MiddlewareInvocationFinished>,
    pub diagnostics: Vec<String>,          // 投影过程中的异常/丢弃说明
}
```

`TurnProjection` 比文档世界的 `Turn` 富得多:有 `id`/`operation_id`/`index`/时间戳,每个 step 是 `SessionStepProjection`,内含 model_message、tool_call、tool_result、tool_summary、approval、approval_decision——**一次工具调用从发起到审批到结果的全过程折叠在一个 step 里**,UI 不用再回放事实流。

实时通信的三个部件:

```rust
pub struct SessionSnapshot {        // 新客户端接入时先发这个
    schema_version, session_name, session_id, revision, cursor: StreamCursor,
    session: SessionProjection,
    active_operation: Option<OperationProjection>,   // 进行中的操作 + 流式状态
    permissions, approvals: Vec<ApprovalRequest>, subagents: Vec<SubagentInstanceSnapshot>,
}
pub struct OperationProjection { operation_id, turn_id, phase, streaming: Option<StreamingMessageProjection>, cancellable }
pub struct StreamCursor { stream_id, sequence }    // 断线重连的游标
```

`SessionUpdate` 是增量推送的九种变化(TurnUpserted / ContextReplaced / OperationReplaced / **ModelStreamDelta**(text/reasoning 双通道流式 delta) / ApprovalsReplaced / SubagentUpserted / SubagentRemoved / MiddlewareRecorded / Notice),外面套 `SessionUpdateEnvelope`(schema_version、stream_id、**sequence**、session_revision、timestamp)。客户端逻辑因此是标准的流式协议:先收 Snapshot,后逐条收 Event,sequence 跳号或 revision 对不上就请求 Resync。

`SessionStreamFrame` 是 WS 上的顶层帧:Snapshot / Event / **ResyncRequired** / CommandResult(命令受理回执,带 request_id)/ CommandData。`TurnUpserted(Box<TurnProjection>)` 和 `SubagentUpserted(Box<...>)` 里的 Box 还是那个理由:别让大结构撑爆 enum。

这套类型是 agent-server 仪表盘协议的全部——`b782f70 refactor(web): make dashboard browser-only` 之后,浏览器 UI 只见投影,不见内部状态机。

## 7. events.rs:进程内事件流 + 中间件审计(151 行)

### 7.1 AgentEvent:turn 执行过程中往外冒的通知

```rust
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    TurnStarted,
    ModelCallStarted,
    MiddlewareStarted(MiddlewareInvocationStarted),
    MiddlewareFinished(MiddlewareInvocationFinished),
    Warning(String),
    ReasoningDelta(String),      // 思考流
    TextDelta(String),           // 正文流
    ModelMessageCommitted { model_call_id, message },
    AgentMessage(String),        // 整段最终文本
    SubagentStarted { id, agent_id, agent_name, task },
    SubagentFinished { id, ok, summary },
    SubagentUpdated(Box<SubagentInstanceSnapshot>),
    ToolCallStarted { id, name },
    ToolCallFinished { id, name, ok, summary },
    ToolResultCommitted { tool_call_id, message, ok, summary },
    ApprovalRequested(ApprovalRequest),
    ApprovalResolved(ApprovalDecision),
    TurnCompleted,
    Error(String),
}
```

这是 agent-core 状态机向外吐的事件流,CLI REPL 的转圈、server WS 的转发都消费它。三组 delta/committed 对:`TextDelta` → `ModelMessageCommitted` → `AgentMessage`;`ReasoningDelta` 单独一条通道;工具侧 `ToolCallStarted` → `ToolCallFinished`(执行层)→ `ToolResultCommitted`(结果回灌上下文)。`AgentEventOrigin`(events.rs:5)给事件标注来源:Session / ParentTurn / SubagentRun——主会话和 subagent 的事件可以共用一条流而不混淆。

### 7.2 中间件:七个阶段与安全相关的双失败语义

```rust
pub enum MiddlewareStage { BeforePrompt, BeforeTool, PermissionRequest, AfterTool, AfterTurn, PreCompact, PostCompact }
pub enum MiddlewareSource { Internal, UserCommand, ProjectCommand }
pub enum MiddlewareAgentScope { Main, DelegatedSubagent, PersistentSubagent }
pub enum MiddlewareOutcome { Continue, Approve, Deny, FailedOpen, FailedClosed, Cancelled, SkippedUntrusted }
```

`FailedOpen` vs `FailedClosed` 的区分是安全设计:hook 命令自己崩了,是"失败放行"(open,危险但可用)还是"失败拒绝"(closed,安全但易碎)——按阶段语义决定,审计里必须留下是哪种。`SkippedUntrusted` 对应项目 hook 未 `morrow hooks trust` 时的跳过。

`MiddlewareContextBlock { middleware_id, source, stage, content }` 是 hook 向模型请求注入的上下文块,注释明说它定义在 protocol 层的原因:要跟 fact log 一起持久化(`MiddlewareFinished.injected_context`,v7 起有值)。审计不只记"hook 跑了",还记"hook 往模型里塞了什么"。

## 8. subagent.rs:监督下的子代理(252 行)

顶部就是硬约束常量:

```rust
MAX_SUBAGENT_PROMPT_SUFFIX_CHARS = 4_000
MIN/MAX_SUBAGENT_TIMEOUT_SECS    = 30 .. 1_800      // 30秒 ~ 30分钟
MIN/MAX_SUBAGENT_TOOL_ROUNDS     = 1 .. 99
```

校验常量放协议层,意味着 CLI/server/eval 无论哪条路径配置 subagent,约束都一致。

```rust
pub enum SubagentRole { Explore, Plan, Worker, Reviewer }    // 有 Ord!可排序
pub enum SubagentInstanceStatus { Idle, Queued, Running, WaitingApproval, Interrupted, Failed, Cancelled }
pub enum SubagentRunStatus { Queued, Running, WaitingApproval, Completed, Failed, Cancelled, Interrupted }
```

两套状态对应两个生命周期:`SubagentIdentity` 是**常驻身份**(persistent subagent,跨 run 存活,状态 Idle↔Running 循环,`is_active()` 含 Queued/Running/WaitingApproval 三态);`SubagentRun` 是**单次任务**(发起到终态,`is_terminal()` 判定收束)。`SubagentRoleOverride` 允许按角色定制模型选择、prompt 后缀(≤4000 字符)、超时和轮数上限。

`SubagentRunSummary` 是审计聚合体:模型/工具调用次数、文件变更、shell 命令列表、`truncated` 标志(结果被截断过)。`SubagentInstanceSnapshot` 投影给 UI:`latest_run_id/latest_task/latest_summary/queue_reason` + `event_log_truncated`。

还有个彩蛋:`default_subagent_identities()` 内置 22 个身份,全是少女乐队/动画角色名("后藤一里"、"山田凉"、"高松灯"…),id 形如 `builtin-01`。默认给 subagent 拟人名,方便 UI 里区分"后藤一里在跑 explore"。

## 9. tests.rs:784 行测试教你怎么用(25 个测试)

按主题分组:

- **序列化形状**:`serializes_messages_in_openai_chat_shape`、`serializes_assistant_tool_call_and_tool_result_messages` 等,逐字段断言 JSON 输出——这是把"OpenAI 兼容形状"当契约钉死。
- **版本化信封**:`thread_document_serializes_versioned_thread`、`session_document_serializes_versioned_session`(断言 `schema_version == 7`)。
- **Session 不变式**:`running_turn_cannot_be_applied_to_session`、`applying_failed_turn_updates_history_without_changing_active_thread`。
- **审批**:`mcp_tool_approval_roundtrips_and_truncates_arguments`(2KB 截断 + roundtrip)。
- **向后兼容**:`v6_fact_lines_without_model_visible_fields_still_parse`——手工构造 v6 缺字段的 fact 行,断言新代码能读。
- **状态收束**:`failed_turn_closes_every_running_step`。

测试命名全是行为句式(`failed_turn_closes_every_running_step`),和 AGENTS.md 的测试指南一致。

## 10. 全 crate 的设计模式小结

1. **serde 打标双风格**:内部打标 `tag="kind"`(枚举字段平铺,适合和兄弟字段同层)vs 邻接打标 `tag="type", content="data"`(外壳+载荷,适合日志行/WS 帧)。看到 `type/data` 就知道这是"一条记录一件事情"。
2. **信封 + schema_version**:ThreadDocument(v2)、SessionDocument(v7)、SessionStream(v3)各自独立版本化;所有"以后才加的字段"都 `#[serde(default)]`,所有"可缺省字段"都 `skip_serializing_if`——**读旧永远兼容,写新尽量精简**。
3. **文档模型 vs 事件流双层**:Turn/Session(TurnStatus 三态)是"账本最终态";SessionFact/SessionTurnStatus(五态,含 Cancelled/Interrupted/OutcomeUnknown)是"过程实况"。前者给恢复和下一轮上下文,后者给审计和 UI 投影。`SessionProjection`/`SessionUpdate`/`SessionSnapshot` 就是事实流折叠后的读侧。
4. **协议层收口安全语义**:权限有 `severity()+clamp()` 天花板;审批带 `ApprovalOrigin` 溯源;中间件区分 `FailedOpen/FailedClosed` 并审计注入内容;MCP 参数在构造审批请求时就截断。安全不是某个上层模块的自觉,而是类型就带这些槽位。
5. **ID 关联而非嵌套引用**:`model_call_id`/`tool_call_id`/`operation_id`/`turn_id`/`request_id` 把散布在 fact 流、事件流、投影里的一件事串起来,而不是互相嵌套持有——追加日志天然只有"引用"没有"指针"。

## 11. 消费方地图(读后续 crate 时的接线图)

| 类型 | 主要消费方 |
|---|---|
| `Message`/`ToolCall`/`ToolDefinition`/`Conversation` | agent-model(线路序列化)、agent-core(上下文组装) |
| `Model`/`ToolRuntime` 所需的数据类型 | agent-core 端口(下一个 crate) |
| `Session`/`SessionDocument`/`TurnRecord` | agent-runtime(SessionStore、v7 fact log 持久化) |
| `SessionFact`/`SessionFactEnvelope` | agent-runtime 写;agent-core 投影 |
| `AgentEvent` | agent-core 事件流 → agent-cli(REPL 渲染)、agent-server(WS 转发) |
| `ApprovalRequest`/`ApprovalDecision`/`ApprovalOrigin` | agent-hooks(permission 阶段)、agent-cli/server(审批 UI) |
| `SessionSnapshot`/`SessionStreamFrame`/`SessionUpdate` | agent-server 浏览器协议 |
| `Subagent*` | agent-runtime(监督)、agent-tools(subagent 工具)、agent-server(面板) |
| `PermissionMode`/`PermissionProfile`/`ShellPolicy` | agent-config(配置)、agent-sandbox(判定)、agent-server(ceiling) |

下一篇:agent-core——看 `Model`/`ToolRuntime` 端口 trait 如何定义,状态机如何消费上面的事件流。
