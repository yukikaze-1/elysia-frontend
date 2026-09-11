// src/renderer/src/utils/error-message.ts
//
// 错误文案映射（多套 UI 基础，2026-09-10）。
//
// 背景（审计实测）：功能层（stores/）里散落着约 46 条**用户可见中文文案**，直接写在
// `PublicError.message` 里（如 `{ code: 'CHARACTER_REQUIRED', message: '请先选择一个角色再新建会话' }`）。
// 这使「换 UI 风格」「加多语言」必须逐个改功能层文件——功能层被迫承担了本属表现层的措辞决策。
//
// 本模块把「错误码 → 用户可读文案」收成**单一来源**：
//   · 功能层只产出 code（+ backendCode/retryable 等语义字段），不再决定措辞；
//   · UI 层一律经 errorMessage() 取文案渲染。
//
// 与既有 character-error.ts 的关系：后者是本模块的前身（只覆盖角色域，且默认分支直接回显
// store 文案）。现统一到此，character-error.ts 退化为薄转发以保持既有调用点与测试不变。
//
// 回退链（顺序不可调换）：
//   ① 按 backendCode 映射（后端语义比本地包装更精确）
//   ② 按 code 映射（本地/包装码）
//   ③ error.message —— 来自 Main 的**已公开**错误原文（parsePublicError 产出），必须保留显示，
//      否则跨进程错误会变成空白。注意：这是「外部系统给的可显示文本」，不是本地 UI 文案。
//   ④ fallback —— 调用方给的兜底句（通常是操作语境，如「保存失败，请稍后重试。」）
import type { PublicError } from './public-error'

/**
 * 错误码 → 文案。**单一合并表**：`code` 与 `backendCode` 的值域不冲突（后端码全大写下划线，
 * 本地码为语义名），合并后不存在歧义，且省掉了「两张表要保持同步」的漂移风险。
 *
 * 刻意**不**收录的通用包装码：
 *   · `BACKEND_REJECTED` / `UNKNOWN` —— 它们是「没有更具体信息」的占位码，真正的说明在后端返回的
 *     已公开 message 里。给它们编一句泛化文案会**盖住**后端说明（实测回归：把「后端返回的可公开说明」
 *     改写成了「后端拒绝了本次操作。」），故让它们走回退链 ③。
 */
const ERROR_TEXT: Record<string, string> = {
  // —— 角色域（后端码形态；也可能作为本地 code 出现，同一句） ——
  CHARACTER_NOT_FOUND: '角色已不存在，请返回目录刷新。',
  CHARACTER_IMMUTABLE: '内置角色不可修改，请先克隆为自定义角色。',
  CHARACTER_ARCHIVED: '该角色已归档，不能继续编辑或用于新会话。',
  CHARACTER_REVISION_CONFLICT: '角色版本已更新。请重新加载最新版本，或选择另存为新角色。',
  CHARACTER_STATE_CONFLICT: '角色版本已更新。请重新加载最新版本，或选择另存为新角色。',
  CHARACTER_STORAGE_UNAVAILABLE: '本地草稿存储暂时不可用；请稍后重试。',
  STORAGE_UNAVAILABLE: '本地草稿存储暂时不可用；请稍后重试。',
  CHARACTER_PREVIEW_FAILED: '临时预览失败，请检查连接或稍后重试。',
  CHARACTER_MUTATION_IN_PROGRESS: '角色正在处理中，请等待当前操作完成。',
  CHARACTER_BUSY: '角色正在处理中，请等待当前操作完成。',
  CHARACTER_OFFLINE: '当前未连接；远端角色操作不可用，但仍可保存本地草稿。',
  CHARACTER_VALIDATION: '角色校验未通过，请按下方问题修正后再保存。',
  CHARACTER_PROFILES_UNAVAILABLE: '角色档案能力尚未启用；连接后端后重试。',
  // —— 会话域（本地码；文案原写死在 conversation.store，2026-09-10 收拢至此） ——
  CHARACTER_REQUIRED: '请先选择一个角色再新建会话。',
  IDENTITY_REQUIRED: '请先完成「我的档案」初始化，再新建角色会话。',
  OFFLINE_VIEW: '离线视图下请使用本地缓存会话。',
  OFFLINE_NOT_CACHED: '该会话离线不可读。',
  // —— 消息/生成域 ——
  CHARACTER_GENERATION_PROTOCOL_MISMATCH: '回复身份校验失败，已停止本次生成。',
  MESSAGE_PROTOCOL_MISMATCH: '消息所属会话或角色身份校验失败，请重试。',
  // H-10：静默看门狗到期（后端在窗口内一个事件都没发）。文案必须说清「已停止等待」而不是
  // 「发送失败」——用户的消息实际已发出，重发前应知道这一点。
  GENERATION_STALLED: '回复长时间没有进展，已停止等待。可以重新发送。',
  // —— 角色草稿/持久化域 ——
  CHARACTER_DRAFT_STORAGE_UNAVAILABLE: '本地草稿存储暂时不可用；请稍后重试。',
  SCHEMA_VALIDATION_FAILED: '数据格式无效；请刷新后重试。',
  // —— 身份域 ——
  IDENTITY_SAVE_STALE: '档案已被更新，较旧的保存结果已丢弃。',
}

/**
 * 错误码 → 用户可读文案。
 *
 * @param error 已公开错误（`parsePublicError` 或本地构造）
 * @param fallback 无映射且无原文时的兜底句——应描述**操作语境**（如「保存失败，请稍后重试。」），
 *                 而不是复述错误本身。调用方必须提供，避免界面出现空白错误提示。
 */
export function errorMessage(error: PublicError | undefined, fallback: string): string {
  if (!error) return fallback
  // ① backendCode 优先：通用包装码（BACKEND_REJECTED）之下的具体后端原因更精确
  const byBackend = error.backendCode ? ERROR_TEXT[error.backendCode] : undefined
  if (byBackend) return byBackend
  // ② 本地/语义码
  const byCode = ERROR_TEXT[error.code]
  if (byCode) return byCode
  // ③ 来自 Main 的已公开原文：必须显示（跨进程错误没有本地映射，丢弃会变成空白）
  //
  // 注意：**不能**用 `backendCode` 是否存在来判断「来源」——实测后端经
  // `getCharacterState` 抛出的错误不带 backendCode，而渲染层本地构造的错误反而带；
  // 该字段的语义取决于构造点，不是可靠判据（曾据此收紧本档，导致后端可公开说明被吞成兜底句）。
  // 「本地技术细节不得直显」这一诉求由调用点各自的脱敏层负责（如角色公开状态卡片的
  // FORBIDDEN_ERROR_CONTENT）。
  return error.message || fallback
}
