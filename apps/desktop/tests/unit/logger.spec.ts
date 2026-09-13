// tests/unit/logger.spec.ts
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createLogger, formatLogEvent, severityOf } from '../../src/main/diagnostics/logger'
import type { FileWriter } from '../../src/main/diagnostics/file-writer'

/** JSON 对象判型：`JSON.parse` 的产物是外部输入（lib 里返回 `any`），先收成 `unknown` 再用它收窄。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 已判型的日志行：`fields` 是结构化字段对象，其余键按 `unknown` 读（断言照旧，不再经 `any`）。 */
interface ParsedLogLine {
  fields: Record<string, unknown>
  [key: string]: unknown
}

function parseLogLine(line: string): ParsedLogLine {
  const raw: unknown = JSON.parse(line)
  if (!isJsonObject(raw)) throw new Error(`日志行不是 JSON 对象：${line}`)
  const fields = raw.fields
  if (!isJsonObject(fields)) throw new Error(`日志行缺 fields 对象：${line}`)
  return { ...raw, fields }
}

function fakeWriter(): { writer: FileWriter; lines: string[]; append: Mock<(line: string) => Promise<void>> } {
  const lines: string[] = []
  // append 单独留在返回类型里：spec 要读 `append.mock.calls`，而 `FileWriter.append` 是普通签名（无 mock 成员）。
  // 原写法 `(writer.append as ReturnType<typeof vi.fn>).mock.calls[0][0]` 会把取到的实参退化成 `any`。
  const append = vi.fn(async (l: string) => { lines.push(l) })
  const writer: FileWriter = {
    append,
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    clear: vi.fn(async () => ({ removedFiles: 0, freedBytes: 0 }))
  }
  return { writer, lines, append }
}
const noopSanitize = (m: string): string => m

describe('severityOf / 级别过滤', () => {
  it('error<warn<info<debug', () => {
    expect(severityOf('error')).toBeLessThan(severityOf('warn'))
    expect(severityOf('warn')).toBeLessThan(severityOf('info'))
    expect(severityOf('info')).toBeLessThan(severityOf('debug'))
  })
  it('threshold=info 时 debug 被滤、info 及以上写入', () => {
    const { writer, lines } = fakeWriter()
    const log = createLogger('main', { level: 'info', writer, sanitize: noopSanitize })
    log.debug('dbg')
    log.info('inf')
    log.warn('wrn')
    expect(lines.map((l) => parseLogLine(l).level)).toEqual(['info', 'warn'])
  })
})

describe('formatLogEvent / JSONL 结构', () => {
  it('JSONL 行含 ts/level/logger/code/fields', () => {
    const ev = { ts: 't', level: 'info' as const, logger: 'main', code: 'app:started', fields: { n: 1 } }
    const parsed = parseLogLine(formatLogEvent(ev))
    expect(parsed).toMatchObject({ ts: 't', level: 'info', logger: 'main', code: 'app:started', fields: { n: 1 } })
  })
  it('无 msg 字段（结构性禁记：消息正文无入口）', () => {
    const { writer, append } = fakeWriter()
    const log = createLogger('main', { level: 'debug', writer, sanitize: noopSanitize })
    log.info('some:code', { path: '/x' })
    const parsed = parseLogLine(append.mock.calls[0][0])
    expect(parsed.msg).toBeUndefined()
  })
})

describe('fields 净化', () => {
  it('路径经 sanitize、token 经 redact 后落盘', () => {
    const { writer, lines } = fakeWriter()
    const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
    const log = createLogger('main', { level: 'info', writer, sanitize })
    log.info('conn:failed', { path: '/home/alice/x', token: 'Bearer abc.def-ghi_123XYZ' })
    const parsed = parseLogLine(lines[0])
    expect(parsed.fields.path).toBe('~/x')
    expect(parsed.fields.token).toBe('Bearer [REDACTED]')
  })
})

describe('类型层禁记（编译期）', () => {
  it('logger 方法无 msg 自由文本参数', () => {
    const { writer } = fakeWriter()
    const log = createLogger('main', { level: 'debug', writer, sanitize: noopSanitize })
    // @ts-expect-error —— 无 msg 参数（结构性禁记：不接收消息正文）
    log.info('code', undefined, '这是消息正文，不允许')
    expect(true).toBe(true)
  })
})
