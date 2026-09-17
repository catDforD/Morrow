# 项目状态

> 更新：2026-09-17 · 代码核对基线：`4278812` · 本页是状态快照，不是完整路线图。
> [架构地图](ARCHITECTURE.md) · [决策记录](docs/adr/README.md)

## 现在在哪里

**当前形态：本地 coding agent，提供 CLI / REPL 与浏览器仪表盘。** 已有模型／工具循环、审批与取消、Session fact log、上下文压缩、MCP、Hook、临时委派和 Web 持久子代理。

- 当前工作：整理架构与状态入口，引入轻量 ADR；本轮不改变运行时行为。
- 下一项产品开发目标：尚未选定，不将历史提案视为已承诺计划。
- 建议优先项：修复下面的测试录制器不稳定问题，再选择一个小型用户场景验证闭环。

## 最近验证

以下命令于 2026-09-17 在上述代码基线上执行：

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `cargo test --workspace` | 首次 1 项失败；该单测及全量复跑均通过，仍有不稳定信号 |
| `cargo run -p agent-eval -- run` | 17/17 通过 |
| Web 前端检查、真实模型端到端任务 | 本轮未运行 |

## 已知问题与边界

- **测试不稳定，未修复**：`turn_started_fact_records_the_effective_system_prompt` 首次报 `EOF while parsing a string`。断言在 [runtime tests.rs](crates/agent-runtime/src/tests.rs) 的请求体解析处失败；共用录制器 `spawn_recording_sse_server` 仅调用一次 socket read，存在截断请求的可能。复跑通过不等于问题消失。
- **产品边界**：当前不提供桌面端或远程运行时；持久子代理控制面仅 Web；审批不是 OS 沙箱，取消不保证回滚已发生的副作用。
- **验证边界**：确定性 eval 验证执行规则，不衡量真实模型完成开发任务的成功率；本页不是完整缺陷审计。

## 更新规则

每个工作项收尾时，只更新当前工作、验证日期／基线和仍未解决的问题。具体任务放 issue／PR，设计理由放 ADR；每次只保留一个主要开发目标。
