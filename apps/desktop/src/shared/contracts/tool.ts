/** 工具 Runtime（与 wire ToolRuntime 对齐；ModelExecutionLocation 是另一概念，勿混用） */
export type ToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 前端展示状态（doc 04 §4 单向前进；终态不重回执行态；wire tool.status 六态协议态映射见 spec D6A-05） */
export type ToolCallStatus =
  | 'requested' | 'awaiting_permission' | 'running'
  | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

/** 统一工具调用记录（权威键 id = sourceCallId = LLM tool_call_id，D6-03；实时易失 / 归档持久共型）。
 * toolVersion 有意不进记录（归档 wire 无版本源；批次 B tool.status 回传一致性由 Main 自 raw 缓存取值，D6-07）。 */
export interface ToolCallRecord {
  id: string
  toolName: string
  runtime: ToolRuntime
  status: ToolCallStatus
  desktopCallId?: string
  generationId?: string
  conversationId?: string
  reason?: string
  inputSummary?: string
  outputSummary?: string
  error?: { code?: string; message?: string }
  errorType?: string
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
  attachmentCount?: number          // 附件数（A10）
  /** F-7（批次 C）：工具事件照常携带的 diff（grant 命中自动执行路径）——终态不清，只读 Diff 卡数据源
   * （权限窗仍走 pendingDiff 侧信道） */
  diff?: PublicToolEvent['diff']
}

/** 差异行（diff 展示，D6B-11） */
export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }

/** 桌面工具公开事件（tool:event 载荷，D6B-09；无 arguments/paramHash/expiresAt/安全元数据，D6-07） */
export interface PublicToolEvent {
  id: string                        // sourceCallId（权威键）
  desktopCallId?: string            // 桥 callId
  conversationId?: string           // 归属会话（实时区会话隔离；未归属按兼容显示）
  toolName: string
  title: string                     // 注册表友好名（Renderer 无注册表）
  runtime: 'desktop'
  status: ToolCallStatus
  reason?: string
  inputSummary?: string             // 脱敏（redactToolArguments 产物）
  pathSummary?: string              // Main 派生路径展示摘要（仅权限窗/卡片；不进审计，H-1）
  resultSummary?: string
  error?: { code?: string; message?: string }
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
  attachmentCount?: number          // 卡片「含 N 个附件」数据源（A10）
  dataFlowNote?: string             // 注册表静态文案（「哪些数据发后端」）
  diff?: { lines: DiffLine[]; added: number; removed: number; truncated: boolean; totalLines: number; formatNote: string; isNewFile: boolean }   // totalLines（A-20/H2：接口与 schema/消费三方一致）
  captureSources?: Array<{ sourceId: string; sourceName: string; thumbnailDataUrl: string }>
  /** 预览（picked 态，doc 03 §10 / PRD §12.3：「截图需要显示所选屏幕或窗口」）。
   *  `sourceName` 是**必需**字段——它就是"所选屏/窗"的人类可读标识（枚举快照里已有，Main 直接带上）。
   *  width/height/bytes 为可选（mock 注入面没有真实缩略图，取不到尺寸）。 */
  capturePreview?: { sourceId: string; sourceName: string; previewDataUrl: string; width?: number; height?: number; bytes?: number }
  occurredAt: string
}

/** 工具结果附件引用（wire ToolAttachment 直映） */
export interface ToolAttachment {
  url: string
  mimeType: string
  label?: string
}

// —— 阶段 6 批次 C（D6C-03）：目录授权 grant（settings.tools.grants 持久化）——
/** 目录授权 grant：一次授权 = 用户在权限窗对「某目录 + 某工具」的持续同意（TTL 内不再逐次弹窗）。
 * 持久化于 settings.tools.grants（Main settings-service 经 SettingsStateSchema 装载/落盘）；
 * revokeSource/revokedAt 置位后保留（灰显历史），不再参与匹配。 */
export interface PermissionGrant {
  id: string                    // 'grant-' + crypto.randomUUID()（无状态跨重启唯一，不需持久化计数器）
  toolName: 'desktop.file.read' | 'desktop.file.write'
  scope: { directory: string }  // realpath 规范化目录（匹配基准）
  backendIdentity: string       // 授权时连接指纹 = new URL(serverUrl).origin（F-2：切换端点不再匹配）
  expiresAt: number             // epoch ms
  createdAt: string             // ISO
  source: 'directory'
  revokeSource?: 'user' | 'expired'
  revokedAt?: string            // 置位后不再匹配（灰显保留）
}
export interface ToolsSettings { grants: PermissionGrant[] }
/** TTL 白名单（1h/24h/7d/30d，校验权威 Main；schema union + tool-service 双校验，F-3/F-18） */
export const GRANT_TTL_OPTIONS_MS = [3600_000, 86_400_000, 604_800_000, 2_592_000_000] as const
export type GrantTtlMs = (typeof GRANT_TTL_OPTIONS_MS)[number]
/** 默认 24h（仅供 UI 默认选中；Main 不接受缺省 ttlMs） */
export const GRANT_DEFAULT_TTL_MS: GrantTtlMs = 86_400_000

/** 审批历史条目（D6C-08，Task 6 类型镜像）：audit JSONL `tool:*`/`grant:*` 事件回读形状——
 * IPC toolHistory 响应（Main tool-history.ts 组装，仅公开字段；无原文/Token/敏感路径）。 */
export interface HistoryEntry {
  ts: string
  type: string
  callId?: string
  toolId?: string
  status?: string
  permissionDecision?: string
  permissionGrantId?: string
  backendIdentity?: string
  riskLevel?: string
  cancelSource?: string
  errorCode?: string
  summary?: string
  toolName?: string   // 契约 F-5：AuditEvent 扩展后回读携带
}
