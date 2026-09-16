// src/main/tools/tool-limits.ts
// Desktop 工具**数值策略**的唯一定义点（执行/展示/IPC 三类上限 + 文件选择过滤面）。
//
// 为什么单独一个模块（2026-09-17 架构整改 Prompt 1）：
// 这些常量此前定义在 `tool-service.ts`，其中 5 个（`FILE_READ_MAX_BYTES` / `MAX_WRITE_CONTENT_BYTES` /
// `RESULT_INLINE_BYTES` / `TEXT_FILE_FILTERS` / `THUMBNAIL_DATA_URL_MAX`）被 `tool-executors.ts` 使用
// ⇒ 执行器为了读常量反向 import 服务实现，与服务 forward import 执行器形成 runtime cycle。
//
// 如实说明归属：**只有上述 5 个是两侧共用的**，去掉它们即可解环；其余 7 个（diff 输入上限、selected-set
// 豁免 TTL、路径摘要长度、预览上限、capture 停留 TTL、records 容量、IPC 水合预算）当前只有 `tool-service.ts`
// 一个读者。它们一并放在这里**不是因为解环需要**，而是因为它们是同一类东西——工具域的数值策略参数：
// 集中一处才有一个可审计的数值来源，也才不会下次再有人为了读一个上限去 import 服务实现。
//
// 为什么这是一个叶子模块：零 import、零状态、无函数，可被服务与执行器同时依赖而不引入任何边。
//
// 语义分组（引用点的真实含义，不是"数字分类"）：
//   · 读/写字节预算 —— 决策链（授权前预读）与执行器（真正读写）**必须同口径**，改一处即改两处；
//   · 选择器过滤面 —— 原生选择器呈现给用户的候选类型（select 执行器）；
//   · 结果与展示预算 —— 内联截断、路径摘要、缩略图/预览 data URL 上限（IPC 体积与 UI 可读性）；
//   · 会话与容量 —— capture 子状态机停留态 TTL 与 records 容量；
//   · IPC 水合预算 —— `tool:list` 出参受全局 4 MiB 不变量约束的分配额。
//
// 纪律：本文件只放**常量**。判定逻辑（风险重算、黑名单）在 `tool-policy.ts`，契约类型在
// `tool-execution-contract.ts`；不要在此新增函数或可变状态。

/** 单个文本文件读取上限（select 的同步哈希、read、write 覆盖前预读共用同一口径） */
export const FILE_READ_MAX_BYTES = 2 * 1024 * 1024
/** read 结果内联进 output 的上限；超过则改走附件上传 */
export const RESULT_INLINE_BYTES = 64 * 1024
/** desktop.file.write 待写内容上限（决策链 step 7 与执行器写盘前双校验） */
export const MAX_WRITE_CONTENT_BYTES = 2 * 1024 * 1024
/**
 * H-09（2026-09-11）：diff **预览**的输入上限（区别于写入上限）。
 *
 * 理由不是「防冻结」（实测 2 MiB 仅 ~26 ms，见 preReadForDiff 注释），而是**不做白工**：
 * diff 的唯一用途是一段最多 100 行的给人看的预览（MAX_DIFF_LINES），而 `computeTextDiff` 内部的
 * 同步 Myers 会在截断检查**之前**把全文按行分配——为 100 行预览去 diff 数百 KB 至 2 MiB 并不划算。
 * 超过本阈值只省略 lines/added/removed，安全字段（isNewFile / oldHash / formatNote）照常产出，写入行为不变。
 */
export const MAX_DIFF_INPUT_BYTES = 256 * 1024
/** desktop.file.select 的 selected-set 豁免时长（此后同路径重新走确认） */
export const SELECT_EXEMPT_TTL_MS = 10 * 60 * 1000
/** 原生文件选择器的候选类型过滤（desktop.file.select 唯一使用点） */
export const TEXT_FILE_FILTERS = { name: '文本文件', extensions: ['txt','md','markdown','json','log','csv','tsv','js','ts','jsx','tsx','py','rb','go','rs','c','h','cpp','hpp','java','kt','swift','css','scss','html','htm','yaml','yml','toml','ini','cfg','conf','xml','svg','sh','bash','env'] }
/** 审批卡片展示用的路径摘要长度上限（不泄露完整路径给 Renderer） */
export const PATH_SUMMARY_MAX = 120
/** 缩略图 data URL 上限（A-18/L-5/B5；超出丢弃并提示 dropped） */
export const THUMBNAIL_DATA_URL_MAX = 64 * 1024
/** 全尺寸预览 data URL 上限（A-18/L-5；超限降级为缩略图） */
export const PREVIEW_DATA_URL_MAX = 256 * 1024
/** capture 子状态机停留态超时（M1：awaiting_pick/picked 无执行超时兜底——Renderer 不响应时记录不得永久停留 running） */
export const CAPTURE_SESSION_TTL_MS = 120_000
/** L-1（D6C-09a）：records 容量上限（超出逐最旧终态；awaiting/running 永不逐出） */
export const MAX_RECORDS = 200
/**
 * `listRecent` 纳入**审批上下文**（diff / captureSources / capturePreview）的字节预算（2026-09-16 审计 P2）。
 *
 * 为什么需要预算：`tool:list` 的出参受全局不变量 ≤ `MAX_IPC_MESSAGE_BYTES`（4 MiB，doc 07 §6.3）约束，
 * 而单张全尺寸截图预览 ≤ `PREVIEW_DATA_URL_MAX`（256 KiB）、单个源缩略图 ≤ `THUMBNAIL_DATA_URL_MAX`（64 KiB）
 * ⇒ 20 条上限下最坏可达 20 × 约 320 KiB ≈ 6.4 MiB，会越界。逐条无脑附带等于把"出参不超 4 MiB"变成
 * 一句做不到的声明，故这里按字节先到先得：`listRecent` 已把非终态排在前（它们才是需要审批上下文的记录），
 * 预算耗尽者退回"无上下文"，与修复前行为一致（不静默截断字段，而是整块不带）。
 */
export const HYDRATION_CONTEXT_BUDGET_BYTES = 2 * 1024 * 1024
