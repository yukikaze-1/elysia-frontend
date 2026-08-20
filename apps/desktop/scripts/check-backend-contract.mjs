#!/usr/bin/env node
// apps/desktop/scripts/check-backend-contract.mjs
// 跨仓库契约检查:后端 contract.schema.json + 契约生成 JSONL ↔ 前端 RawFrameSchema。
// 语义(任务简报 T7 / spec §4.2.3 / 接口核验 F2):
//  - 后端目录缺失 → exit 0(CI/他人机器跳过,不硬依赖);
//  - 后端 frame type 提取优先 contract.schema.json 判别联合;退化用 ws_message.py `Literal["…"]`(pydantic 写法);
//  - 解析 type < 3 → exit 1(防静默 false pass);
//  - 比对限定当前 WS v2 帧子集(WS_V2_FRAME_TYPES 白名单 32 型);前端缺 → exit 1 + 列出;
//  - 字段级：后端生成的 ws-v2-*.jsonl 逐条 parseRawFrame，解析结果必须与输入深度相等（防 zod 静默 strip）;
//  - 从后端 JSON Schema 的字段定义构造 error/rejected ACK 关键可选字段探针。
//  - 未纳帧(capabilities/delta/message/token_usage/transcription/command/wake/service_mode_result 等)走 warn 白名单,不报错。
// 本脚本不进入 CI 主流程;手动或 `check:contract` 运行。

import { readFileSync, existsSync, readdirSync } from 'fs'
import { isDeepStrictEqual } from 'node:util'

const BACKEND_DIR = '/home/yomu/elysia-agent/frontend_contract'
const SCHEMA_JSON = `${BACKEND_DIR}/contract.schema.json` // 判别联合(如不存在退 ws_message.py Literal 提取)
const BACKEND_TRACES = '/home/yomu/elysia-agent/docs/archive/frontend-handoff-v2/traces'
const RAW_SCHEMAS = new URL('../src/main/transport/protocol-v2/raw-schemas.ts', import.meta.url)

// 当前 WS v2 帧子集白名单(server 帧):前端 parseRawFrame / RawFrameSchema 已覆盖的 32 型
const WS_V2_FRAME_TYPES = [
  'server_info', 'session', 'expression', 'user_message.ack', 'error',
  'generation.started', 'generation.segment.started', 'generation.delta',
  'generation.segment.completed', 'generation.completed', 'generation.failed',
  'state', 'typing', // FE-INT-P1-01:11 型 → 13 型,state/typing 兼容帧纳入字段级深比较
  'switch_model_result', 'set_tts_voice_result', // 阶段4 批次A:模型 Profile 激活/TTS 声音切换结果帧
  // 阶段4 批次B:三种语音(BE-060/061/062)+ TTS 播放控制(BE-063),13 型 → 28 型
  'voice.transcript', 'voice_session.started', 'voice_session.partial', 'voice_session.turn',
  'voice_session.ack', 'voice_session.ended', 'dictation.partial', 'dictation.final',
  'dictation.cancelled', 'audio_start', 'audio', 'audio_end', 'audio_cancelled',
  // 阶段6 批次A（F-6-02）：工具双轨帧 + 过渡期 action 兼容帧，28 型 → 32 型
  'tool.request', 'tool.started', 'tool.completed', 'action'
]
// 未纳帧(capabilities/delta/message/token_usage/transcription/command/wake/service_mode_result 等):前端有意滞后,只 warn 不报错(F2 白名单)

if (!existsSync(BACKEND_DIR)) { console.log('[check-contract] 后端仓库未挂载,跳过'); process.exit(0) }

/**
 * 从 contract.schema.json 判别联合取 type 字面量。
 * 后端模型里 discriminator.propertyName === 'type' 的 union 有 ServerMessage(服务端→前端帧)
 * 与 ClientMessage(前端→服务端帧);当前 WS v2 帧子集全部在 ServerMessage 内,故取与
 * WS_V2_FRAME_TYPES 交集最大的那个 union 的 mapping 键(避免把 client 帧计入 phase3+ 滞后数)。
 */
function extractFromJsonSchema(json) {
  const unions = []
  for (const model of Object.values(json?.models ?? {})) {
    if (model && model.discriminator && model.discriminator.propertyName === 'type' && model.discriminator.mapping) {
      unions.push(Object.keys(model.discriminator.mapping))
    }
  }
  if (unions.length === 0) return []
  unions.sort((a, b) => countWsV2(b) - countWsV2(a))
  return unions[0]
  function countWsV2(u) { return u.filter((t) => WS_V2_FRAME_TYPES.includes(t)).length }
}

let backendTypes = []
let backendSchema
if (existsSync(SCHEMA_JSON)) {
  backendSchema = JSON.parse(readFileSync(SCHEMA_JSON, 'utf8'))
  backendTypes = extractFromJsonSchema(backendSchema) // 从判别联合取 type 字面量
} else {
  // 退化:pydantic `Literal["…"]` 提取(接口核验 F2;`/['"]([a-z_]+)['"]\s*[=:]/` 提取不到,禁用)
  const src = readFileSync(`${BACKEND_DIR}/ws_message.py`, 'utf8')
  backendTypes = [...src.matchAll(/Literal\[["']([^"']+)["']\]/g)].map((m) => m[1])
}
if (backendTypes.length < 3) {
  console.error(`[check-contract] 后端 type 数 ${backendTypes.length} < 3,疑似模式失效`); process.exit(1)
}
backendTypes = [...new Set(backendTypes)] // 去重(退化路径 Literal 提取会重复 user_message.ack 等)

// 前端 RAW_FRAME_TYPES:raw-schemas.ts 中各帧 schema 的 `type: z.literal('…')`(判别字面量;
// 与 RawFrameSchema._def.options 推导出的 RAW_FRAME_TYPES 恒等;不含 channel/enum 等字段字面量)。
// 行注释里若出现同形文本会误匹配,故过滤匹配点之前同一行出现 `//` 的命中。
const frontSrc = readFileSync(RAW_SCHEMAS, 'utf8')
const frontTypes = [...frontSrc.matchAll(/type:\s*z\.literal\(\s*["']([^"']+)["']\s*\)/g)]
  .filter((m) => {
    const lineStart = frontSrc.lastIndexOf('\n', m.index - 1) + 1
    return !frontSrc.slice(lineStart, m.index).includes('//')
  })
  .map((m) => m[1])

const wsV2 = backendTypes.filter((t) => WS_V2_FRAME_TYPES.includes(t))
const missing = wsV2.filter((t) => !frontTypes.includes(t))
const deferred = backendTypes.filter((t) => !WS_V2_FRAME_TYPES.includes(t))
if (missing.length) { console.error(`[check-contract] 前端缺 WS v2 帧 type: ${missing.join(', ')}`); process.exit(1) }

const { parseRawFrame } = await import(RAW_SCHEMAS.href)
let checkedFrames = 0
const failures = []

function checkFrame(frame, label) {
  const parsed = parseRawFrame(frame)
  checkedFrames += 1
  if (!parsed.success) {
    failures.push(`${label}: 前端 raw schema 拒绝 ${JSON.stringify(parsed.error.issues)}`)
    return
  }
  if (!isDeepStrictEqual(parsed.data, frame)) {
    failures.push(`${label}: 解析后字段漂移/丢失 input=${JSON.stringify(frame)} parsed=${JSON.stringify(parsed.data)}`)
  }
}

// 后端契约源生成的确定性帧：覆盖主链路及 rejected error.details/retryAfterMs。
if (existsSync(BACKEND_TRACES)) {
  for (const name of readdirSync(BACKEND_TRACES)
    .filter((n) => /^ws-v2-.*\.jsonl$/.test(n) && !n.includes('-legacy-'))
    .sort()) {
    const lines = readFileSync(`${BACKEND_TRACES}/${name}`, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    for (const [index, line] of lines.entries()) {
      const frame = JSON.parse(line)
      if (WS_V2_FRAME_TYPES.includes(frame.type)) checkFrame(frame, `${name}:${index + 1}`)
    }
  }
}

// 生成帧未必穷举所有 optional 组合；只有后端 Schema 实际声明字段时才构造探针。
if (backendSchema) {
  const models = backendSchema.models ?? {}
  const errorProps = models.ErrorMessage?.properties ?? {}
  const errorProbe = { type: 'error', message: 'rate limited' }
  if ('code' in errorProps) errorProbe.code = 'RATE_LIMITED'
  if ('requestId' in errorProps) errorProbe.requestId = 'req-contract-probe'
  if ('clientRequestId' in errorProps) errorProbe.clientRequestId = 'client-contract-probe'
  if ('retryable' in errorProps) errorProbe.retryable = true
  if ('retryAfterMs' in errorProps) errorProbe.retryAfterMs = 1000
  if ('details' in errorProps) errorProbe.details = { scope: 'command' }
  checkFrame(errorProbe, 'schema-probe:ErrorMessage')

  const rejectedProps = models.RejectedUserAckMessage?.properties ?? {}
  const ackErrorProps = models.AckError?.properties ?? {}
  if (Object.keys(rejectedProps).length > 0) {
    const ackError = { code: 'CONTRACT_VALIDATION', message: 'missing clientRequestId', retryable: false }
    if ('retryAfterMs' in ackErrorProps) ackError.retryAfterMs = 1000
    if ('details' in ackErrorProps) ackError.details = { idempotency_durable: false }
    checkFrame({
      type: 'user_message.ack', messageId: '', clientRequestId: '',
      receivedAt: '2026-08-13T00:00:00Z', status: 'rejected', error: ackError
    }, 'schema-probe:RejectedUserAckMessage')
  }
}

if (checkedFrames === 0) failures.push('字段级检查未获得任何后端帧/探针，拒绝静默 false pass')
if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-contract] ${failure}`)
  process.exit(1)
}

console.log(`[check-contract] WS v2 type 覆盖: ${wsV2.length - missing.length}/${wsV2.length} 通过;` +
  `字段级帧 ${checkedFrames} 条完整保留;未纳帧 ${deferred.length} 个有意滞后(warn)`)

// ── REST 段：rest.py 目标模型 ↔ 前端 rest-schemas.ts（阶段3 联调前整改 spec §4.3.1；阶段4 批次A 增 providers/TTS 模型）——
// 字段名/必填性/role 枚举子集比对；防静默通过（模型数 < 目标数 或任一模型字段数=0 → exit 1）。
const REST_TARGET_MODELS = {
  SearchMessageItem: ['RestSearchMessageItemSchema'],
  SearchMessagesResponse: ['RestSearchMessagesResponseSchema'],
  MessageContextResponse: ['RestMessageContextResponseSchema'],
  AttachmentInfo: ['RestAttachmentUploadResponseSchema', 'shape', 'attachments', 'element'],
  AttachmentUploadResponse: ['RestAttachmentUploadResponseSchema'],
  AttachmentSignResponse: ['RestAttachmentSignResponseSchema'],
  StickerEntry: ['RestStickerItemSchema'],
  StickerListResponse: ['RestStickerListResponseSchema'],
  // 阶段4 批次A：providers（GET /api/providers）、providers/test（POST）、tts/voices（GET）、tts/preview（POST）
  ProviderEntry: ['ProviderEntryWireSchema'],
  CustomProvider: ['CustomProviderWireSchema'],
  ProvidersResponse: ['ProvidersResponseWireSchema'],
  ProviderTestResult: ['ProviderTestResultWireSchema'],
  TtsVoiceEntry: ['TtsVoiceEntryWireSchema'],
  TtsVoicesResponse: ['TtsVoicesResponseWireSchema'],
  TtsPreviewResult: ['TtsPreviewResultWireSchema'],
  // 阶段 6 批次 C（D6C-11，BE-043）：GET /api/tools/calls/{callId} 响应（复导出保证 mod['DesktopCallStatusSchema'] 命中 rest-schemas.ts，V-12）
  DesktopCallStatus: ['DesktopCallStatusSchema']
}
const REST_SCHEMAS = new URL('../src/main/transport/protocol-v2/rest-schemas.ts', import.meta.url)

/** REST 段主体（M2：rest.py 缺失时由外层守卫跳过，不抛 ENOENT） */
async function runRestSection() {
const restSrc = readFileSync(`${BACKEND_DIR}/rest.py`, 'utf8')

/** 按 ^class 边界切模型类体（含 docstring/字段行） */
function sliceClass(src, name) {
  const start = src.indexOf(`class ${name}(`)
  if (start === -1) return ''
  const bodyStart = src.indexOf('\n', start) + 1
  const next = src.indexOf('\nclass ', bodyStart)
  return next === -1 ? src.slice(bodyStart) : src.slice(bodyStart, next)
}
const FIELD_RE = /^\s{4}(\w+):\s*([^=#\n]+?)\s*(?:=([^\n]+))?$/gm

/** 解析模型字段 → { name, annotation, defaultText, required }
 * M1（已知限制）：按行匹配，多行 `Field(` 且注解非 `Optional[` 的字段会把下一行
 * default= 漏掉而误判必填；当前 8 目标模型仅 signedUrl 为多行且为 Optional[，无现成误报。
 */
function parseModelFields(cls) {
  const fields = []
  for (const m of cls.matchAll(FIELD_RE)) {
    if (m[1].startsWith('_')) continue
    const defaultText = (m[3] ?? '').trim()
    const fargs = /Field\((.*)\)/s.exec(defaultText)?.[1] ?? ''
    const required = !m[2].trim().startsWith('Optional[') &&
      !/\bdefault\s*=\s*None\b|\bdefault_factory\s*=|\bdefault\s*=\s*""/.test(fargs)
    fields.push({ name: m[1], annotation: m[2].trim(), required })
  }
  return fields
}

/** 前端 zod schema 字段键集合 */
function schemaKeys(schema) {
  const s = schema.shape ?? schema
  return new Set(Object.keys(s))
}

const { RestSearchMessageItemSchema } = await import(REST_SCHEMAS.href)
const restFailures = []
let restChecked = 0

for (const [modelName, path] of Object.entries(REST_TARGET_MODELS)) {
  const cls = sliceClass(restSrc, modelName)
  if (!cls) { restFailures.push(`REST 段：未找到后端模型 ${modelName}`); continue }
  const fields = parseModelFields(cls)
  if (fields.length === 0) { restFailures.push(`REST 段：${modelName} 字段解析为 0（正则失效？）`); continue }
  restChecked += 1
  // 前端 schema 定位：`['RestXxxSchema','shape','attachments','element']` 逐级下钻
  const mod = await import(REST_SCHEMAS.href)
  let schema = mod[path[0]]
  for (let i = 1; i < path.length; i++) schema = schema[path[i]]
  const front = schemaKeys(schema)
  const missing = fields.filter((f) => !front.has(f.name)).map((f) => f.name)
  if (missing.length) restFailures.push(`REST 段：${modelName} 前端缺后端字段 ${missing.join(', ')}`)
  // 必填性：后端必填字段必须存在于前端（前端可更宽松可选）
  const reqMissing = fields.filter((f) => f.required && !front.has(f.name)).map((f) => f.name)
  if (reqMissing.length) restFailures.push(`REST 段：${modelName} 前端缺必填字段 ${reqMissing.join(', ')}`)
}

// role 枚举子集：后端 Role（StrEnum 成员）⊆ 前端 search item role 枚举
const roleCls = sliceClass(restSrc, 'Role')
const roleEnumRe = /^\s{4}(\w+)\s*=\s*"([^"]+)"/gm
const backendRoles = [...roleCls.matchAll(roleEnumRe)].map((m) => m[2])
const searchRole = RestSearchMessageItemSchema.shape.role
const frontRoleInner = searchRole?._def?.innerType ?? searchRole
const frontRoles = frontRoleInner ? (frontRoleInner.options ?? Object.values(frontRoleInner._def?.entries ?? {})) : []
const roleOvershoot = backendRoles.filter((r) => !frontRoles.includes(r))
if (roleOvershoot.length) restFailures.push(`REST 段：role 枚举后端多出前端不识别 ${roleOvershoot.join(', ')}`)

// 防静默通过：解析模型数 < 目标模型数 或任一模型字段数 = 0（已在上层 loop 处理字段数=0）
if (restChecked < Object.keys(REST_TARGET_MODELS).length) {
  restFailures.push(`REST 段：仅解析 ${restChecked}/${Object.keys(REST_TARGET_MODELS).length} 模型，疑似正则失效`)
}

if (restFailures.length) {
  for (const f of restFailures) console.error(`[check-contract] ${f}`)
  process.exit(1)
}
console.log(`[check-contract] REST 段 ${restChecked}/${Object.keys(REST_TARGET_MODELS).length} 模型通过`)
}

if (existsSync(`${BACKEND_DIR}/rest.py`)) await runRestSection()
else console.log('[check-contract] 后端 rest.py 缺失，REST 段跳过')
