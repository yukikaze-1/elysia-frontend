// tests/unit/env-bridge.spec.ts
// V-05（#12）：env-bridge.ts 三个 JSON parser 单测——边界与非法输入矩阵。
// 对齐 mock-backend-voice.spec.ts / mock-backend-live2d.spec.ts 的 parseMock*Env 单测先例：
// 非法 JSON/形状 → undefined（不注入），合法 → 形状经。
import { describe, expect, it } from 'vitest'
import { parseMockToolAllowRootEnv, parseMockCaptureSourcesEnv, parseMockGrantDirectoryEnv } from '../../src/main/tools/env-bridge'

describe('parseMockToolAllowRootEnv（CYRENE_MOCK_TOOL_ALLOW_ROOT → string[]）', () => {
  it('undefined / 空串 / 纯空白 → undefined（不注入）', () => {
    expect(parseMockToolAllowRootEnv(undefined)).toBeUndefined()
    expect(parseMockToolAllowRootEnv('')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('   ')).toBeUndefined()
  })
  it('非法 JSON → undefined', () => {
    expect(parseMockToolAllowRootEnv('{oops')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('not json at all')).toBeUndefined()
  })
  it('非数组（对象/字符串/数字）→ undefined', () => {
    expect(parseMockToolAllowRootEnv('{"a":1}')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('"str"')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('42')).toBeUndefined()
  })
  it('数组含非 string 元素 → undefined（非全 string 数组不注入）', () => {
    expect(parseMockToolAllowRootEnv('["/ok", 42]')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('[null]')).toBeUndefined()
    expect(parseMockToolAllowRootEnv('[{"a":1}]')).toBeUndefined()
  })
  it('空数组合法（无放行根）→ []', () => {
    expect(parseMockToolAllowRootEnv('[]')).toEqual([])
  })
  it('全 string 数组 → 原样返回', () => {
    expect(parseMockToolAllowRootEnv('["/a","/b"]')).toEqual(['/a', '/b'])
  })
})

describe('parseMockCaptureSourcesEnv（CYRENE_MOCK_CAPTURE_SOURCES → {sourceId,sourceName}[]）', () => {
  it('undefined / 空串 → undefined', () => {
    expect(parseMockCaptureSourcesEnv(undefined)).toBeUndefined()
    expect(parseMockCaptureSourcesEnv('')).toBeUndefined()
  })
  it('非法 JSON → undefined', () => {
    expect(parseMockCaptureSourcesEnv('{bad')).toBeUndefined()
  })
  it('非数组（对象）→ undefined', () => {
    expect(parseMockCaptureSourcesEnv('{"sourceId":"s1"}')).toBeUndefined()
  })
  it('数组含非对象（string/null）→ undefined', () => {
    expect(parseMockCaptureSourcesEnv('["s1"]')).toBeUndefined()
    expect(parseMockCaptureSourcesEnv('[null]')).toBeUndefined()
  })
  it('对象缺 sourceId/sourceName 或类型不符 → undefined', () => {
    expect(parseMockCaptureSourcesEnv('[{"sourceId":"s1"}]')).toBeUndefined()           // 缺 sourceName
    expect(parseMockCaptureSourcesEnv('[{"sourceName":"屏"}]')).toBeUndefined()          // 缺 sourceId
    expect(parseMockCaptureSourcesEnv('[{"sourceId":1,"sourceName":"屏"}]')).toBeUndefined() // sourceId 非 string
  })
  it('合法形状 → 原样返回（同时保留自定义缩略图字段之外的裸 {sourceId,sourceName}）', () => {
    expect(parseMockCaptureSourcesEnv('[{"sourceId":"s1","sourceName":"屏1"}]')).toEqual([{ sourceId: 's1', sourceName: '屏1' }])
    // 含额外字段（如 thumbnailDataUrl）→ 仍接受但只取 sourceId/sourceName（壳映射）——注：真实 mock 装配侧会补 thumbnailDataUrl；
    // 但 parser 本身只透传 sourceId/sourceName（缺 thumbnailDataUrl 由装配时经 MOCK_THUMBNAIL_DATA_URL 补齐，R9）——断言 parser 不丢核心字段
    expect(parseMockCaptureSourcesEnv('[{"sourceId":"s2","sourceName":"屏2","thumbnailDataUrl":"data:..."}]')).toEqual([{ sourceId: 's2', sourceName: '屏2' }])
  })
})

describe('parseMockGrantDirectoryEnv（CYRENE_MOCK_GRANT_DIRECTORY → string）', () => {
  it('falsy / 空串 → undefined', () => {
    expect(parseMockGrantDirectoryEnv(undefined)).toBeUndefined()
    expect(parseMockGrantDirectoryEnv('')).toBeUndefined()
  })
  it('非法 JSON → undefined', () => {
    expect(parseMockGrantDirectoryEnv('{bad')).toBeUndefined()
  })
  it('非字符串（对象/数字/数组）→ undefined', () => {
    expect(parseMockGrantDirectoryEnv('{"a":1}')).toBeUndefined()
    expect(parseMockGrantDirectoryEnv('42')).toBeUndefined()
    expect(parseMockGrantDirectoryEnv('["/a"]')).toBeUndefined()
  })
  it('空字符串 JSON（""）→ undefined（非空字符串校验）', () => {
    expect(parseMockGrantDirectoryEnv('""')).toBeUndefined()
  })
  it('非空字符串 JSON → 原样返回', () => {
    expect(parseMockGrantDirectoryEnv('"/tmp/authorized"')).toBe('/tmp/authorized')
  })
})
