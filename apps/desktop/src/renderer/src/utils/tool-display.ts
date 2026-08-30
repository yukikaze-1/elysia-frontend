// 工具卡展示层格式化纯函数（UII-QQ 工具卡二轮收尾）：
// - 不执行输出内容（无 v-html/eval——JSON.parse 只产数据）、不修改 ToolCallRecord 原始值；
// - 摘要/详情只做展示转换；复制永远使用原始 outputSummary（组件层负责）。
import type { ToolCallRecord, ToolCallStatus } from '@shared/contracts/tool'

const SUMMARY_PARSE_CAP = 64_000   // outputSummary 契约 ≤2000 字符；防御性上限避免病态大串解析

export function isPlainSummaryObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 安全尝试 JSON.parse：非 {/[ 开头、解析失败、超长、非对象/数组 → null（不抛异常） */
export function parseStructuredSummary(text: string | undefined): Record<string, unknown> | unknown[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > SUMMARY_PARSE_CAP) return null
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    const v: unknown = JSON.parse(t)
    if (typeof v !== 'object' || v === null) return null
    return v as Record<string, unknown> | unknown[]
  } catch {
    return null
  }
}

/** 普通文本压单行（折叠摘要用）：连续空白折叠 + 超长截断（CSS ellipsis 同时兜底） */
export function singleLineText(text: string, cap = 200): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > cap ? `${s.slice(0, cap)}…` : s
}

function fmt1(n: number): string {
  const s = n.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** 字节数易读格式：B/KB/MB/GB（一位小数去尾 0；非法输入返回 ''） */
export function formatByteSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${Math.round(size)} B`
  const kb = size / 1024
  if (kb < 1024) return `${fmt1(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${fmt1(mb)} MB`
  return `${fmt1(mb / 1024)} GB`
}

/** charset 易读形式：utf-8 → UTF-8 / utf8 → UTF-8 / gbk → GBK（已知编码表内大写化；未知原样返回） */
export function formatCharset(cs: string): string {
  const lower = cs.trim().toLowerCase()
  if (lower === '') return ''
  if (lower === 'utf8') return 'UTF-8'
  const known = ['utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'gbk', 'gb2312', 'gb18030', 'big5', 'ascii', 'iso-8859-1', 'shift_jis', 'euc-kr']
  return known.includes(lower) ? lower.toUpperCase() : cs.trim()
}

/** 从 path 安全提取文件名（兼容 / 与 \ 分隔；空段过滤；无段返回 undefined） */
export function fileNameFromPath(path: string): string | undefined {
  return path.split(/[\\/]+/).filter((p) => p !== '').pop()
}

/** 文件读取结果易读摘要：已读取 <name> · <size> · <charset> · 内容已截断（字段缺省逐段省略，不显示 undefined） */
export function readFileBrief(v: Record<string, unknown>): string {
  const name = typeof v['name'] === 'string' && v['name'] !== ''
    ? v['name']
    : typeof v['path'] === 'string' && v['path'] !== '' ? fileNameFromPath(v['path']) : undefined
  const size = typeof v['size'] === 'number' ? formatByteSize(v['size']) : ''
  const charset = typeof v['charset'] === 'string' ? formatCharset(v['charset']) : ''
  const segs = [name, size, charset, v['truncated'] === true ? '内容已截断' : ''].filter((s): s is string => s !== undefined && s !== '')
  return segs.length ? `已读取 ${segs.join(' · ')}` : '已读取'
}

/** 已知工具固定摘要（仅 completed 态取用；不根据任意字段编造业务结论） */
const FIXED_BRIEFS: Record<string, string> = {
  describe_image: '已完成图片内容分析',
  get_runtime_config: '已获取运行配置',
}
const FILE_READ_TOOLS: ReadonlySet<string> = new Set(['desktop.file.read', 'read_file'])

/** 折叠摘要（不修改 record）：completed 且 outputSummary 为结构化 JSON → 按工具/形状生成易读摘要
 *  （文件读取 → 已读取 …；已知工具 → 固定摘要；数组 → 计数；未知对象 → 引导语，不编造业务结论）；
 *  其余（普通文本/非 completed 态）压单行。无 outputSummary → undefined（调用方回退 inputSummary/状态文案）。 */
export function formatToolBrief(toolName: string, status: ToolCallStatus, outputSummary: string | undefined): string | undefined {
  if (typeof outputSummary !== 'string' || outputSummary === '') return undefined
  const parsed = parseStructuredSummary(outputSummary)
  if (parsed === null || status !== 'completed') return singleLineText(outputSummary)
  if (FILE_READ_TOOLS.has(toolName) && isPlainSummaryObject(parsed)) return readFileBrief(parsed)
  const fixed = FIXED_BRIEFS[toolName]
  if (fixed !== undefined) return fixed
  if (Array.isArray(parsed)) return `执行完成 · 返回 ${parsed.length} 项结果`
  return '执行完成，点击查看结果'
}

/** 展开详情：合法 JSON → JSON.stringify(value, null, 2) 缩进；普通文本原样（保留换行）；空 → undefined */
export function formatToolDetail(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const parsed = parseStructuredSummary(text)
  return parsed === null ? text : JSON.stringify(parsed, null, 2)
}

/** 展示用截断判定：record.truncated === true 或合法结构化结果顶层 truncated: true（不改原始 record） */
export function effectiveTruncated(record: Pick<ToolCallRecord, 'truncated' | 'outputSummary'>): boolean {
  if (record.truncated === true) return true
  const parsed = parseStructuredSummary(record.outputSummary)
  return isPlainSummaryObject(parsed) && parsed['truncated'] === true
}

/** 耗时展示：undefined/null/NaN/Infinity/负数/0 → ''（不显示，防「0ms」误导）；
 *  (0,1) → '<1ms'；[1,1000) → 整数 ms；≥1000 → 秒最多一位小数（不自行计算不存在的时间） */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.floor(ms)}ms`
  return `${Number((ms / 1000).toFixed(1))}s`
}
