// tests/unit/tool-display.spec.ts —— UII-QQ 工具卡二轮收尾：展示层格式化纯函数。
// 不执行输出内容、不修改 ToolCallRecord 原始值；JSON 解析失败一律安全回退不抛异常。
import { describe, expect, it } from 'vitest'
import {
  effectiveTruncated, fileNameFromPath, formatByteSize, formatCharset, formatDuration,
  formatToolBrief, formatToolDetail, parseStructuredSummary, readFileBrief, singleLineText,
} from '../../src/renderer/src/utils/tool-display'

describe('parseStructuredSummary（安全 JSON 解析）', () => {
  it('合法对象/数组解析成功；非 {/[ 开头、非法 JSON、纯量 → null（不抛异常）', () => {
    expect(parseStructuredSummary('{"a":1}')).toEqual({ a: 1 })
    expect(parseStructuredSummary(' [1,2] ')).toEqual([1, 2])
    expect(parseStructuredSummary('not json')).toBeNull()
    expect(parseStructuredSummary('{broken')).toBeNull()
    expect(parseStructuredSummary('"plain string"')).toBeNull()
    expect(parseStructuredSummary('42')).toBeNull()
    expect(parseStructuredSummary(undefined)).toBeNull()
    expect(parseStructuredSummary('')).toBeNull()
  })
})

describe('singleLineText（普通文本压单行）', () => {
  it('连续空白折叠为单空格；超长截断加省略号', () => {
    expect(singleLineText('a\n\r b\t  c')).toBe('a b c')
    expect(singleLineText('x'.repeat(300))).toHaveLength(201)
    expect(singleLineText('x'.repeat(300)).endsWith('…')).toBe(true)
  })
})

describe('formatByteSize / formatCharset / fileNameFromPath', () => {
  it('字节数易读格式（150000 → 146.5 KB；去尾 0；非法输入空串）', () => {
    expect(formatByteSize(150000)).toBe('146.5 KB')
    expect(formatByteSize(999)).toBe('999 B')
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(1048576)).toBe('1 MB')
    expect(formatByteSize(-1)).toBe('')
    expect(formatByteSize(Number.NaN)).toBe('')
  })
  it('charset 规范化：utf-8/UTF8 → UTF-8；gbk → GBK；未知原样', () => {
    expect(formatCharset('utf-8')).toBe('UTF-8')
    expect(formatCharset('UTF8')).toBe('UTF-8')
    expect(formatCharset('gbk')).toBe('GBK')
    expect(formatCharset('windows-1252')).toBe('windows-1252')
  })
  it('文件名提取：/ 与 \\ 分隔、空段过滤、无段 undefined', () => {
    expect(fileNameFromPath('/tmp/dir/stage6-large.txt')).toBe('stage6-large.txt')
    expect(fileNameFromPath('C:\\data\\notes.md')).toBe('notes.md')
    expect(fileNameFromPath('a/b/')).toBe('b')
    expect(fileNameFromPath('')).toBeUndefined()
  })
})

describe('readFileBrief（文件读取易读摘要）', () => {
  it('全字段：已读取 <name> · <size> · <charset> · 内容已截断', () => {
    expect(readFileBrief({ path: '/tmp/stage6-large.txt', name: 'stage6-large.txt', size: 150000, charset: 'utf-8', truncated: true }))
      .toBe('已读取 stage6-large.txt · 146.5 KB · UTF-8 · 内容已截断')
  })
  it('降级：无 name 从 path 提取；charset/size 缺省省略；字段不存在不显示 undefined', () => {
    expect(readFileBrief({ path: '/tmp/a/b/report.pdf' })).toBe('已读取 report.pdf')
    expect(readFileBrief({ name: 'x.bin', size: 2048 })).toBe('已读取 x.bin · 2 KB')
    expect(readFileBrief({ name: 'x', size: 'big' })).toBe('已读取 x')   // size 非数字 → 省略
    expect(readFileBrief({})).toBe('已读取')
  })
})

describe('formatToolBrief（折叠摘要）', () => {
  const readJson = JSON.stringify({ path: '/tmp/stage6-large.txt', name: 'stage6-large.txt', size: 150000, charset: 'utf-8', truncated: true })
  it('文件读取 JSON → 易读摘要（不显示原始 JSON 整串）', () => {
    expect(formatToolBrief('desktop.file.read', 'completed', readJson)).toBe('已读取 stage6-large.txt · 146.5 KB · UTF-8 · 内容已截断')
    expect(formatToolBrief('read_file', 'completed', readJson)).toContain('已读取')
  })
  it('已知工具固定摘要：describe_image / get_runtime_config', () => {
    expect(formatToolBrief('describe_image', 'completed', '{"ok":true}')).toBe('已完成图片内容分析')
    expect(formatToolBrief('get_runtime_config', 'completed', '{"tools":[]}')).toBe('已获取运行配置')
  })
  it('未知 JSON：数组 → 项数；对象 → 引导语（不编造业务结论）', () => {
    expect(formatToolBrief('custom_tool', 'completed', '[1,2,3]')).toBe('执行完成 · 返回 3 项结果')
    expect(formatToolBrief('custom_tool', 'completed', '{"a":1}')).toBe('执行完成，点击查看结果')
  })
  it('普通文本压单行；非 completed 态不套成功口径；无 outputSummary → undefined', () => {
    expect(formatToolBrief('custom_tool', 'completed', '第一行\n第二行')).toBe('第一行 第二行')
    expect(formatToolBrief('custom_tool', 'running', '{"a":1}')).toBe('{"a":1}')
    expect(formatToolBrief('custom_tool', 'completed', undefined)).toBeUndefined()
  })
})

describe('formatToolDetail / effectiveTruncated', () => {
  it('JSON → 2 空格缩进；普通文本原样；空 → undefined', () => {
    expect(formatToolDetail('{"b":1,"a":[1,2]}')).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(formatToolDetail('第一行\n第二行')).toBe('第一行\n第二行')
    expect(formatToolDetail(undefined)).toBeUndefined()
    expect(formatToolDetail('')).toBeUndefined()
  })
  it('截断判定：record.truncated 或结构化顶层 truncated: true；普通文本/数组 → false', () => {
    expect(effectiveTruncated({ truncated: true, outputSummary: undefined })).toBe(true)
    expect(effectiveTruncated({ truncated: undefined, outputSummary: '{"path":"/a","truncated":true}' })).toBe(true)
    expect(effectiveTruncated({ truncated: undefined, outputSummary: '{"path":"/a"}' })).toBe(false)
    expect(effectiveTruncated({ truncated: undefined, outputSummary: '[1,2]' })).toBe(false)
    expect(effectiveTruncated({ truncated: undefined, outputSummary: 'plain text' })).toBe(false)
  })
})

describe('formatDuration（耗时展示）', () => {
  it('undefined/null/NaN/Infinity/负数/0 → 空串（不显示 0ms）', () => {
    for (const v of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      expect(formatDuration(v)).toBe('')
    }
  })
  it('(0,1) → <1ms；[1,1000) → 整数 ms；≥1000 → 秒最多一位小数', () => {
    expect(formatDuration(0.4)).toBe('<1ms')
    expect(formatDuration(30)).toBe('30ms')
    expect(formatDuration(999.9)).toBe('999ms')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(61500)).toBe('61.5s')
  })
})
