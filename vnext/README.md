# Morrow vNext

Rust 事实内核 + Node 24 / Cordis 插件宿主 + React / Cordis 客户端。
这是独立的 Rust 与 pnpm workspace，入口为 `morrow-next`，数据目录为
`~/.morrow-vnext/`。现有 `morrow` 入口继续运行旧实现；这里不读取旧会话或配置。

初次阅读建议从[新版 Agent 架构导读](docs/architecture.md)开始：包含整体架构图、执行时序、事实与上下文管理，以及 Host / Web 插件的扩展边界。后续设计分析统一维护在 [docs/](docs/README.md)。

## 启动

```bash
cd vnext
pnpm install --frozen-lockfile
pnpm build
cargo build --bin morrow-next

# 从环境获取 OPENAI_API_KEY；可选 OPENAI_BASE_URL、OPENAI_MODEL。
cargo run --bin morrow-next -- --workspace .. --session work run "介绍这个项目"
cargo run --bin morrow-next -- --workspace .. serve --port 3001
```

浏览器使用终端输出的地址打开。地址片段中的临时令牌只用于当前本机进程，
进入页面后会移入 sessionStorage。Host 使用独立令牌连接本机 WebSocket。
API key 只留在 Rust 进程，模型请求事实不含 Authorization 头。

`--home /tmp/morrow-next-demo` 可以隔离演示数据。`--approve-all` 显式批准当前
进程的所有 SDK 工具操作；默认情况下文件写入和 shell 都需要逐次批准。
CLI 支持 Ctrl-C，Web 支持取消与审批。

Web 沿用原版 Morrow 的侧栏、首页、聊天输入框、主题和设置布局。侧栏新建或
搜索会话；右上角「查看执行详情」打开事实时间线并重建模型请求，「查看会话面板」
加载插件面板；「设置 → 插件」审阅、信任和启用插件，插件页面也出现在设置导航中。
聊天历史从完整事实日志还原，上下文压缩不会隐藏之前的对话。侧栏归档是当前浏览器
按工作区保存的展示偏好，不移动或删除事实日志。

`packages/web/src/styles.css` 和独立展示组件从 `crates/agent-server/web/src/` 移植，
保留原版视觉设计；`useSession.ts` 接入新 API，`style.css` 只补充事实和插件区域的样式。
设置目前提供外观、会话模型和插件管理；旧版 MCP、Hooks 等配置页还未接入新 API。

## 代码导航

| 路径 | 职责 |
| --- | --- |
| `crates/kernel/src/protocol.rs` | Fact、消息、注册快照、不可变 PreparedRequest |
| `crates/kernel/src/projection.rs` | live/replay 共用的增量 reducer、Surface 校验、请求重建 |
| `crates/kernel/src/store.rs` | JSONL 校验链、文件锁、持久化确认、断尾隔离、中断恢复 |
| `crates/kernel/src/runtime.rs` | 输入队列、单会话串行运行、审批、插件版本、子会话 |
| `crates/kernel/src/effects.rs` | 模型 SSE、文件/shell 工具、权限与 effect 边界 |
| `crates/kernel/src/rpc.rs` | 可重入的双向 JSON-RPC，回调不占用接收循环 |
| `packages/sdk/src/index.ts` | Cordis service、作用域注册、RunContext、状态与上下文 API |
| `packages/sdk/src/mcp.ts` | MCP stdio / Streamable HTTP 与工具注册插件 |
| `packages/host/src/loader.ts` | Host 生命周期、作用域、不可变版本恢复、注册失效检查 |
| `packages/host/src/defaults.ts` | 默认 driver、prompt、压缩、设置和子任务工具 |
| `packages/web/src/plugins.tsx` | Client Fiber、页面/面板/消息 renderer、错误边界 |
| `tests/eval.mjs` | 启动真实 Rust/Node 的确定性回归 |

`packages/sdk/src/protocol.ts` 由 Rust 类型生成；修改协议后运行 `pnpm types`。
`pnpm check:types` 检测生成文件漂移。

## 事实与执行

每条语义事实先完成 `write_all + sync_data`，再更新投影并向调用者确认。
写入失败会封闭当前 writer。模型和工具必须先提交准备/开始事实，再执行外部操作。
流式文本只是临时通知；结算后的消息才进入持久化上下文。

Surface 保存消息节点 ID。压缩以连续区间替换当前引用，旧节点不删除；
`covers` 记录传递覆盖关系，`source_request` 关联摘要请求。工具调用与结果不可被
切开。准备模型请求时，Rust 保存当前 Surface、临时消息、最终 header、注册版本
与实际 provider body。时间线可重新生成并比较这份请求。

一个 Session 同时执行一个 run；重复 submission ID 不会重复执行。不同 Session
可以并行。工具可并行执行，但结果按模型发出调用的顺序进入 Surface。
失败或取消保留已提交消息。进程恢复会补齐未关闭的模型/工具边界：尚未开始的工具
明确记录未开始；已开始却没有结果的 effect 标记 `unknown`，不会自动重放。
完整行发生协议/校验损坏时拒绝加载；未换行的尾部先隔离到 `.torn-*` 再恢复。

## 插件开发与信任

Host 插件导出 Cordis 的函数、类或 `{ apply }`。可使用 Cordis 的 `inject`、
`provide`、事件和 `ctx.effect()`。以静态 `provide` 声明服务名，loader 才能在
workspace / session 层建立正确的 DI 隔离。

```ts
export default function (ctx) {
  ctx.morrow.tool({
    name: 'example', description: 'Read project notes',
    parameters: { type: 'object', properties: {} }, approval: false,
  }, async (_args, run) => {
    const result = await run.tool('read_file', { path: 'README.md' })
    await run.setState('last', result)
    return result
  })
  ctx.morrow.method('example.get', (_args, run) => run.state('last'))
}
```

其他扩展点：`ctx.morrow.model(name, handler)`、`driver('default', { run })`、
`policy(name, (run, preparation, next) => …)`。Driver 可以自行选择步骤、模型、工具、
上下文追加/替换和停止条件；Rust 继续负责事实、权限和持久化。

注册按 application → workspace → session 查找，最近层覆盖同名祖先贡献。
同层重复注册报错，兄弟 Session 隔离。每步固定工具、provider 和 policy 快照；
工具内部请求激活会立即获得 pending receipt，在下一步使用新注册。
Driver 固定到 run 结束，其所属插件的替换/卸载延后到该边界。

插件版本由 Host/Client 源码和依赖锁共同计算 SHA-256。运行时不执行 npm install。
需要依赖的插件应先在开发环境中构建：

```bash
node scripts/plugin.mjs example.plugin host.ts client.ts pnpm-lock.yaml > /tmp/plugin.json
cargo run --bin morrow-next -- --session work plugin define /tmp/plugin.json
cargo run --bin morrow-next -- --session work plugin trust HASH
cargo run --bin morrow-next -- --session work plugin activate HASH
```

修改后重新构建/define 会产生新 hash，必须信任该版本。`plugin stop HASH` 停用；
`plugin activate HASH` 恢复同一版本。工作区安装通过 Web 中的“安装到工作区”完成。
模型只能 define 和激活已经信任的版本，无法通过 Host RPC 信任新版本。

默认信任范围是当前 Session。`run.state/setState/deleteState` 使用插件自己的
namespace，变更以通用事实保存；恢复状态不需要执行旧插件代码。
查看历史不启动 Host 插件。执行输入或明确 `resume` 才加载对应版本；
浏览器也要明确加载面板或执行输入。缺失版本阻止执行，历史仍可查看。

Client 插件通过 `ctx.ui.panel/page/renderer` 注册 React 组件；共享 React 在
`ctx.ui.react`，也支持 `import … from 'react'`。组件接收 `{ state, invoke, message }`，
`invoke` 只能调用本 Session / 当前版本注册的公开 Host method。渲染失败显示局部
错误，不撤销已完成的 Host 工作。Host 和 Client 的 Fiber 独立释放。

插件是用户信任的本机代码，拥有 Node/browser 自身能力。SDK 权限管线用于协作、
审批与审计；它不是针对恶意已信任插件的进程隔离沙箱。

## MCP 与子任务

```ts
import { mcp } from '@morrow/sdk'
export default async ctx => {
  await ctx.plugin(mcp, { name: 'docs', command: 'my-mcp-server', args: [] })
  // 或 { name: 'docs', url: 'http://127.0.0.1:4000/mcp' }
}
```

工具名为 `docs__工具名`，只有 MCP `readOnlyHint: true` 自动放行，其他调用进入
Rust 审批。客户端支持初始化、分页 tools/list、tools/call、取消和关闭；
服务端主动 sampling、elicitation 和 OAuth 配置界面不在当前实现内。

`run.subagent(prompt)` 创建独立子 Session，继承可信版本与初始插件状态。
父会话保存子会话引用，子任务消息不混入父 Surface，父取消向子任务传播。
最大嵌套深度为 3。默认 driver 将此能力注册为 `subagent` 工具。

## 验证与打包

```bash
cargo fmt --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --bin morrow-next
pnpm check:types
pnpm build
pnpm typecheck
pnpm test
pnpm eval
pnpm exec playwright install chromium
pnpm test:browser

cargo build --release --bin morrow-next
node scripts/package.mjs
```

`tests/fixtures.mjs` 的确定性 provider 驱动实际默认 agent，包含模型定义“项目文件统计
工具 + Web 面板”、信任/激活、状态恢复、压缩、错误、取消和 Host 崩溃。
浏览器测试运行同一真实服务。`examples/project-stats.*.mjs` 是完整双端插件样例。

打包输出包含 Rust、当前 Node 24、Host/SDK/Cordis bundle、Web 资源与许可证。
`.github/workflows/vnext-package.yml` 提供 Linux/macOS x64/arm64 和 Windows x64
构建；只生成产物，不发布或切换现有默认入口。当前阶段优先完成可运行的垂直链路，
旧实现的全部设置页、工具能力和平台发布验证仍需要在正式切换前逐项对齐。
