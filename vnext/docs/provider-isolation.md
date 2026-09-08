# Provider 与 Rust 内核解耦：设计与实现

状态：已于 2026-09-07 实施。下文保留设计动机、接口约束和验收清单；第 2 节描述改造前的耦合。使用命令与配置见 [README](../README.md)。

实现入口：

- [launcher.ts](../packages/host/src/launcher.ts)：Node 公共入口、Rust 环境白名单、父子进程生命周期、凭据管理命令。
- [provider.ts](../packages/sdk/src/provider.ts)：`Provider.prepare/execute` 契约；[provider-service.ts](../packages/host/src/provider-service.ts)：profile、凭据、实例固定、脱敏与进度批处理。
- [providers.ts](../packages/host/src/providers.ts)：Chat Completions 与 Responses 的 HTTP/SSE 编解码，Rust 已移除 reqwest。
- [effects.rs](../crates/kernel/src/effects.rs)：统一准备、持久化、执行、结算；[legacy](../crates/kernel/src/legacy/mod.rs)：冻结 v1 只读兼容；[runtime.rs](../crates/kernel/src/runtime.rs)：复制迁移。
- [provider.test.mjs](../tests/provider.test.mjs)：本地协议服务器、真实 Rust/Node 调用链、续接、密钥隔离与迁移回归。

当前交付支持文本、本地 function tools 与 Responses `store:false` 续接。凭据支持 `env:`、`file:`、`local:` 引用；公开 plan 附带去除 credentialRef 的 profile 快照。默认内置的[模型设置插件](model-settings-plugin.md)可编辑连接、API key 与模型，保存后立即用于后续请求；手动修改文件仍需重启。SDK 保留 Node 内的旧 `model()` 适配器。

OAuth/keychain、远端 conversation、托管工具和多模态尚未实现。不兼容的 continuation 会在准备阶段报错；可新建会话，或先用原 provider 压缩上下文。普通插件仍是同一 Node 进程内的受信任代码，prepare 的无网络约束属于插件契约，不是沙箱保证。

2026-09-08 明确了凭据边界：要求配置与协议不写死在 Rust 内核中，允许密钥在网页保存时经过 Rust 的通用 RPC。以下执行阶段仍由 Node 管理凭据；不再要求专门的浏览器到 Node 网关。

目标：模型协议、请求构造、网络传输、响应解析和凭据由 Node provider 管理；Rust 保留会话事实、上下文来源、执行许可、结果提交和中断恢复。新增 Responses 等协议，应通过新增 provider 完成。

## 1. 推荐的边界

采用现有的 Rust + Node 两进程结构。Node Host 同时承载 driver、provider 和凭据服务；Rust 提供协议中立的模型执行管线。Provider 使用已有 Cordis 注册、作用域和版本机制。

| 能力 | 所属层 | Rust 保留的数据或约束 |
| --- | --- | --- |
| 选择 provider、模型和参数 | Node driver / policy | 本次选择的不可变快照 |
| 参数及模型能力校验 | Node provider | 通用 JSON 结构和大小限制 |
| 构造 Chat Completions / Responses 请求 | Node provider | 无凭据的准备结果及其来源 |
| API key、OAuth token、签名、刷新凭据 | Node credentials service / provider | 配置引用；没有密钥值 |
| HTTP、SSE、其他传输及响应解码 | Node provider | 执行开始、结束、通用结果 |
| 用户输入、Surface、消息与工具配对 | Rust | 当前投影和完整事实日志 |
| 本地工具审批与执行 | Rust 原有工具管线 | 继续保持原有审批、结果顺序和恢复规则 |
| 流式展示 | Node 归一化，Rust 转发，Web/CLI 展示 | 请求身份、序号、生命周期检查 |
| 决定是否重试、压缩、切换模型 | Node driver / policy | 每次实际模型尝试独立记录 |

“隔离”在本提案中包含 Rust/Node 的模块与进程边界。普通插件与 provider 仍处于同一个受信任的 Node 进程，Cordis 服务注入不能隔离恶意插件。将来需要单独限制第三方插件时，可增加 provider worker；当前先完成两进程边界，避免同时引入新进程体系。

## 2. 改造前的具体耦合

| 源码入口 | 改造前行为 | 已实现的目标行为 |
| --- | --- | --- |
| [protocol.rs](../crates/kernel/src/protocol.rs) 的 `provider_body()` | 所有 provider 共用 Chat Completions 请求形状 | 编码逻辑移到 Node adapter |
| [projection.rs](../crates/kernel/src/projection.rs) 的 `reconstruct()` / `validate()` | 重建 provider body，并限制参数名称 | 重建统一输入；校验执行关系和无凭据准备记录 |
| [effects.rs](../crates/kernel/src/effects.rs) 的 `model_call()` | 特判 `provider == "openai"` | 所有 provider 经过同一注册和调用路径 |
| 同文件的 `http_model()` / `Sse` | Rust 发送模型 HTTP、读取密钥、解析 SSE | 移到 Node 内置 provider |
| [runtime.rs](../crates/kernel/src/runtime.rs) 的 `Runtime` | 持有全局 `model`、`base_url`、`api_key` | 模型选择由 Host 配置；Rust 保存请求级公开元数据 |
| [main.rs](../crates/kernel/src/main.rs) | Rust 读取环境密钥，再启动去掉密钥的 Node 子进程 | Node 作为入口，使用干净环境启动 Rust |
| [SDK](../packages/sdk/src/index.ts) 的 `Morrow.model()` | `PreparedRequest → Message` 单阶段回调 | provider 的 `prepare` 与 `execute` 分阶段接口 |
| [defaults.ts](../packages/host/src/defaults.ts) | 字符串匹配上下文错误、默认硬编码 provider | 根据结构化错误和 profile 选择策略 |
| [server.rs](../crates/kernel/src/server.rs) 与 [Inspector.tsx](../packages/web/src/Inspector.tsx) | 用 Rust 重建 body 并比较 | 分别查看统一输入和 provider 准备记录 |

仅把 `http_model()` 移到 TypeScript，会留下请求格式、参数、凭据启动路径以及结果表示的耦合。下面按完整调用链调整。

## 3. Provider、连接配置和凭据分别管理

区分三个概念：

- **Provider 实现**：协议适配代码，例如 `openai-chat`、`openai-responses`。按插件版本固定。
- **Profile**：某个用户的连接配置，例如 `work-responses`。包含 provider、模型、endpoint、参数默认值和 `credentialRef`。
- **Credential**：API key 或 OAuth 信息，只在 Node 凭据服务中解析与使用。

同一个 Responses adapter 可以服务多个账号和 endpoint；多个 adapter 也可以使用同一个凭据引用。

Host 本地 `providers.json` 配置示例：

```json
{
  "profiles": {
    "work-responses": {
      "provider": "openai-responses",
      "model": "<model-id>",
      "endpoint": "https://api.openai.com/v1/responses",
      "credentialRef": "env:OPENAI_API_KEY",
      "options": { "store": false }
    }
  }
}
```

Session 保存所选 profile ID 和公开覆盖项。Host 在准备请求时合并 profile、policy 和本次 options，并固定解析后的公开配置。配置中途修改，下一次请求才生效。执行时不能重新读取新的 endpoint 或模型默认值。

Provider 校验自己的 options。Rust 只要求它是有大小和深度限制的 JSON 对象。Adapter 明确处理 `model`、上下文和本地工具等保留字段，避免通用 options 覆盖已固定的输入。未知参数报结构化错误，不能悄悄忽略。

凭据更新独立于插件版本和会话历史。轮换 key 不要求重建插件、不写入新插件源码，也不把值放进 `run.setState()`。凭据引用的可用范围由 Host 本地配置管理，模型生成的插件或 policy 不能自动把账号切到任意凭据或任意远端地址。

## 4. 两阶段接口：prepare 与 execute

核心接口如下，完整类型以 SDK 为准：

```ts
interface Provider {
  capabilities: ProviderCapabilities

  prepare(
    input: Readonly<ModelInput>,
    profile: Readonly<PublicProfile>,
  ): Promise<PreparedPlan>

  execute(
    plan: Readonly<PreparedPlan>,
    context: ProviderExecutionContext,
  ): Promise<ModelResult>
}
```

`prepare()` 校验参数、转换消息和工具定义，产生可序列化、无凭据的准备记录。它不发送模型请求、不获取密钥，不返回客户端对象、闭包或网络连接。时间戳、随机值等确实影响请求的公开值必须固定进 plan；相同输入和配置的编码应可重复验证。

`execute()` 接收 Rust 已提交的 plan，只在获得执行调用后读取凭据、连接远端、解析事件。通用执行上下文只提供 `signal`、凭据访问、受控事件发送和 Host 传输服务；不直接暴露可递归调用模型、修改 Surface 的完整 `RunContext`。Driver 继续通过 SDK 使用 `run.model()`。

`ctx.morrow.provider(name, provider)` 复用 Contributions 和 Cordis 生命周期。现有 `ctx.morrow.model(name, handler)` 由 Node 提供迁移适配器；Rust 不保留特殊旧 provider 分支。

### 4.1 Rust 能看懂的输入

`ModelInput` 包含已固定的模型标识、系统指令、按 Surface 解析的消息、临时消息、本地工具定义、options，以及节点关联的 provider 扩展数据。

Rust 负责从 `surface + temporary` 构造这份输入，校验工具消息配对和主请求/摘要请求的范围。Provider 得到真实的消息内容，不再从一个 Chat Completions body 反推上下文。

请求的来源还要记录 session、run、step、request ID、Surface revision、provider registration，以及公开 profile 快照。Provider registration 包含 plugin/version/scope/epoch/generation；内置 provider 也有随构建产物固定的版本标识。

### 4.2 Rust 只保存、不解释的准备记录

`PreparedPlan` 使用一个小型通用信封：

```ts
interface PreparedPlan {
  format: string       // 如 openai.responses.http.v1
  payload: JsonValue   // provider 的无凭据执行参数
  profile?: JsonValue  // Host 固定的公开配置快照
}
```

HTTP adapter 的 payload 可包含固定的 endpoint、method、非敏感 headers、body；本地推理或其他传输可使用自己的 payload。核心 RPC 不以 HTTP 为唯一模型传输。

Host 在跨 RPC 前校验公开字段并脱敏。凭据通过引用或明确标注的 secret slot 在执行阶段注入。带签名的 URL、Cookie、认证头、含 token 的 body 字段都属于 Node 执行时数据。首批 Chat/Responses adapter 使用无密钥 body 和执行时 Authorization，便于完整记录业务请求。

Rust 为来源和 plan 计算记录摘要，并把提交后的 plan 回传给 Host 执行。Host 对它做运行时冻结或防御性复制；TypeScript 的 `Readonly` 只提供编译期约束。标准 HTTP helper 在发送前固定序列化后的 body，禁止 prepare 后偷偷合并新参数。

## 5. 保留“先落盘，再执行”的生命周期

建议在现有事实基础上增加 `ModelRequested`，记录协议中立的输入来源并占用本次模型尝试。随后保留准备、effect 和消息提交的分工：

```text
Node driver 调用 run.model()
  → Rust 校验并提交 ModelRequested，固定输入与 provider
  → Rust 回调 Node provider.prepare()
  → Rust 重新校验有效性，提交 RequestPrepared
  → Rust 提交 EffectStarted
  → Rust 调用 Node provider.execute(已提交的 plan)
  → Node 请求模型，发送通用进度事件，返回 ModelResult
  → Rust 校验结果，提交 EffectSettled
  → Rust 提交 ModelSettled，更新上下文并回复 driver
```

`ModelRequested` 让准备失败、准备时取消和正在 prepare 的请求也有明确记录。它同时阻止同一步并发准备两个会改变模型上下文的请求。准备失败通过本次 `ModelSettled` 的错误分支关闭，不需要伪造 `RequestPrepared` 或 `EffectStarted`；对应 reducer 规则需要调整。

执行管线保持在 Rust，使“写盘失败时不调用 execute”成为一个可以直接测试的条件。所有 provider 都经过这条路径，包括项目随包提供的默认 provider。

### 5.1 锁、版本和取消

- 持有 SessionStore 锁时固定状态并提交事实；等待 Node prepare/execute 或网络时释放锁。
- Prepare 返回后重新校验 run、step、epoch、revision 和本次 request。期间取消或来源变化，则关闭请求，不调 execute。
- Host 在 prepare 与 execute 之间保留同一个 provider 实例和公开 profile 快照。插件更换/卸载在 step 边界处理，不能先用 A 版本编码再用 B 版本执行。
- 每次尝试拥有唯一 request ID。跨 RPC 的重复 execute 在 Host 登记表中复用正在进行的 Promise 或拒绝，不能再次发送网络请求。相同 ID 携带不同 plan 必须拒绝。
- 取消传给 provider 的 AbortSignal 和底层传输。迟到的进度、结果由 Rust 的请求身份和终态检查挡住；若取消先提交终态，随后结果不能覆盖它。

`EffectStarted` 表示内核已允许执行，不证明远端已经收到请求。开始之后若没有可靠终态，仍按 `Unknown` 处理；这条规则在新架构中保持不变。

### 5.2 恢复矩阵

| 已持久化到哪里 | 中断恢复行为 |
| --- | --- |
| 只有 ModelRequested | 准备未完成，本次模型执行未开始；关闭请求 |
| 已有 RequestPrepared，尚无 EffectStarted | 标记未开始；保留准备记录供查看 |
| 已有 EffectStarted，无可靠结果 | effect 记为 Unknown；不自动重发 |
| 已有 EffectSettled，缺少 ModelSettled | 用已保存的完整 ModelResult 补齐消息及扩展数据 |
| 已有 ModelSettled | 回放已提交结果；不调用 provider |

副作用可能已发生时，恢复不承诺 exactly-once。新的显式重试会获得新 ID，并通过 `retry_of` 关联旧尝试。Node SDK 的隐式自动重试默认关闭；HTTP 库或官方 SDK 若会自动重发，也要显式禁用。Driver 可对明确的限流等错误制定有限重试策略，对上下文超限执行压缩后重新准备请求。

## 6. 结果需要保留 provider 原生数据

目前 `Message` 只有文本、reasoning 字符串和工具调用。Responses 会返回多种 output items；其中一部分是继续对话所需的数据，不能全部压平成一个字符串。

建议保留现有 Message 作为 Agent 和聊天界面的通用表示，增加模型结果信封与节点关联的扩展：

```ts
interface ModelResult {
  message: Message
  continuation?: {
    format: string
    data: JsonValue
  }
  usage?: { inputTokens?: number; outputTokens?: number }
  finishReason: string
}
```

真实持久化结构还要关联源 request、provider 实现和数据 schema 版本。`continuation` 保存 provider 下一次调用所需、可持久化且不含凭据的原生片段。例如 Responses 的有序 output items、item ID、reasoning 数据。Rust 不解码其协议含义，但保存所有者、关联节点和大小限制。

通用消息和 continuation 必须放在同一个已提交的 ModelResult 中。不能先提交消息，再异步调用 `setState()` 存续接数据，否则中途崩溃会产生可显示却不能正确继续的对话。恢复时从 EffectSettled 补齐整个结果。

Provider 编码上下文时，对每个仍在 Surface 中的节点选择兼容的原生数据或通用消息表示，避免同时加入两份相同内容。工具结果跟在对应 assistant 输出之后。压缩移除的节点，其 continuation 也不能偷偷加入后续请求；摘要只引用当前允许的节点。

切换 provider 时由目标 adapter 进行兼容性检查：可通过通用 Message 转换时采用通用表示；必须依赖无法识别的原生数据时，明确报不兼容或由 driver 安排摘要转换。不能丢掉关键内容后继续请求。

一期覆盖当前文本、推理相关续接数据和本地 function calling。图像、音频输入等新的通用消息能力，需要后续设计 content blocks；仅增加 opaque JSON 不会让现有文本 UI 自动支持多模态。

## 7. Responses 作为第二个正式 provider

第一批同时提供两个内置插件实现：`openai-chat` 和 `openai-responses`。二者都通过新接口注册，默认 provider 也使用插件路径。

Responses adapter 的明确职责：

1. 将统一输入转换成 Responses 的 `input`、`instructions` 和工具定义。
2. 将 function call 的 `call_id` 映射到内核 ToolCall ID；区分 output item ID 和 call ID。
3. 将本地工具消息编码为 `function_call_output`。
4. 将协议流事件转换成通用进度；收集完整 output items 后生成 ModelResult。
5. 校验所选模型支持的参数和能力，归一化结束原因与错误。

一期默认使用本地完整上下文和 `store: false`，保存并按协议要求回传必要 reasoning items。这样上下文来源由本地 Surface 完整描述，压缩和 provider 切换更容易推导。首期不默认依赖 `previous_response_id` 或远端 conversation。

后续若支持远端连续会话，必须记录远端句柄和本地上下文对应关系。Surface 压缩、fork、切换 profile 或模型时，需要失效或重新建立远端链；凭旧 response ID 继续，可能把已经移出 Surface 的历史再次带给模型。

首期启用的工具是内核可审批和执行的本地 function tools。服务商托管的搜索、代码执行和远端 MCP 会在远端产生操作，应另行声明能力、展示并记录相应执行语义，不能伪装成本地工具或默认绕过已有审批设计。

依据官方文档：

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling#function-tool-example)：保留返回的 output items；工具结果使用 call_id；推理模型工具链还需要回传 reasoning items。
- [Responses 的状态管理迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses#4-decide-when-to-use-statefulness)：使用 store: false，并保留、回传加密 reasoning items 支持无远端会话状态的调用。

## 8. 流式进度与错误使用统一协议

SDK 提供面向请求的事件发送能力，协议级 SSE 事件名称留在 provider 内。第一批事件包括正文增量、可展示的 reasoning 摘要增量、工具参数增量和 usage 更新；加密 continuation 只参与续接，不送进正文 renderer。

事件信封带 session/run/step/request、连接 epoch 和递增序号。Host 绑定这些身份，provider 不能随意指定其他请求。Rust 检查活动 effect 后转发。

正文 delta 仍为临时显示通知，最终 ModelResult 为事实来源。Web 和 CLI 按 request ID 管理流，忽略过期/重复事件；摘要请求不混入主回答。现有 Web 只按 session 累加文本，需要同步调整。

进度采用有界缓冲和批量发送，避免每个 token 往返一次 RPC。消费者落后时可发明确的重同步/缺口标记；不能因为 UI 流队列满而阻塞最终事实提交。丢失增量不能靠日志恢复，完成后以已提交结果为准。

错误也应携带稳定的通用 code，例如 `authentication`、`rate_limit`、`context_length`、`invalid_request`、`unsupported_capability`、`transport`、`invalid_response`。增加可选的 HTTP status、retry delay 和脱敏说明。执行是否可能发生，与错误类别分别记录：网络中断不自动等于 Failed，取消也不意味着远端操作已撤销。

两端 RPC 当前把错误变成字符串，需要保留结构化 error data。默认 driver 据此处理压缩与有限重试；UI 使用安全说明。普通异常和 provider 返回的错误都要经过同一个 Node 脱敏边界。

## 9. Node 管理模型凭据与配置

原来以 `OPENAI_API_KEY=... morrow-next` 启动 Rust 主程序时，Rust 会继承 key。当前 Node 公共入口使用环境白名单启动 Rust，让模型配置和凭据管理集中在 Node；这与允许网页保存时通过 Rust 转发是两个独立边界。

推荐把公开入口改为 Node 启动器，并与 Host 使用同一个 Node 进程：

```text
用户 / shell
  → morrow-next：Node 入口，加载 profile，按需解析凭据
       → 启动 Rust kernel 子进程：显式构造允许的环境
       ↔ 连接 Rust 的本地 JSON-RPC
       → provider 连接远端模型服务
```

Rust 子进程的环境从空集合按平台添加必要项，例如 PATH、临时目录、locale、Windows 系统路径。不得使用 `{ ...process.env }` 后只删除某个已知 key。Provider 凭据、代理认证、SDK 调试配置等都不向 kernel 继承。Home/workspace 等运行路径可继续通过明确参数提供。

Node 接受现有用户级 CLI 参数，将模型和连接参数解析为 Host profile；workspace、home、审批等通用参数转交 kernel。Rust 内部二进制与公开 launcher 分开命名。Unix 启动脚本、Windows 启动包装、bundled Node、测试启动助手和打包脚本一起更新。历史查看可以直接走 kernel 的只读路径，不实例化 provider，也不解析凭据。

### 9.1 启动握手与退出

现有 Rust 等待 host.ready 后才报告就绪。反转父子关系后，需要先通过父子专用管道发送 `kernel.listening`（地址与本机连接认证信息），Host 才能连接并完成握手；最终应用就绪再通知 CLI/Web，避免彼此等待。

Host RPC 认证令牌和浏览器访问令牌仍属于本机通信凭据，与模型 API key 分开处理。连接握手应在注册 RPC handler 后报告 ready。

Node 负责转发取消和退出信号、等待 Rust 收尾；父子管道关闭时 Rust 取消活动 run、完成可完成的日志收尾并退出，避免 Host 崩溃留下孤儿进程。Rust 断开时 Node 取消全部 provider 请求并释放插件资源。首期由外部入口重启整个应用，从事实日志恢复；恢复不自动重发 Unknown 请求。更细的进程自动重启策略可独立实现。

### 9.2 凭据存储与设置界面

Node Credentials service 支持环境变量和显式本地凭据来源，可扩展系统 keychain。Provider 在 execute 前按引用解析 key，在 Node 内做鉴权。API key 不进入 CLI 参数、插件源码、Session fact、provider plan 和通用 settings 状态；网页保存请求可以通过 Rust RPC 转发到 Node。

Web 模型配置由默认内置插件提供，复用 `ctx.ui.page()`、Rust `invoke` 与 Node 公开 method。页面编辑供应商和模型配置，Node 凭据服务保存 key，普通配置列表只返回凭据是否已配置。用户点击密钥显示按钮时，插件通过独立的 `profiles.reveal` method 返回明文，供页面临时显示。保存和显示请求经 Rust 转发，不写入会话事实；Rust 不解释 Provider 配置或管理模型凭据。无需新增网关。

模型执行与事实记录的 RPC 数据、进度和 RPC 错误在 Node 发往 Rust 前脱敏。`client.invoke` 的成功返回值是临时界面数据，不做统一密钥字符串替换，以支持显式显示凭据；插件应按用途返回数据，普通配置查询仍不返回 key。日志和 SDK 调试输出也应避免包含凭据，不应把整个 fetch/SDK error 对象串行化；默认输出安全 code 和受控说明。Rust 无须持有 key 来做字符串替换。

标准集成可测试“模型执行路径不向 Rust 发送密钥”，并验证配置列表和 Session fact 不含 key；网页保存与显式显示凭据属于允许转发的配置操作。同用户进程读文件、第三方插件故意泄露凭据等问题需要额外 OS 级隔离；它们不由 Cordis 或一份接口声明解决。

## 10. 审计能力的变化必须显式表达

当前 Rust 同时认识协议并能验证 `reconstruct(request) == request.body`。协议移到任意插件后，Rust 无法独立证明“这个 provider 正确地把语义输入转换成了协议请求”。

新设计保存两份相互关联的数据：

- 内核可独立重建的统一输入：消息节点、临时消息、指令、工具和参数。
- Provider 提供的无凭据准备记录：实际业务 payload、adapter 版本和配置来源。

Rust 可以验证来源、版本、事实哈希和执行对象一致性；协议编码正确性由 provider 测试负责。标准 Host transport 直接发送冻结的 plan，并在测试中与本地假服务器收到的业务请求比较。对任意受信任插件，Rust 保存的是其执行声明，不能仅凭哈希证明远端实际收到的网络字节。

Inspector 应分别显示“统一输入”和“Provider 准备记录”，同时显示“语义来源已校验”和“协议转换由 provider 执行”。带 secret slots 的记录应显示认证部分省略，不能标成包含认证的完整 HTTP 抓包。

普通历史回放仅读取事实，既不加载旧插件也不请求凭据。需要验证编码确定性时，在开发测试中加载固定 adapter 版本重新执行 prepare 并比较；浏览历史不运行插件代码。

## 11. 协议与旧会话兼容

新方案涉及 Fact、PreparedRequest、ModelResult、Node、RPC 和 TypeScript 类型的公开变更，应按协议 v2 实施。不能只改结构后继续让旧日志以新版序列化方式验证哈希。

建议保留独立的 v1 解码、校验和只读投影代码。旧记录使用旧结构和原有哈希算法验证，再转换成统一的历史展示视图；旧 provider_body 仅留在这个隔离的历史兼容模块。

新建会话使用 v2。继续 v1 会话时，提供显式的复制迁移：保留原日志，为 v2 写入导入来源（原 session、最后 seq/hash）、消息节点、Surface、公开插件绑定和状态。未结束的 v1 操作先按 v1 规则收尾，不能导入成仍在执行的 v2 effect。历史请求保留原版本来源，不能重新标成 v2 plan。

迁移到临时文件后校验回放、同步落盘，再原子安装到新 session ID；原 session 不覆盖。以后需要一条时间线时由 UI 结合迁移来源展示。旧 SDK 插件的兼容 shim 属于 Node，能表达的旧行为继续兼容，无法兼容的版本在执行前报告。

## 12. 实施顺序与验收

按六个可评审阶段交付。前置阶段可以通过 fake provider 独立验证；最后一个阶段完成前不宣称切换结束。

| 阶段 | 主要改动 | 完成条件 |
| --- | --- | --- |
| 1. 中立数据契约与 v2 日志 | protocol/projection/store、生成类型、v1 兼容读取；加入 ModelRequested、plan 和完整 ModelResult | 新日志可回放；旧固定日志哈希校验和展示保持正确；准备失败有终态 |
| 2. Provider SDK 与统一执行管线 | SDK prepare/execute、Host 注册与实例固定、Rust model.call 分阶段、结构化错误、进度事件 | fake provider 贯通；写盘失败不执行；旧 epoch/重复请求/迟到结果被拒绝 |
| 3. Chat adapter 迁移 | Node 内置 provider、协议编码/SSE 测试、公开 profile、兼容 shim | 旧模型路径全部走插件；从活动 Rust 路径移除 HTTP/SSE、body 编码和参数白名单 |
| 4. Node 凭据与公开启动入口 | credentials service、Node launcher、Rust 私有入口、父子握手/退出、CLI 和打包 | 默认公开入口下，Rust 环境和 RPC 不含哨兵 key；CLI/Web/打包版均可启动 |
| 5. Responses adapter | 编码/解码、call_id、continuation、文本和 function tools、能力检查 | 完成“请求工具 → 工具结果 → 最终回答”；重启和压缩后 continuation 正确 |
| 6. UI、迁移与切换收尾 | Inspector、按请求的流状态、profile 设置、v1 复制迁移、浏览器及跨进程 eval、架构文档 | 全套门禁通过；新增第三种测试协议只增加 Node provider 与测试，无需修改活动 Rust 内核 |

阶段 3 的过渡测试使用 fake credential 或 Node 本地凭据来源；阶段 4 统一切换公共命令和打包入口。后续模型设置插件复用通用 RPC 转发保存请求，不让 Rust 管理 Provider 配置。

主要文件范围：

- Rust：[protocol.rs](../crates/kernel/src/protocol.rs)、[projection.rs](../crates/kernel/src/projection.rs)、[effects.rs](../crates/kernel/src/effects.rs)、[runtime.rs](../crates/kernel/src/runtime.rs)、[store.rs](../crates/kernel/src/store.rs)、[rpc.rs](../crates/kernel/src/rpc.rs)、[main.rs](../crates/kernel/src/main.rs)、[server.rs](../crates/kernel/src/server.rs)。
- Node：[SDK](../packages/sdk/src/index.ts)、[Host loader](../packages/host/src/loader.ts)、[Host entry](../packages/host/src/index.ts)、[Host RPC](../packages/host/src/rpc.ts)、[默认 driver](../packages/host/src/defaults.ts)；新增 provider 契约、内置 adapters、credentials 和 launcher 模块。
- UI：[Inspector.tsx](../packages/web/src/Inspector.tsx)、[useSession.ts](../packages/web/src/useSession.ts)、[Conversation.tsx](../packages/web/src/Conversation.tsx) 和模型设置；读取新协议字段和请求身份。
- 测试与交付：[eval](../tests/eval.mjs)、[fixtures](../tests/fixtures.mjs)、[helpers](../tests/helpers.mjs)、浏览器测试、[package smoke](../tests/package-smoke.mjs)、[build](../scripts/build.mjs)、[package](../scripts/package.mjs) 及工作流。

Provider 已作为独立模块纳入 Host bundle，接口复用 SDK；Rust reqwest 及其独占的依赖已移除。独立 package 分发可在需要时再拆分。

### 必须覆盖的回归场景

| 类别 | 验证点 |
| --- | --- |
| 准备与执行 | ModelRequested/RequestPrepared/EffectStarted 三个边界分别崩溃；准备失败；提交失败时远端调用计数为零 |
| 并发与生命周期 | 准备中取消、执行中取消、实例中途更新、旧 epoch 回调、重复 execute、终态竞态 |
| 重试 | SDK 隐式重试关闭；每次新尝试有 ID 和 retry_of；Unknown 恢复后网络调用计数不增加 |
| 结果一致性 | EffectSettled 后崩溃仍能恢复 Message 与 continuation；工具并行完成后按调用顺序入 Surface |
| Responses | call_id/item ID 区分、多个 output items、必要 reasoning items 回传、参数片段拼接、非正常终止 |
| 上下文 | 摘要通过同一 provider 管线；保留合法工具边界；压缩后被覆盖的原生片段不再入请求；provider 切换正确处理兼容性 |
| 无协议特判 | fake 第三协议的格式和参数在 provider 中定义，活动 Rust 不需要改代码 |
| 凭据 | 注入测试哨兵 key；检查 Rust 子进程环境、跨 RPC、JSONL、错误、stdout/stderr 和浏览器数据无哨兵；Node 假服务器确实收到认证 |
| 历史与显示 | 未安装 provider、缺少凭据也可看历史；摘要流不污染主回答；旧请求流不污染新 run |
| 迁移与启动 | v1 固定样本校验、复制迁移中断、父子进程分别退出、Windows 环境与打包入口 |

验收命令从 `vnext/` 执行：

```bash
cargo fmt --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --bin morrow-kernel
pnpm check:types
pnpm build
pnpm typecheck
pnpm test
pnpm eval
pnpm test:browser
```

实现阶段还应验证 release 打包和 package smoke，更新命令中的最终二进制名称。核心回归使用本地 fake servers 与测试凭据，真实 API smoke 单独运行。

本方案完成的判据是：一个新的文本/工具模型协议只需提供 Node adapter；Rust 能记录和恢复它的执行，无需管理其密钥或理解其线上请求格式。
