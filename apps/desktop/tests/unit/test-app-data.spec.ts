import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveTestAppDataOverride, TEST_APP_DATA_ENV } from '../../src/main/app/test-app-data'

const absolute = join(tmpdir(), 'cyrene-test-app-data')

function resolve(overrides: Partial<Parameters<typeof resolveTestAppDataOverride>[0]> = {}): string | undefined {
  return resolveTestAppDataOverride({
    env: { CYRENE_TEST_HARNESS: '1', [TEST_APP_DATA_ENV]: absolute },
    packaged: false,
    mode: 'test',
    ...overrides,
  })
}

describe('测试 appData 覆盖策略', () => {
  it('仅在 test+harness+未打包三重门下返回绝对路径', () => {
    expect(resolve()).toBe(absolute)
  })

  it('未请求覆盖时保持生产/开发默认路径', () => {
    expect(resolve({ env: {} })).toBeUndefined()
  })

  it('缺 harness 时拒绝，不能静默落到真实用户目录', () => {
    expect(() => resolve({ env: { [TEST_APP_DATA_ENV]: absolute } })).toThrow('仅允许未打包的 test harness')
  })

  it('打包产物拒绝测试路径覆盖', () => {
    expect(() => resolve({ packaged: true })).toThrow('仅允许未打包的 test harness')
  })

  it('非 test 构建拒绝测试路径覆盖', () => {
    expect(() => resolve({ mode: 'development' })).toThrow('仅允许未打包的 test harness')
  })

  it('拒绝空值、相对路径和首尾空白', () => {
    for (const path of ['', 'relative/path', ` ${absolute}`]) {
      expect(() => resolve({ env: { CYRENE_TEST_HARNESS: '1', [TEST_APP_DATA_ENV]: path } }))
        .toThrow('必须是无首尾空白的绝对路径')
    }
  })
})
