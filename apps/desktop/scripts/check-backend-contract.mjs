#!/usr/bin/env node
// apps/desktop/scripts/check-backend-contract.mjs
// 跨仓库契约检查:后端 contract.schema.json + 契约生成 JSONL ↔ 前端 RawFrameSchema。
// 语义(任务简报 T7 / spec §4.2.3 / 接口核验 F2):
//  - 后端目录缺失 → exit 0(CI/他人机器跳过,不硬依赖);
//  - 后端 frame type 提取优先 contract.schema.json 判别联合;退化用 ws_message.py `Literal["…"]`(pydantic 写法);
//  - 解析 type < 3 → exit 1(防静默 false pass);
//  - 比对限定当前 WS v2 帧子集(WS_V2_FRAME_TYPES 白名单 11 型);前端缺 → exit 1 + 列出;
//  - 字段级：后端生成的 ws-v2-*.jsonl 逐条 parseRawFrame，解析结果必须与输入深度相等（防 zod 静默 strip）;
//  - 从后端 JSON Schema 的字段定义构造 error/rejected ACK 关键可选字段探针。
//  - phase 3+ 帧(voice_session/dictation/tool.request 等)走 warn 白名单,不报错。
// 本脚本不进入 CI 主流程;手动或 `check:contract` 运行。

import { readFileSync, existsSync, readdirSync } from 'fs'
import { isDeepStrictEqual } from 'node:util'

const BACKEND_DIR = '/home/yomu/elysia-agent/frontend_contract'
const SCHEMA_JSON = `${BACKEND_DIR}/contract.schema.json` // 判别联合(如不存在退 ws_message.py Literal 提取)
const BACKEND_TRACES = '/home/yomu/elysia-agent/docs/archive/frontend-handoff-v2/traces'
const RAW_SCHEMAS = new URL('../src/main/transport/protocol-v2/raw-schemas.ts', import.meta.url)

// 当前 WS v2 帧子集白名单(server 帧):前端 parseRawFrame / RawFrameSchema 已覆盖的 11 型
const WS_V2_FRAME_TYPES = [
  'server_info', 'session', 'expression', 'user_message.ack', 'error',
  'generation.started', 'generation.segment.started', 'generation.delta',
  'generation.segment.completed', 'generation.completed', 'generation.failed'
]
// phase 3+ 帧(voice_session/dictation/tool.request 等):前端有意滞后,只 warn 不报错(F2 白名单)

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
  `字段级帧 ${checkedFrames} 条完整保留;phase3+ 帧 ${deferred.length} 个有意滞后(warn)`)
