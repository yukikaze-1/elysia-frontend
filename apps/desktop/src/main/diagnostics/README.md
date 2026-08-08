# diagnostics — 日志/审计与脱敏（占位）

阶段 1 填充：`sanitize.ts`（sanitizePublicMessage 公开消息路径脱敏，handlers 接线）。后续块填充：logger/audit 落盘——仅经 sanitize 后的公开信息可出主进程，敏感数据永不落盘、永不进诊断导出。
