# 历史归档索引（阶段 0～2 与首轮联调整改）

> 本文件由 `pnpm docs:index` 根据目录内容生成；不要手工维护条目。
> 归档条件：**该批次已有 final report 接管结论**，且其设计/计划已被后续阶段与现行代码完全吸收。
> 归档不等于失效：这些文件仍是契约与决策的唯一原始记录，可被引用；只是不再作为当前实现的必读入口。
> 阶段 3 及之后没有 final report，其 spec/plan 仍是主要技术记录，因此留在 [superpowers 索引](../superpowers/README.md)。
> 当前项目状态以 [doc 16](../16-Cyrene-前端实施任务清单与进度跟踪.md) 为准。

共 42 份归档文档。按内容归属分布如下（表格按日期倒序，阶段信息以标题为准）：

| 归属 | 文档数 | 对应文件名前缀 |
|---|---:|---|
| 阶段 1 安全骨架（地基 + 块 A/B/C） | 8 | `2026-08-08-phase1-foundation`、`2026-08-09-phase1-*` |
| 阶段 2 核心聊天闭环（块 A/B/C + realconn A/B/C） | 16 | `2026-08-1{0,1,2}-phase2-*` |
| 阶段 0/1 整改（复核批次 A～D） | 12 | `2026-08-12-phase01-recheck-*` |
| 首次/二次真实联调整改 | 6 | `2026-08-13-realint*-fix` |

> 阶段 0 没有独立 spec/plan：其协议与工程基线由 `phase1-foundation` 一并建立，实质性阶段 0 整改见 `phase01-recheck-batchD`。

## Final reports（10）

| 日期 | 文档 |
|---|---|
| 2026-08-13 | [2026-08-13-realint2-fix-final-report](./reports/2026-08-13-realint2-fix-final-report.md) |
| 2026-08-13 | [2026-08-13-realint-fix-final-report](./reports/2026-08-13-realint-fix-final-report.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchC-final-report](./reports/2026-08-12-phase2-realconn-batchC-final-report.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchB-final-report](./reports/2026-08-12-phase2-realconn-batchB-final-report.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchD-final-report](./reports/2026-08-12-phase01-recheck-batchD-final-report.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchC-final-report](./reports/2026-08-12-phase01-recheck-batchC-final-report.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchB-final-report](./reports/2026-08-12-phase01-recheck-batchB-final-report.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchA-final-report](./reports/2026-08-12-phase01-recheck-batchA-final-report.md) |
| 2026-08-11 | [2026-08-11-phase2-realconn-batchA-final-report](./reports/2026-08-11-phase2-realconn-batchA-final-report.md) |
| 2026-08-11 | [2026-08-11-phase2-batch-final-report](./reports/2026-08-11-phase2-batch-final-report.md) |

## Specs（16）

| 日期 | 文档 |
|---|---|
| 2026-08-13 | [2026-08-13-realint2-fix-design](./specs/2026-08-13-realint2-fix-design.md) |
| 2026-08-13 | [2026-08-13-realint-fix-design](./specs/2026-08-13-realint-fix-design.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchC-design](./specs/2026-08-12-phase2-realconn-batchC-design.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchB-design](./specs/2026-08-12-phase2-realconn-batchB-design.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchD-design](./specs/2026-08-12-phase01-recheck-batchD-design.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchC-design](./specs/2026-08-12-phase01-recheck-batchC-design.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchB-design](./specs/2026-08-12-phase01-recheck-batchB-design.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchA-design](./specs/2026-08-12-phase01-recheck-batchA-design.md) |
| 2026-08-11 | [2026-08-11-phase2-store-ui-design](./specs/2026-08-11-phase2-store-ui-design.md) |
| 2026-08-11 | [2026-08-11-phase2-realconn-preparation-design](./specs/2026-08-11-phase2-realconn-preparation-design.md) |
| 2026-08-11 | [2026-08-11-phase2-real-backend-design](./specs/2026-08-11-phase2-real-backend-design.md) |
| 2026-08-10 | [2026-08-10-phase2-contract-raw-wire-design](./specs/2026-08-10-phase2-contract-raw-wire-design.md) |
| 2026-08-09 | [2026-08-09-phase1-trusted-services-design](./specs/2026-08-09-phase1-trusted-services-design.md) |
| 2026-08-09 | [2026-08-09-phase1-loading-env-design](./specs/2026-08-09-phase1-loading-env-design.md) |
| 2026-08-09 | [2026-08-09-phase1-ipc-security-integration-design](./specs/2026-08-09-phase1-ipc-security-integration-design.md) |
| 2026-08-08 | [2026-08-08-phase1-foundation-design](./specs/2026-08-08-phase1-foundation-design.md) |

## Plans（16）

| 日期 | 文档 |
|---|---|
| 2026-08-13 | [2026-08-13-realint2-fix](./plans/2026-08-13-realint2-fix.md) |
| 2026-08-13 | [2026-08-13-realint-fix](./plans/2026-08-13-realint-fix.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchC](./plans/2026-08-12-phase2-realconn-batchC.md) |
| 2026-08-12 | [2026-08-12-phase2-realconn-batchB](./plans/2026-08-12-phase2-realconn-batchB.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchD](./plans/2026-08-12-phase01-recheck-batchD.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchC](./plans/2026-08-12-phase01-recheck-batchC.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchB](./plans/2026-08-12-phase01-recheck-batchB.md) |
| 2026-08-12 | [2026-08-12-phase01-recheck-batchA](./plans/2026-08-12-phase01-recheck-batchA.md) |
| 2026-08-11 | [2026-08-11-phase2-store-ui](./plans/2026-08-11-phase2-store-ui.md) |
| 2026-08-11 | [2026-08-11-phase2-realconn-preparation](./plans/2026-08-11-phase2-realconn-preparation.md) |
| 2026-08-11 | [2026-08-11-phase2-real-backend](./plans/2026-08-11-phase2-real-backend.md) |
| 2026-08-10 | [2026-08-10-phase2-contract-raw-wire](./plans/2026-08-10-phase2-contract-raw-wire.md) |
| 2026-08-09 | [2026-08-09-phase1-trusted-services](./plans/2026-08-09-phase1-trusted-services.md) |
| 2026-08-09 | [2026-08-09-phase1-loading-env](./plans/2026-08-09-phase1-loading-env.md) |
| 2026-08-09 | [2026-08-09-phase1-ipc-security-integration](./plans/2026-08-09-phase1-ipc-security-integration.md) |
| 2026-08-08 | [2026-08-08-phase1-foundation](./plans/2026-08-08-phase1-foundation.md) |
