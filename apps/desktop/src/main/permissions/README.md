# permissions — 桌面工具授权（本目录无代码）

桌面工具授权、审批流、路径/域名黑名单与决策优先级均实现在 `src/main/tools/`（如 `grant-store.ts`、`tool-policy.ts`）；设计权威见 doc 04/07。

**2026-09-16 更正（对照代码逐字复核，审计报告 P2）：** 上面原写的优先级链「prohibited → 黑名单 → **强制确认** → 有效授权 → 沙箱默认 → 用户提示」与实现**不符**，两点：

1. **不存在「强制确认」这一层。** 实现是 **grant 覆盖 prompt**（`tool-service.ts` 的决策链）：命中的有效授权直接放行并写审计 `tool:decision allow_scoped`。`tool-registry.ts` 的 `permissionMode='always_prompt'` **全仓零读者**——这是**已留档的产品决策反转**（doc 04 有记录），**不要按字面把它恢复**。
2. **沙箱目录层是空操作。** `computeLocalRisk` 的 `sandboxRoots`/`platform` 是死形参、函数体从不读取，`isPathWithinSandbox` 生产**零调用**，`sandboxDirectories` 也从未注入装配根。今天配置恒为空集故无行为差异，但**将来任何非空配置都会静默失效**——不要把它当安全层读。详见 doc 04 §7.4 注记③。

