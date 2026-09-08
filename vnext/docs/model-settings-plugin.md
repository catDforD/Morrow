# 模型设置：默认内置插件

模型配置管理位于 Node 和前端插件中。Rust 继续使用现有 `invoke` 转发，不增加模型配置格式、Provider 参数或凭据存储逻辑。

## 使用

运行 `morrow server` 后打开「设置 → 模型设置」。左侧仅有「自定义供应商」分组，添加或选择供应商后，右侧填写名称、Base URL、API 格式和 API Key，然后添加模型并保存。供应商可重命名、启用、禁用和删除；一个供应商下的多个模型共享地址和密钥。新安装不会自动创建 default、responses 或 Z.ai 供应商。显式传入命令行模型选项或 `OPENAI_*` 环境配置时，仍可加载对应的命令行连接；已有的自定义配置继续读取。

Base URL 只填写服务前缀，例如 `https://ark.cn-beijing.volces.com/api/coding/v3`。Chat Completions 适配器追加 `/chat/completions`，Responses 适配器追加 `/responses`；保留自定义前缀并统一处理尾部斜杠。旧 `endpoint` 若以 `/v1`、`/v3` 等版本目录结尾，读取时会识别为 Base URL，修复旧页面将服务前缀误存为完整地址的问题；其他旧完整地址保持兼容。旧单模型配置读取时转换为单模型供应商。编辑标准旧地址时页面会去掉协议后缀；非标准完整地址保持原样，直到用户修改地址或协议。

模型可配置 ID、显示名称、上下文窗口和视觉标记。这些能力标记属于模型元数据，不改变消息格式或现有压缩阈值。模型行提供编辑、删除、设为默认和连接检测。检测会向该模型发送一次简短请求并显示耗时，不写入会话历史。

配置在当前 home 内共享。聊天输入框通过插件提供两级模型菜单：先选择供应商，再选择其下的模型；桌面悬停或点击供应商打开子菜单，窄屏在同一弹层切换列表。菜单只列出已启用、包含模型且协议已加载的供应商，底部「管理模型」打开配置页。触发按钮显示当前模型名称，不再拼接「默认 · 供应商」。选择记录保存在 `morrow.settings.selection`，只包含供应商 ID 和模型 ID；新会话使用共享默认模型。供应商禁用或删除后，共享默认会回退到其他启用且包含模型的供应商；已经显式选择失效模型的会话需要重新选择，避免请求被悄悄发给其他账号。旧 `morrow.settings.model` 覆盖项和 `settings.get/set` 接口仍不再使用。

API Key 留空保留已有值。配置列表只返回 `configured` 状态；点击眼睛后才通过 `profiles.reveal` 临时读取密钥，隐藏或切换供应商时清空展示值。密钥显示、保存均走已有的受认证 UI RPC，不写入 Session fact。

网页修改立即用于后续模型请求。已经 prepare 的请求持有旧 plan、公开 profile 和凭据引用。连接与凭据写入各自的本地文件，单文件通过临时文件与 rename 替换；并发保存由服务串行处理。新凭据先写入，再安装引用它的配置，因此配置保存失败不会破坏旧连接。轮换产生的新凭据使用新引用，旧引用保留以供已准备的请求使用。

## 源码路线

| 源码 | 职责 |
| --- | --- |
| [SDK configuration.ts](../packages/sdk/src/configuration.ts) | `ProfileStore` 契约与 Cordis `ModelProfiles` 服务 |
| [provider-service.ts](../packages/host/src/provider-service.ts) | 本地持久化、凭据解析、公开配置、更新串行化 |
| [profile-config.ts](../packages/host/src/profile-config.ts) | 多模型供应商校验与旧配置兼容 |
| [Host 插件](../packages/host/src/builtins/model-settings.ts) | 配置、检测、选择方法与请求 policy |
| [Client 插件](../packages/web/src/builtins/model-settings.tsx) | 供应商及模型管理，通过 `ctx.ui.page()` 注册 |
| [模型选择器](../packages/web/src/builtins/model-picker.tsx) | 通过 `ctx.ui.composer()` 注册聊天输入框控件 |
| [Select 组件](../packages/web/src/Select.tsx) | 圆角下拉菜单、键盘选择和滚动定位，适配深浅主题 |
| [Client 宿主](../packages/web/src/plugins.tsx) | 默认加载内置插件，统一注册、卸载和渲染页面 |
| [设置外壳](../packages/web/src/Settings.tsx) | 合并页面导航、按顺序排列，使用 `PluginView` 渲染 |

内置插件清单位于 Host 和 Web 各自的 `src/builtins/index.ts`。页面与其他插件一样使用 Fiber 生命周期、公开 method 和插件身份。默认内置插件不需要用户先发送消息或手动加载；外部插件保留原来的信任与显式加载流程。

## 扩展接口

Host 插件可以注入配置服务：

```js
export default {
  inject: ['modelProfiles'],
  apply(ctx) {
    ctx.morrow.method('connections.list', () => ctx.modelProfiles.list())
    ctx.morrow.method('connections.save', input => ctx.modelProfiles.save(input))
  },
}
```

`save` 接收 `{ id, name?, provider, baseUrl?, enabled?, models?, model?, options, apiKey?, makeDefault? }`，旧的 `endpoint` 字段继续表示完整地址。`models` 中每项为 `{ id, name, contextWindow, vision }`，`model` 指定该供应商的默认模型。

`get(id)` 和 `list()` 返回公开配置，`list()` 另带 `configured` 状态。`reveal(id)` 用于明确要求读取密钥的 UI 操作；`test(id, model, adapter)` 执行一次诊断请求。公开方法失败时，内置插件返回 `{ error: string }`，前端显示具体原因。

`ctx.morrow.providerFormats()` 返回当前作用域可见的协议名及可选的配置说明。协议插件可通过 `Provider.configuration = { label, requestPath }` 提供下拉框文案，实际 URL 组装仍由各自的 `prepare()` 实现，Rust 不解释协议路径。

Client 插件继续使用已有页面入口，新增可选导航元数据：

```js
export default ctx => {
  ctx.ui.page('我的设置', SettingsComponent, {
    order: 30,
    // icon: React 元素；shortcut: 供其他 UI 入口查找此页面的名称。
  })
  ctx.ui.composer('快捷选择', PickerComponent, { order: 30 })
}
```

内置模型页使用 `order: 20`、`shortcut: 'models'`。输入框按顺序渲染 `composer` 扩展，向组件传入通用的 `disabled` 和 `openPage(name)`；模型选择器用它跳转到自己的设置页面。`page`、`panel`、`renderer` 和 `composer` 均随插件 Fiber 卸载。旧版两参数 `ctx.ui.page(name, Component)` 保持可用。

网页保存走 `Browser → Rust invoke → Node method → ProfileStore`。密钥在保存和明确显示时可以经过 Rust，但不进入 Session fact 或模型 plan。Node 的 `client.invoke` 成功回复是临时 UI 数据，允许返回用户明确请求的配置值；错误、模型 RPC 和 fact 写入继续脱敏。连接与密钥保存在 Node 管理的本地文件中。
