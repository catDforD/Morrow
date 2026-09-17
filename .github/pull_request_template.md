## 变更概述

-

## 架构决策

ADR：无 / `docs/adr/NNNN-...`（涉及模块职责、协议／存储格式、权限与信任边界、并发模型或依赖选型时必须新增或引用，见 `docs/adr/README.md`）

## 验证

- [ ] `cargo test --workspace --locked`
- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo run --locked -p agent-eval -- run`（新增/调整 eval 场景时一并提交基线变更）

## 备注

-
