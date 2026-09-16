// tests/unit/runtime-environment.spec.ts
// Silent Test Window Mode 的判据矩阵（2026-09-12）。
//
// 这是整套静默机制**唯一的判定点**，因此用例只做一件事：把「什么环境该得到什么模式」逐格钉死，
// 尤其是两条安全边界——
//   ① 自动化测试（CYRENE_TEST_HARNESS=1）**不设变量时默认 silent**（默认安全，而不是靠每个脚本记得设）；
//   ② 没有 harness 标记时**显式要求 silent 也必须被拒**（dev / 生产 / 安装版绝不因环境残留而隐身）。
import { describe, expect, it, afterEach } from 'vitest'
import {
  PACKAGED_HARNESS_ENV,
  TEST_HARNESS_ENV,
  WINDOW_MODE_ENV,
  isTestHarnessEnv,
  normalizeHarnessEnv,
  parseWindowMode,
  resetRuntimeEnvironmentForTest,
  resolveRuntimeEnvironment,
  runtimeEnvironment,
} from '../../src/main/config/runtime-environment'
import { GPU_MODE_ENV, hasGpuDeviceNode, resolveGpuDecision } from '../../src/main/config/gpu-mode'

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

  it('打包态二开（2026-09-16 审计 P2）：packaged 时只认单变量 → 不承认，必须再有 CYRENE_PACKAGED_HARNESS=1', () => {
    // 未打包（缺省 packaged=false）：语义与修复前逐字一致——单变量即承认
    expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: '1' })).toBe(true)
    // 打包态：单变量**不**承认（它可能是用户 shell / 启动器 / 上次冒烟的残留）
    expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: '1' }, true)).toBe(false)
    // 打包态 + 二开：承认
    expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: '1', [PACKAGED_HARNESS_ENV]: '1' }, true)).toBe(true)
    // 二开本身不是 harness 标记：只设它不算
    expect(isTestHarnessEnv({ [PACKAGED_HARNESS_ENV]: '1' }, true)).toBe(false)
    // 二开同样只认字符串 '1'（与主标记同源口径，不接受 true/yes）
    for (const raw of ['true', 'yes', '0', '', undefined]) {
      expect(isTestHarnessEnv({ [TEST_HARNESS_ENV]: '1', [PACKAGED_HARNESS_ENV]: raw }, true)).toBe(false)
    }
  })

  it('打包态归一化（normalizeHarnessEnv）：未获二开时**就地抹掉**标记，之后全部读取点都看到正式语义', () => {
    // 打包 + 单变量 ⇒ 抹掉，返回 true；抹掉后连"未打包口径"的读取也看到无标记
    const stray = { [TEST_HARNESS_ENV]: '1' }
    expect(normalizeHarnessEnv(stray, true)).toBe(true)
    expect(stray[TEST_HARNESS_ENV]).toBeUndefined()
    expect(isTestHarnessEnv(stray)).toBe(false)
    // 打包 + 二开 ⇒ 不抹（返回 false，标记保留）
    const ok = { [TEST_HARNESS_ENV]: '1', [PACKAGED_HARNESS_ENV]: '1' }
    expect(normalizeHarnessEnv(ok, true)).toBe(false)
    expect(ok[TEST_HARNESS_ENV]).toBe('1')
    // 未打包 ⇒ 不抹（dev/集成套件的语义一个字节都不变）
    const dev = { [TEST_HARNESS_ENV]: '1' }
    expect(normalizeHarnessEnv(dev, false)).toBe(false)
    expect(dev[TEST_HARNESS_ENV]).toBe('1')
    // 幂等 + 无标记时不动
    expect(normalizeHarnessEnv({}, true)).toBe(false)
    expect(normalizeHarnessEnv({}, false)).toBe(false)
    // 端到端形态：抹掉之后，同一份 env 交给解析器得到的是 dev/生产默认（visible），而不是 harness 默认（silent）
    const env = { [TEST_HARNESS_ENV]: '1' }
    normalizeHarnessEnv(env, true)
    const resolved = resolveRuntimeEnvironment({ env, mode: 'production' })
    expect(resolved.isTestHarness).toBe(false)
    expect(resolved.windowMode).toBe('visible')
    expect(resolved.windowModeSource).toBe('default')
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

// ═══════════════════════════════════════════════════════════════════════════════
// 2026-09-16 审计 P2 / 立项：Linux 无 GPU 时的硬件加速回退
//
// 缺口：无 DRI 的 Mesa 软件光栅器在 GPU 进程里确定性段错误，Chromium 重试耗尽后
// `FATAL: GPU process isn't usable. Goodbye.` **杀掉整个应用**；而 `--disable-gpu` 此前只在
// 测试脚手架与 `verify-artifact.cjs`，`src/main/**` 零命中 ⇒ 产品侧无回退（本机 Windows 测不到，
// 证据全部来自 X99 的 xvfb 最小复现）。
//
// 判据取"平台 + 设备节点存在性"，因为 `app.getGPUFeatureStatus()` **只在 ready 之后可用**，
// 而崩溃发生在 GPU 进程初始化期——等拿到读数就晚了。故这里用注入的假 fs 钉住判定矩阵。
//
// 判定点独立成 `config/gpu-mode.ts`（**不并进 runtime-environment.ts**）：后者被
// window-presentation/dialog-service 依赖，并进去会把 node:fs 拖进它们的依赖图，
// 2026-09-16 实测会让 renderer-crash 集成用例稳定失败。
// ═══════════════════════════════════════════════════════════════════════════════
describe('GPU 回退判定（2026-09-16 审计 P2）', () => {
  const resolveGpu = (
    env: Record<string, string | undefined>,
    platform: string,
    hasNode: boolean
  ) => resolveGpuDecision({ env, platform, hasGpuDeviceNode: () => hasNode })

  it('Linux + 无 GPU 设备节点 ⇒ 回退（xvfb / 容器 / 无 3D 的 VM 正是这一档）', () => {
    const r = resolveGpu({}, 'linux', false)
    expect(r.disableHardwareAcceleration).toBe(true)
    expect(r.gpuModeSource).toBe('no-device-node')
  })

  it('Linux + 有 GPU 设备节点 ⇒ **不干预**（有硬件 GL 的桌面行为逐字不变）', () => {
    const r = resolveGpu({}, 'linux', true)
    expect(r.disableHardwareAcceleration).toBe(false)
    expect(r.gpuModeSource).toBe('default')
  })

  it('X99 形态（2026-09-16 实测）⇒ 同样**不干预**——把"这一档不被覆盖"钉成断言而不是只写在文档里', () => {
    // X99 的真实 /dev/dri 内容：card0 / card1 / renderD128 / renderD129（内核已加载 nvidia / nvidia_drm / amdgpu）。
    // **而当初测到"GPU 进程在 Mesa 软件光栅器里确定性段错误"的正是这台机器** ⇒ 判据在它上面不触发，
    // 产品侧自动回退覆盖不到我们真正观测到崩溃的那一档（"节点在、但该会话里 GPU 用不了"）。
    // 本条断言的是**已知边界**，不是"已修好"：要覆盖它需要另一套判据（见 doc 09 §8 的 2026-09-16 补记）。
    const x99Entries = ['card0', 'card1', 'renderD128', 'renderD129']
    const hasNode = x99Entries.some((n) => /^(card|renderD)\d+$/.test(n))
    expect(hasNode).toBe(true)   // 前置：按真实实现的判据，这四条确实算"有可用 GPU"
    const r = resolveGpu({}, 'linux', hasNode)
    expect(r.disableHardwareAcceleration).toBe(false)
    expect(r.gpuModeSource).toBe('default')
  })

  it('非 Linux 一律不干预（本缺口只在 Mesa/xvfb 那条路径上有证据）', () => {
    for (const platform of ['win32', 'darwin']) {
      const r = resolveGpu({}, platform, false)
      expect(r.disableHardwareAcceleration, `${platform} 不得被误回退`).toBe(false)
      expect(r.gpuModeSource).toBe('default')
    }
  })

  it('CYRENE_GPU_MODE=disable ⇒ 任何平台都强制回退（现场自救口）', () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      const r = resolveGpu({ [GPU_MODE_ENV]: 'disable' }, platform, true)
      expect(r.disableHardwareAcceleration, `${platform} 显式要求必须照办`).toBe(true)
      expect(r.gpuModeSource).toBe('env')
    }
  })

  it('CYRENE_GPU_MODE=auto 是显式"按自动判定"，不改变结论', () => {
    const r = resolveGpu({ [GPU_MODE_ENV]: 'auto' }, 'linux', false)
    expect(r.disableHardwareAcceleration).toBe(true)
    expect(r.gpuMode).toBe('auto')
  })

  it('取值拼错一律视为未指定（拼错不该改变渲染路径）', () => {
    const r = resolveGpu({ [GPU_MODE_ENV]: 'off' }, 'win32', false)
    expect(r.disableHardwareAcceleration).toBe(false)
    expect(r.gpuMode).toBe('auto')
  })

  it('hasGpuDeviceNode 只认 card*/renderD* 条目：目录不存在/无权限同样算"没有可用 GPU"', () => {
    // 直接测真实实现：给一个不存在的路径必须 fail-safe 成 false，而不是抛。
    expect(hasGpuDeviceNode('/definitely/not/here')).toBe(false)
  })
})
