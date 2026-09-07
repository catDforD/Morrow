# Morrow vNext 设计与分析文档

这里维护新版 Agent 的架构说明、机制分析和后续设计决策。实现范围是 `vnext/`。

| 文档 | 用途 |
| --- | --- |
| [新版 Agent 架构导读](architecture.md) | 新入手时理解模块关系、一次执行、事实溯源、上下文和插件扩展 |
| [架构图源与图片](diagrams/) | Mermaid `.mmd` 图源及对应的 SVG 预览 |

后续文档按主题命名，例如 `context-management.md`、`plugin-lifecycle.md`。已实现的行为应给出源码入口；提案应明确标记为“设计提案”，记录解决的问题、取舍和落地状态。架构变化时同步更新导读与相应图源。

图表使用 Mermaid，文档嵌入 SVG，因此普通 Markdown 预览也可以显示。修改 `.mmd` 后重新生成同名 `.svg`。从 `vnext/` 执行单图生成示例：

```bash
pnpm dlx @mermaid-js/mermaid-cli@11.17.0 -i docs/diagrams/overview.mmd -o docs/diagrams/overview.svg -c docs/diagrams/mermaid.config.json -t neutral -b white
```

Mermaid CLI 需要可运行的 Chromium；使用已有浏览器时，可通过 `-p /path/to/puppeteer-config.json` 指定 `executablePath`。图表生成工具是文档维护工具，不是 Agent 的运行依赖。
