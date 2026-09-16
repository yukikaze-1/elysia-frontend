// src/main/tools/tool-execution-contract.ts
// Desktop 工具**执行契约**：ToolService 与 ToolExecutors 共享的稳定类型与结构化错误。
//
// 为什么单独一个模块（2026-09-17 架构整改 Prompt 1）：
// 抽出前 `tool-service.ts` 与 `tool-executors.ts` 互相 import——服务为了调用执行器（值：
// `createExecutors`），执行器为了取 `ToolRecord`/`ToolServiceDeps` 与 5 个执行上限常量反向
// import 服务实现，形成 runtime cycle（`tool-service ↔ tool-executors`，强连通分量大小 2；
// `grant-store` 原先值 import 服务的 `ToolServiceError`，那是**扇入**、本身不成环，本轮一并改指本模块）。
// 当时靠"只在函数体内使用"避开 TDZ，属**执行时机掩盖**，没有编译期信号。现在把两侧共同依赖的部分下沉到
// 本模块，依赖方向收敛为：
//
//     tool-service ──┐                        ┌── tool-executors
//                    ▼                        ▼
//            tool-execution-contract   +   tool-limits
//
// 本文件**不得** import `tool-service.ts` 或 `tool-executors.ts`（否则新环立刻回来）。
// 运行时形状：本文件**零运行时 import**——7 处模块引用全部是**类型面**（6 处 `import type` 语句 + 1 处行内
// `import('./grant-store').GrantStore`），编译期擦除；唯二的运行时产物是 `ToolServiceError` / `ToolExecError`
// 两个 class 声明。即"引入本模块"不会牵入任何其它模块的求值。
//
// 归属判据（本轮只提升"真正稳定的契约"，不扩大公共 API 面）：
//   · `DesktopToolRequest` —— 传输层（real/mock adapter）→ 应用服务的入站 DTO，两侧共用的**稳定契约**；
//   · `ToolRecord` / `ToolServiceDeps` —— 服务与执行器共用的执行态/注入面；
//   · `ExecResult` / `ToolExecError` —— 执行器的出参形状与结构化失败；
//   · `ToolServiceError` —— 工具域结构化错误，此前在 `tool-service.ts` 里，但 `grant-store` 也抛它、
//     IPC 层也映射它 ⇒ 它是域的公共错误契约，不是某个实现的私有结构。
// 仅服务于服务实现的私有结构（`ToolService` 接口本身、records/队列状态机等）**继续留在** tool-service.ts。
import type { AuditEvent } from '../diagnostics/audit'
import type { RegisteredTool } from './tool-registry'
import type { FileIdentity } from './file-identity'
import type { RiskLevel } from './tool-policy'
import type { PublicToolEvent, ToolAttachment, ToolCallStatus } from '@shared/contracts/tool'
import type { DesktopCallStatus, ToolStatusCommand } from '@shared/contracts/backend'

/**
 * 桌面工具请求（传输层从 wire 提炼 / mock 直接构造 → `ToolService.handleRequest`）。
 *
 * 原始 `arguments` 只在 Main 内流转（D6-07：公开事件不带原始参数）；`reportedRiskLevel` 等后端上报
 * 风险元数据只进本地重算与审计，不改变本地授权判定（判定权威在本地注册表）。
 */
export interface DesktopToolRequest {
  callId: string; sourceCallId: string; toolName: string; toolVersion: string
  runtime: 'desktop'; arguments: Record<string, unknown>
  reason?: string; expiresAt: number; paramHash?: string
  conversationId?: string   // 归属会话（real-backend 从 activeConversationId 注入；mock 从 activeConversationId 注入）
  // —— D4-1（2026-09-15 裁决「补代码」）：wire 侧风险元数据入参（此前被丢弃）——
  /** 后端 `tool.request.riskLevel` 上报值（原始 unknown；非枚举值在重算中按 high 处理） */
  reportedRiskLevel?: unknown
  /** 后端 `permissionRequired`（仅审计记录，不改变本地授权判定——判定权威在本地注册表） */
  permissionRequired?: boolean
  /** 后端 `approvalAuthority`（同上：仅审计记录） */
  approvalAuthority?: string
}
export interface FilePickerOptions { title: string; filters: { name: string; extensions: string[] }[] }
export interface CaptureSourceInfo { sourceId: string; sourceName: string; thumbnailDataUrl: string }
/** 工具执行器出参：`output` 过工具 outputSchema；`captureSession` 表示 capture 枚举完成，子状态机接管（A-2） */
export interface ExecResult { output: Record<string, unknown>; summary: string; attachments?: ToolAttachment[]; attachmentCount?: number; captureSession?: boolean }
/** 工具域结构化错误（IPC 层映射为结构化拒绝） */
export class ToolServiceError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
/** 执行器结构化错误（`code` 决定 wire error.code；`ABORTED` 为内部放弃信号，绝不外泄成用户可见错误码） */
export class ToolExecError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
/**
 * 工具执行与编排的注入面（`createToolService` / `createExecutors` 共用）。
 *
 * 命名沿用 `ToolServiceDeps`（生产装配 `main/index.ts` 与各 spec 的既有口径），本轮只搬位置不改形状。
 */
export interface ToolServiceDeps {
  registry: Map<string, RegisteredTool>
  platform: 'posix' | 'windows'
  audit: (ev: AuditEvent) => void
  pickFile?: (opts: FilePickerOptions) => Promise<{ canceled: boolean; path?: string }>
  enumerateSources?: () => Promise<CaptureSourceInfo[]>
  renderPreview?: (sourceId: string) => Promise<{ previewDataUrl: string; bytes: Uint8Array; width?: number; height?: number }>   // capture picked 后（Task 4，A-2；width/height 可选——mock 注入面没有真实缩略图）
  finalizeUpload?: (callId: string, bytes: Uint8Array) => Promise<void>                          // 上传前钩子（Task 4）
  submitStatus: (cmd: ToolStatusCommand) => Promise<void>
  uploadAttachment: (callId: string, bytes: Uint8Array, mime: string, label?: string) => Promise<ToolAttachment>
  pushEvent: (ev: PublicToolEvent) => void
  selectedExemptTtlMs?: number
  allowRoots?: string[]
  /** D4-15（2026-09-15 裁决「补代码」）：生效的沙盒（预授权）目录集——realpath 规范化目录。
   *  F-06 拍板值仍为**空集**（零预授权），故缺省不改变任何授权结果；提供该注入面是为了让重算的
   *  「沙盒内受控」分支有唯一入口，避免将来逐处 `startsWith` 复制包含性判定。 */
  sandboxDirectories?: string[]
  isWayland?: boolean               // 注入（测试用）；缺省 isWaylandSession() env 判定（A-4）
  executorOverride?: (rec: ToolRecord, realPath?: string, signal?: AbortSignal) => Promise<ExecResult>   // 测试注入（B-1/M12）；signal 供"永不 settle 的执行"用例（A1）
  selectedAdd?: (realPath: string) => void   // selected-set 写闭包（A-14：tool-service 注入；executor 可选调用）
  // —— 批次 C（D6C-04/05）：目录授权 ——
  grants?: import('./grant-store').GrantStore      // 批次 C（D6C-04）：grant 仓库（缺省 → 无 grant 面）
  pickDirectory?: (opts: { title: string }) => Promise<{ canceled: boolean; path?: string }>   // D6C-05 创建流注入
  backendIdentity?: () => string | undefined       // F-2：当前连接指纹（grant 创建时绑定；index.ts 懒绑定闭包）
  queryStatus?: (callId: string) => Promise<DesktopCallStatus | null>   // 批次 C（D6C-11，本 task 首次加入）：GET tools/calls 查询（注入才查；mock 不注入 → 不查，F-20）
}
/** 单条工具调用的执行态记录（服务持有；执行器只读消费） */
export interface ToolRecord {
  id: string; desktopCallId?: string; conversationId?: string; toolName: string; title: string
  status: ToolCallStatus; reason?: string; inputSummary?: string; pathSummary?: string
  resultSummary?: string; error?: { code?: string; message?: string }; truncated?: boolean
  durationMs?: number; startedAt?: string; finishedAt?: string; attachmentCount?: number
  dataFlowNote?: string; diff?: PublicToolEvent['diff']; oldHash?: string           // oldHash=写前哈希依据（A-1/M7）
  captureSources?: PublicToolEvent['captureSources']; capturePreview?: PublicToolEvent['capturePreview']
  expiresAt: number; paramHash?: string; arguments_: Record<string, unknown>; toolVersion: string
  statusSent: boolean; realPath?: string        // L1：决策链 step 5 normalize 缓存（executor/串行锁读取）
  /** 2026-09-16 审计 P2（TOCTOU）：授权时刻该 realPath 的文件身份（dev+ino）；执行前复核，防批准后被换链。
   *  仅在授权时该路径**确为一个普通文件**时才有值（见 file-identity.ts 的四态说明）。 */
  fileIdentity?: FileIdentity
  /** D4-1：本地风险重算产物（决策链 step 8 前写入；审计 riskLevel 的唯一来源，不再直接读注册表常量） */
  riskLevel?: RiskLevel
  attachments?: ToolAttachment[]                // M2：完成时缓存（重连重发复用 URL，D6B-11）
}
