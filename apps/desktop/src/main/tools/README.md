# tools — Desktop 工具执行与本地授权（已实现）

阶段 6 已落地并真实联调：Tool Store 与注册表（`tool-registry.ts`）、四 P0 工具
（`desktop.file.select/read/write` + `desktop.screen.capture`）执行（`tool-executors.ts`）、
`callId` 幂等与终态单向（`tool-service.ts`）、本地风险重算与路径/域名黑名单
（`tool-policy.ts`）、目录授权（`grant-store.ts`）、审批历史（`tool-history.ts`）与审计（`tool-audit.ts`）。
设计权威见 doc 04 / doc 07；当前状态见 doc 16。

## 依赖方向（2026-09-17 架构整改 Prompt 1）

```text
tool-service ──┐                              ┌── tool-executors
               ▼                              ▼
        tool-execution-contract   +   tool-limits
```

- `tool-execution-contract.ts`：服务与执行器共享的稳定契约——`DesktopToolRequest`（传输层 → 应用服务
  的入站 DTO）、`ToolRecord`、`ToolServiceDeps`、`ExecResult`、`ToolExecError`、`ToolServiceError`。
  零**运行时** import（7 处模块引用全在类型面，编译期擦除），运行时产物只有两个错误类。
- `tool-limits.ts`：工具域**数值策略常量**（读写字节预算、选择器过滤面、结果/展示预算、会话 TTL、容量、IPC 水合预算）。
  真正的零依赖叶子：无 import、无函数、无状态。
- 两条纪律：`tool-executors.ts` **不得** import `tool-service.ts`；契约与常量模块**不得** import 二者任一。
  违反任一条都立刻恢复 runtime cycle（抽出前靠"只在函数体内使用"避开 TDZ，属执行时机掩盖，无编译期信号）。
  这两条由 `tests/unit/main-dependency-graph.spec.ts` 机械守卫（src/main 内**值导入**图不得有环），不是口头约定。

