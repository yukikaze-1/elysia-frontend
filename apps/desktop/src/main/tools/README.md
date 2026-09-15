# tools — Desktop 工具执行与本地授权（已实现）

阶段 6 已落地并真实联调：Tool Store 与注册表（`tool-registry.ts`）、四 P0 工具
（`desktop.file.select/read/write` + `desktop.screen.capture`）执行（`tool-executors.ts`）、
`callId` 幂等与终态单向（`tool-service.ts`）、本地风险重算与路径/域名黑名单
（`tool-policy.ts`）、目录授权（`grant-store.ts`）、审批历史（`tool-history.ts`）与审计（`tool-audit.ts`）。
设计权威见 doc 04 / doc 07；当前状态见 doc 16。
