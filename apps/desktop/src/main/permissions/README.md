# permissions — 桌面工具授权（本目录无代码）

桌面工具授权、审批流、路径/域名黑名单与决策优先级（prohibited → 黑名单 → 强制确认 → 有效授权 → 沙箱默认 → 用户提示）均实现在 `src/main/tools/`（如 `grant-store.ts`、`tool-policy.ts`）；设计权威见 doc 04/07。
