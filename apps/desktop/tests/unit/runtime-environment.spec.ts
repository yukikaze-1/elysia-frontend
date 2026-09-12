// tests/unit/runtime-environment.spec.ts
// Silent Test Window Mode 的判据矩阵（2026-09-12）。
//
// 这是整套静默机制**唯一的判定点**，因此用例只做一件事：把「什么环境该得到什么模式」逐格钉死，
// 尤其是两条安全边界——
//   ① 自动化测试（CYRENE_TEST_HARNESS=1）**不设变量时默认 silent**（默认安全，而不是靠每个脚本记得设）；
//   ② 没有 harness 标记时**显式要求 silent 也必须被拒**（dev / 生产 / 安装版绝不因环境残留而隐身）。
import { describe, expect, it, afterEach } from 'vitest'
import {
  TEST_HARNESS_ENV,
  WINDOW_MODE_ENV,
  isTestHarnessEnv,
  parseWindowMode,
  resetRuntimeEnvironmentForTest,
  resolveRuntimeEnvironment,
  runtimeEnvironment,
} from '../../src/main/config/runtime-environment'

const resolve = (env: Record<string, string | undefined>, mode = 'test') => resolveRuntimeEnvironment({ env, mode })

afterEach(() => {
  delete process.env[WINDOW_MODE_ENV]
  delete process.env[TEST_HARNESS_ENV]
  resetRuntimeEnvironmentForTest()
})

describe('WindowMode 解析', () => {
  it('只识别 silent / visible，且容忍大小写与首尾空白', () => {
    expect(parseWindowMode('silent')).toBe('silent')
    expect(parseWindowMode(' VISIBLE ')).toBe('visible')
    expect(parseWindowMode(undefined)).toBeUndefined()
  })

  it('无法识别的取值视为「未指定」（拼错不改变行为，更不让窗口隐身）', () => {
    for (const raw of ['', 'quiet', '0', '1', 'true', 'hidden']) expect(parseWindowMode(raw)).toBeUndefined()
  })

  it('harness 标记只认字符串 "1"', () => {
    expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: '1' })).toBe(true)
    for (const raw of ['true', 'yes', '0', '', undefined]) expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: raw })).toBe(false)
  })
})

describe('运行期环境判定矩阵', () => {
  it('开发/生产默认：visible（现有行为逐字不变）', () => {
    const env = resolve({}, 'development')
    expect(env.isTestHarness).toBe(false)
    expect(env.windowMode).toBe('visible')
    expect(env.windowModeSource).toBe('default')
    expect(env.isSilentWindowMode).toBe(false)
    expect(env.isVisibleTestMode).toBe(false)

    expect(resolve({}, 'production').windowMode).toBe('visible')
    expect(resolve({}).windowMode).toBe('visible') // mode 缺省（__APP_MODE__ 未注入）也必须是 visible
  })

  it('测试 harness 默认：silent（自动化测试默认不打扰桌面）', () => {
    const env = resolve({ [TEST_HARNESS_ENV]: '1' })
    expect(env.isTestHarness).toBe(true)
    expect(env.windowMode).toBe('silent')
    expect(env.windowModeSource).toBe('harness-default')
    expect(env.isSilentWindowMode).toBe(true)
    expect(env.isVisibleTestMode).toBe(false)
  })

  it('显式 visible：即使处于 harness 也照常显示窗口（可视化调试模式）', () => {
    const env = resolve({ [TEST_HARNESS_ENV]: '1', [WINDOW_MODE_ENV]: 'visible' })
    expect(env.windowMode).toBe('visible')
    expect(env.windowModeSource).toBe('env')
    expect(env.isSilentWindowMode).toBe(false)
    expect(env.isVisibleTestMode).toBe(true)
  })

  it('显式 silent + harness：silent（可显式声明，不依赖默认值）', () => {
    const env = resolve({ [TEST_HARNESS_ENV]: '1', [WINDOW_MODE_ENV]: 'silent' })
    expect(env.windowMode).toBe('silent')
    expect(env.windowModeSource).toBe('env')
    expect(env.isSilentWindowMode).toBe(true)
  })

  it('安全边界：无 harness 标记时显式 silent 被拒（降级 visible 并留下来源证据）', () => {
    for (const mode of ['development', 'production', 'test']) {
      const env = resolve({ [WINDOW_MODE_ENV]: 'silent' }, mode)
      expect(env.isSilentWindowMode).toBe(false)
      expect(env.windowMode).toBe('visible')
      expect(env.windowModeSource).toBe('rejected-not-harness')
    }
    // harness 标记不是 '1' 同样不算（例如误设 'true'）
    expect(resolve({ [WINDOW_MODE_ENV]: 'silent', [TEST_HARNESS_ENV]: 'true' }).windowModeSource).toBe('rejected-not-harness')
  })

  it('保留构建模式（诊断证据用），非法值归一到 production', () => {
    expect(resolve({}, 'test').mode).toBe('test')
    expect(resolve({}, 'development').mode).toBe('development')
    expect(resolve({}, 'staging').mode).toBe('production')
  })
})

describe('进程级单例', () => {
  it('默认（当前进程环境）下不为 silent，且解析结果被缓存', () => {
    const first = runtimeEnvironment()
    const second = runtimeEnvironment()
    expect(first).toBe(second) // 同一对象：同进程内模式不会漂移
    expect(first.isSilentWindowMode).toBe(false)
  })

  it('resetRuntimeEnvironmentForTest 后按当前 process.env 重新解析', () => {
    process.env[TEST_HARNESS_ENV] = '1'
    resetRuntimeEnvironmentForTest()
    expect(runtimeEnvironment().windowMode).toBe('silent')

    process.env[WINDOW_MODE_ENV] = 'visible'
    resetRuntimeEnvironmentForTest()
    expect(runtimeEnvironment().windowMode).toBe('visible')
    expect(runtimeEnvironment().windowModeSource).toBe('env')
  })
})
