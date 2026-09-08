# Morrow vNext

Rust 事实内核 + Node 24 / Cordis 插件宿主 + React / Cordis 客户端。
这是独立的 Rust 与 pnpm workspace，入口为 `morrow`，数据目录为
`~/.morrow-vnext/`，不读取旧版根工程的会话或配置。源码安装时会将已有 `morrow` 命令保留为 `morrow-legacy`。

初次阅读建议从[新版 Agent 架构导读](docs/architecture.md)开始：包含整体架构图、执行时序、事实与上下文管理，以及 Host / Web 插件的扩展边界。后续设计分析统一维护在 [docs/](docs/README.md)。

## 启动

```bash
cd vnext
pnpm install --frozen-lockfile
pnpm cli:install

# 在想让 Agent 操作的项目目录启动。
cd ..
morrow server
```

`pnpm cli:install` 编译应用并安装命令到 `~/.local/bin`，只需安装一次。现有命令会备份，不覆盖备份；若该目录不在 PATH，安装器会提示。入口指向当前工作副本，后续重新构建后即可使用，移动仓库后重新安装入口。

直接输入 `morrow` 也会启动服务；默认工作区是当前目录，端口为 `3001`。第一次进入页面后配置 Provider、API key 和模型即可，不要求先设置环境变量。

```bash
morrow server --port 3002                    # 更换端口
morrow server --workspace /path/to/project  # 指定工作区
morrow --session work run "介绍这个项目"      # 命令行运行
```

不安装全局命令时，可以在 `vnext/` 运行 `pnpm start --workspace ..`。`serve` 作为 `server` 的兼容别名继续可用。

浏览器使用终端输出的地址打开。地址片段中的临时令牌只用于当前本机进程，
进入页面后会移入 sessionStorage。Host 使用独立令牌连接本机 WebSocket。
API key 由 Node provider 管理，Rust 不配置模型凭据。网页保存密钥时通过现有 Rust RPC 转发给 Node，密钥不写入会话事实；Node 仍以环境变量白名单启动 Rust。

`--home /tmp/morrow-next-demo` 可以隔离演示数据。`--approve-all` 显式批准当前
进程的所有 SDK 工具操作；默认情况下文件写入和 shell 都需要逐次批准。
CLI 支持 Ctrl-C，Web 支持取消与审批。

可以在不同项目目录运行 `morrow server`；同时启动时使用不同端口。各项目的会话分别存放在 `~/.morrow-vnext/sessions/<工作区路径哈希>/`，允许同名会话，侧栏只列出当前项目的会话。旧平铺会话仍在所属项目中读取，供应商和密钥配置继续共享。浏览器也按工作区分别记住最近使用的会话。

Web 沿用原版 Morrow 的侧栏、首页、聊天输入框、主题和设置布局。侧栏新建或
搜索会话；右上角「查看执行详情」打开事实时间线并重建模型请求，「查看会话面板」
加载插件面板；「设置 → 插件」审阅、信任和启用插件，插件页面也出现在设置导航中。
聊天历史从完整事实日志还原，上下文压缩不会隐藏之前的对话。侧栏归档是当前浏览器
按工作区保存的展示偏好，不移动或删除事实日志。

`packages/web/src/styles.css` 和独立展示组件从 `crates/agent-server/web/src/` 移植，
保留原版视觉设计；`useSession.ts` 接入新 API，`style.css` 只补充事实和插件区域的样式。
设置目前提供外观、模型连接和插件管理；旧版 MCP、Hooks 等配置页还未接入新 API。

## Provider 与凭据

内置 provider 为 `openai-chat` 和 `openai-responses`。源码安装与发布包都通过 `morrow` 启动 Node launcher（Windows 为 `morrow.cmd`）；发布包同时保留 `morrow-next` 兼容入口。

可以直接运行 `morrow server`，在 **设置 → 模型设置** 的「自定义供应商」中添加供应商，填写 Base URL、API 格式、API Key，再添加一个或多个模型。新安装不预填供应商。Base URL 只需填写到 `/v1` 或服务自己的前缀（如 `/api/coding/v3`），适配器自动追加 `/chat/completions` 或 `/responses`。保存后可在聊天输入框按「供应商 → 模型」选择，菜单底部的「管理模型」打开配置页；模型行可设为默认、编辑、删除和测试连接。供应商支持启用、禁用和重命名。

网页保存立即生效，无需重启，已准备的请求保留原配置。API Key 留空保留原密钥，点击眼睛才临时显示已保存的值。旧完整 `endpoint` 配置继续兼容。

“模型设置”由默认加载的 `morrow.settings` 插件通过 `ctx.ui.page()` 注册，模型选择器通过 `ctx.ui.composer()` 加入输入框。其他插件可声明 `inject: ['modelProfiles']`，使用 `ctx.modelProfiles.get/list/save/remove` 管理连接；存储和凭据处理由 Node 宿主提供。完整源码与扩展示例见 [配置插件导读](docs/model-settings-plugin.md)。

```bash
# 使用已保存的 profile；work 对应下方配置的供应商 ID。
node packages/host/dist/launcher.js --profile work run "介绍这个项目"

# 保存本地凭据，值通过 stdin 输入；profiles 中引用 local:work。
node packages/host/dist/launcher.js credential set work < /path/to/key-file
```

`--home` 目录下的 `providers.json` 配置连接，不包含密钥值：

```json
{
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "provider": "openai-responses",
      "name": "Work",
      "enabled": true,
      "model": "MODEL_ID",
      "baseUrl": "https://api.openai.com/v1",
      "models": [{ "id": "MODEL_ID", "name": "Work model", "contextWindow": 128000, "vision": false }],
      "credentialRef": "env:OPENAI_API_KEY",
      "options": { "store": false }
    }
  }
}
```

凭据引用支持 `env:NAME`、`local:NAME` 和 `file:/absolute/path`。本地凭据位于 `credentials.json`，不要提交到仓库。页面只显示凭据配置状态，不回传已有密钥。手动编辑配置文件后需重启；网页编辑不需要。

Provider 的 `prepare(input, profile)` 只生成可保存的无凭据 plan；`execute(plan, context)` 使用 `context.credential()` 和 `context.signal` 发起请求，通过 `context.emit()` 报告临时进度。结果同时保存 Message 与 continuation。新增协议无须修改 Rust；示例测试见 `tests/provider.test.mjs`，完整边界见 [provider-isolation.md](docs/provider-isolation.md)。

## v1 会话迁移

旧 vNext v1 日志以只读方式校验和展示。继续执行前复制到新的 v2 会话，原文件保留：

```bash
node packages/host/dist/launcher.js --session old session migrate upgraded
node packages/host/dist/launcher.js --session upgraded run "继续"

# 工作区日志迁入独立的 workspace-v2 文件，旧 workspace 文件保留。
node packages/host/dist/launcher.js --session _workspace session migrate _workspace
```

历史请求仍通过原会话查看。迁移后的会话保留消息节点、当前 Surface 和插件状态，导入事实记录源会话的 seq/hash。

## 代码导航

| 路径 | 职责 |
| --- | --- |
| `crates/kernel/src/protocol.rs` | Fact、消息、注册快照、不可变 PreparedRequest |
| `crates/kernel/src/projection.rs` | live/replay 共用的增量 reducer、Surface 校验、请求重建 |
| `crates/kernel/src/store.rs` | JSONL 校验链、文件锁、持久化确认、断尾隔离、中断恢复 |
| `crates/kernel/src/runtime.rs` | 输入队列、单会话串行运行、审批、插件版本、子会话 |
| `crates/kernel/src/effects.rs` | provider 准备/执行边界、文件/shell 工具与审批 |
| `crates/kernel/src/rpc.rs` | 可重入的双向 JSON-RPC，回调不占用接收循环 |
| `packages/sdk/src/index.ts` | Cordis service、作用域注册、RunContext、状态与上下文 API |
| `packages/sdk/src/mcp.ts` | MCP stdio / Streamable HTTP 与工具注册插件 |
| `packages/host/src/loader.ts` | Host 生命周期、作用域、不可变版本恢复、注册失效检查 |
| `packages/host/src/defaults.ts` | 默认 driver、prompt、压缩、设置和子任务工具 |
| `packages/host/src/launcher.ts` | Node 入口、干净环境启动 kernel、CLI 与退出处理 |
| `packages/host/src/provider-service.ts` | Profile、凭据、固定准备结果、执行去重与流式回传 |
| `packages/host/src/providers.ts` | Chat Completions / Responses 编码、HTTP 和 SSE |
| `packages/sdk/src/provider.ts` | provider 的 prepare / execute 契约 |
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
与 Node provider 的无凭据 plan。时间线可重建统一输入并查看 plan；协议编码由 provider 测试验证。

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

其他扩展点：`ctx.morrow.provider(name, { capabilities, prepare, execute })`、`driver('default', { run })`、
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
node packages/host/dist/launcher.js --session work plugin define /tmp/plugin.json
node packages/host/dist/launcher.js --session work plugin trust HASH
node packages/host/dist/launcher.js --session work plugin activate HASH
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
cargo build --bin morrow-kernel
pnpm check:types
pnpm build
pnpm typecheck
pnpm test
pnpm eval
pnpm exec playwright install chromium
pnpm test:browser

cargo build --release --bin morrow-kernel
node scripts/package.mjs
```

`tests/fixtures.mjs` 的确定性 provider 驱动实际默认 agent，包含模型定义“项目文件统计
工具 + Web 面板”、信任/激活、状态恢复、压缩、错误、取消和 Host 崩溃。
浏览器测试运行同一真实服务。`examples/project-stats.*.mjs` 是完整双端插件样例。

打包输出包含 Rust、当前 Node 24、Host/SDK/Cordis bundle、Web 资源与许可证。
`.github/workflows/vnext-package.yml` 提供 Linux/macOS x64/arm64 和 Windows x64
构建；只生成产物，不发布或切换现有默认入口。当前阶段优先完成可运行的垂直链路，
旧实现的全部设置页、工具能力和平台发布验证仍需要在正式切换前逐项对齐。
