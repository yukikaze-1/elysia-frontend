// tests/integration/electron-live2d-core.spec.ts
// Task 7（阶段 5 批次 A / A7）：Electron 集成测试——Live2D 全链路验收（brief Step 2 十用例）。
// 覆盖：启动→右栏→list-models / 首帧 / 切换 / 损坏注入 / 协议安全 / 设备丢失 / 折叠停渲染 /
//       持久化重启 / appData 恒等(I2) / asm.js 探针(M5)。
//
// 2026-09-15 拆分（A-1，本仓 CI 墙钟地板的处置）：原 electron-live2d.spec.ts（28 用例 / 62.9KB）在 CI 上
//   独占一个 job（自建机实测定标 182.3s）= 整条 CI 的墙钟地板。按**实测逐用例耗时**（本机 Windows 基线
//   128.6s，逐例耗时见本批提交信息）切成三个文件，本文件是其中的「基础链路」：
//     · electron-live2d-core.spec.ts（本文件，12 用例）实测 35.1s
//     · electron-live2d-motion.spec.ts（7 用例）   实测 47.3s
//     · electron-live2d-settings.spec.ts（9 用例） 实测 43.7s
//   **断言强度逐字未动**：28 个 it 的用例体原样搬运（含全部注释），仅把装配块与「会话/设置操作原语」
//   移入共享 helper（helpers/live2d-fixture.ts，只此一份——三份复制会让装配前置漂移，见该文件头注）。
//   本文件收批次 A 的 11 例 + 「B7.切换竞态」1 例——后者与 A3（切换）、A8（切换后重启持久化）同域，且
//   把它放进 core 是为了让三个文件的实测耗时落在同一量级（否则 motion 会到 59.2s 而 core 只有 30.1s）。
//   因原 describe（B7：状态驱动/动作/设置/性能/布局/竞态）本身已被拆到三个文件，各文件的该 describe 标题
//   按实际收容的用例改写；**it 名逐字未动**。
//
// 装配与观测原语：helpers/live2d-fixture.ts（installLive2dMaster / freshUserData / launchL2d / 各观测函数）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'node:path'
import { closeApp } from './helpers/app'
import {
  POLL, WANKO_ID, installLive2dMaster, teardownLive2dMaster, freshUserData, launchL2d, platformEnv, lilModelFile,
  statusText, selectValue, waitLive2dSettled, waitLive2dTerminal, connectAndActivateFirst, countNonTransparentPx,
  readSettingsL2d
} from './helpers/live2d-fixture'
import { resolveModelsDir } from '../../scripts/live2d-install.mjs'

// —— 装配（本文件用到的标志：haru / lil / wanko）——
let haruInstalled = false
let lilInstalled = false
let wankoInstalled = false

beforeAll(async () => {
  const res = await installLive2dMaster()
  haruInstalled = res.haru
  lilInstalled = res.lil
  wankoInstalled = res.wanko
}, 120_000)

afterAll(() => { teardownLive2dMaster() })

describe('阶段5批次A Live2D Electron 集成（A7）', () => {
  it('1.启动→右栏显示→list-models 含 haru(±lil) 且 available', async () => {
    expect(haruInstalled).toBe(true)
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await expect.poll(() => page.locator('.cy-live').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-live').isVisible(), POLL).toBe(true)
      const summaries = await page.evaluate(() => window.desktopApi.listLive2dModels())
      const haru = summaries.find((m) => m.id === 'haru')
      expect(haru).toBeTruthy()
      expect(haru!.available).toBe(true)
      expect(haru!.licenseRef).toBe('LICENSE.txt')
      if (lilInstalled) {
        const lil = summaries.find((m) => m.id === 'lil')
        expect(lil).toBeTruthy()
        expect(lil!.available).toBe(true)
      }
      if (wankoInstalled) {
        const wanko = summaries.find((m) => m.id === WANKO_ID)
        expect(wanko).toBeTruthy()
        expect(wanko!.available).toBe(true) // 确定性切换目标（SwiftShader 可渲染）
      }
      const s = await waitLive2dSettled(page)
      expect(s).toMatch(/就绪|回退/) // 默认首个可用模型装载；SwiftShader 下就绪或静态回退均不阻塞
    } finally { await closeApp(launched) }
  })

  it('2.首帧：status=ready + 画布非透明像素 + 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      const s = await waitLive2dSettled(page)
      expect(errors).toEqual([]) // 装载/渲染期无 console error
      if (s.includes('就绪')) {
        // 稳健首帧：store status=ready + 画布存在非透明像素（SwiftShader 软渲染应可见）
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
        // 画布确实在渲染：@framework 首帧 shader fetch/draw 无 console error 已覆盖（spike②）
      } else {
        // GPU 上下文创建失败/无模型 → 静态回退；画布不产生像素属预期（写实记录）
        expect(s).toContain('回退')
      }
    } finally { await closeApp(launched) }
  })

  it('3.切换：选另一模型 → ready（或静态回退，不 crash）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 真实 select 操作（无 force）；目标为非默认可用模型（Wanko：SwiftShader 可渲染的确定性目标）
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      // 确定性断言：轮询直到切换完成并装载 Wanko（ready · Wanko）——非默认模型真实切换闭环；
      // 不能只等「就绪」（启动即就绪 Haru，会与异步 switch 竞态），须等 Wanko 名出现
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      // 切换后聊天视图仍在（不 crash）
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('4.损坏注入：篡改模型文件 → 重载 → failed/不可用保留原模型 + 聊天可用', async () => {
    const ud = freshUserData()
    // 篡改 lil 的一个模型文件（追加字节改 size → integrity 尺寸不符 → available=false, reason=size_mismatch）
    if (lilInstalled) {
      const lilMoc = join(ud, 'Cyrene', 'models', 'lil', lilModelFile(ud))
      writeFileSync(lilMoc, Buffer.concat([readFileSync(lilMoc), Buffer.from([0])]))
    }
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      const summaries = await page.evaluate(() => window.desktopApi.listLive2dModels())
      if (lilInstalled) {
        const lil = summaries.find((m) => m.id === 'lil')
        expect(lil?.available).toBe(false)
        expect(lil?.reason).toBe('size_mismatch') // 脱敏枚举码
      }
      // 原模型（haru）保留可用
      const haru = summaries.find((m) => m.id === 'haru')
      expect(haru?.available).toBe(true)
      // 重载后 failed/静态回退不阻塞聊天
      const s = await waitLive2dSettled(page)
      expect(s).toMatch(/就绪|回退|失败/)
      await connectAndActivateFirst(page) // 聊天输入仍可用
    } finally { await closeApp(launched) }
  })

  it('5.协议安全：路径穿越 → 4xx；document 请求 → 403', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      // 先等应用自装载奠基（verifyIntegrity 缓存 verified + 模型文件实际可供给），再探分支——避免启动时序竞态
      await waitLive2dSettled(page)
      // 穿越逃逸 → parseLive2dPath 拒 .. → 403（或 4xx 均拒）
      const traversal = await page.evaluate(async () => {
        const r = await fetch('cyrene://renderer/__cyrene-live2d/haru/../../../../etc/passwd')
        return r.status
      })
      expect(traversal).toBeGreaterThanOrEqual(400)
      expect(traversal).toBeLessThan(500)
      // document 请求（访问顶层导航语义）→ 403
      const doc = await page.evaluate(async () => {
        const r = await fetch('cyrene://renderer/__cyrene-live2d/haru/Haru.model3.json', { headers: { 'Sec-Fetch-Dest': 'document' } })
        return r.status
      })
      expect(doc).toBe(403)
      // 合法文件供给仍 200（分支健全；首帧已隐式覆盖真实加载，这里直接探）
      const ok = await page.evaluate(async () => (await fetch('cyrene://renderer/__cyrene-live2d/haru/model3.json')).status)
      expect(ok).toBe(200)
    } finally { await closeApp(launched) }
  })

  it('5b.dev 供给通道：live2d:read-model-file 与协议通道同门禁、同字节', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 打包/preview 形态页面自身即 cyrene://renderer（同源）→ 渲染层走原生 fetch，**不使用**本通道；
      // 这里直接驱动它，验证 dev 形态（页面在 http://localhost 跨源，被 corsEnabled:false 拒绝）所依赖的
      // IPC 供给路径在真实 Electron 里成立。2026-09-10：dev 下 fetch(cyrene://) 必抛原生 Failed to fetch，
      // 该通道即为此而加（见 src/renderer/src/live2d/dev-resource-fetch.ts）。
      const meta = await page.evaluate(async () => {
        const r = await window.desktopApi.readLive2dModelFile('haru', 'model3.json')
        return r.ok ? { ok: true as const, len: r.bytes.byteLength, mime: r.mime } : r
      })
      expect(meta.ok).toBe(true)
      if (meta.ok) {
        expect(meta.len).toBeGreaterThan(0)
        expect(meta.mime).toBe('application/json')
      }
      // 同字节：两条通道共用同一个 registry 与同一道 gateLive2dFile，故供给内容必须逐字节一致
      const identical = await page.evaluate(async () => {
        const r = await window.desktopApi.readLive2dModelFile('haru', 'model3.json')
        if (!r.ok) return false
        const viaProtocol = new Uint8Array(
          await (await fetch('cyrene://renderer/__cyrene-live2d/haru/model3.json')).arrayBuffer()
        )
        if (viaProtocol.byteLength !== r.bytes.byteLength) return false
        for (let i = 0; i < viaProtocol.byteLength; i++) if (viaProtocol[i] !== r.bytes[i]) return false
        return true
      })
      expect(identical).toBe(true)
      // 拒绝矩阵与协议通道一致（同一门禁实现）：越界 relPath → 403、未注册 modelId → 404
      const traversal = await page.evaluate(() => window.desktopApi.readLive2dModelFile('haru', '../../../../etc/passwd'))
      expect(traversal).toEqual({ ok: false, status: 403 })
      const unknown = await page.evaluate(() => window.desktopApi.readLive2dModelFile('nope', 'model3.json'))
      expect(unknown).toEqual({ ok: false, status: 404 })
      // modelId 收窄在请求 schema 层（ASCII slug，非 . / ..）→ 非法 id 直接参数校验失败，不落到闸门
      const malformed = await page.evaluate(() =>
        window.desktopApi.readLive2dModelFile('..', 'model3.json').then(() => 'resolved').catch((e: unknown) => String(e))
      )
      expect(malformed).toContain('SCHEMA_VALIDATION_FAILED')
    } finally { await closeApp(launched) }
  })

  it('6.设备丢失：触发 webglcontextlost → 一次重建（ready/fallback）+ 聊天可用', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 规范 GPU-lost 模拟：WEBGL_lose_context.loseContext() 触发真实 webglcontextlost → adapter gpuLost 置位 →
      // 下一渲染 tick 抛 Live2DGpuLostError → device_lost → store 重建一次（批次 C D5C-04：ready 或 fallback）
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
        const gl = canvas?.getContext('webgl') ?? canvas?.getContext('webgl2')
        const ext = gl?.getExtension('WEBGL_lose_context')
        ext?.loseContext()
      })
      // 重建：等真正落终态（就绪=重建成功 / 回退=重建失败，SwiftShader 下均合法）。注意 fallback 在 reset
      // 之前就被同步镜像，故不能用「状态文本合法」当等重建完成的判据（见 waitLive2dTerminal 注释）。
      await waitLive2dTerminal(page)
      await connectAndActivateFirst(page) // 重建/回退不阻塞聊天
    } finally { await closeApp(launched) }
  })

  it('7.折叠：live2dShown=false → 渲染循环停止（rAF 无新帧）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      // 提前包裹 requestAnimationFrame 计数（须在循环激活前注入）
      await page.evaluate(() => {
        const w = window as unknown as { __rafCalls: number; __origRaf: typeof requestAnimationFrame }
        w.__rafCalls = 0
        const orig = requestAnimationFrame.bind(window)
        w.__origRaf = orig
        window.requestAnimationFrame = (cb) => { w.__rafCalls++; return orig(cb) }
      })
      const s = await waitLive2dSettled(page)
      expect(s).toMatch(/就绪|回退/)
      await expect.poll(() => page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls), POLL).toBeGreaterThan(0)
      // 真实点击折叠按钮（aria-label 折叠角色栏）
      await page.getByRole('button', { name: '折叠角色栏' }).click()
      await expect.poll(() => page.locator('.cy-live').isVisible(), POLL).toBe(false) // v-show 隐藏
      await page.waitForTimeout(600)
      const rAfter = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      await page.waitForTimeout(800)
      const rLater = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      expect(rLater - rAfter).toBe(0) // 折叠后 rAF 不再调度新帧
      expect((await statusText(page)).length).toBeGreaterThan(0) // 面板仍在 DOM（隐藏态）
    } finally { await closeApp(launched) }
  })

  it('8.持久化：切换模型后重启 → 恢复所选模型', async () => {
    const ud = freshUserData()
    // 第一次 launch：切到 Wanko（SwiftShader 可渲染），持久化 modelId
    const launched1 = await launchL2d(ud)
    try {
      const { page } = launched1
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      // 等切换真正完成（ready · Wanko），而非启动即就绪的 Haru
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      // setLive2d 持久化 500ms 防抖 + settingsSave IPC——关闭前等 settings.json 真正落盘 modelId
      await expect.poll(() => {
        try {
          const s = JSON.parse(readFileSync(join(ud, 'Cyrene', 'config', 'settings.json'), 'utf8')) as { live2d?: { modelId?: string | null } }
          return s.live2d?.modelId ?? null
        } catch { return null }
      }, POLL).toBe(WANKO_ID)
    } finally { await closeApp(launched1, { keepUserData: true }) }
    // settings.json 已落 modelId=wanko（持久化证据，不经渲染）
    const settings = JSON.parse(readFileSync(join(ud, 'Cyrene', 'config', 'settings.json'), 'utf8')) as { live2d?: { modelId?: string | null } }
    expect(settings.live2d?.modelId).toBe(WANKO_ID)
    // 第二次 launch（复用同一 userData）：所选模型恢复
    const launched2 = await launchL2d(ud)
    try {
      const { page } = launched2
      await expect.poll(() => page.locator('.cy-live').count(), POLL).toBe(1)
      // 恢复所选模型：select 值回到 wanko（settings.modelId 驱动 store.init switchModel）
      await expect.poll(() => selectValue(page), POLL).toBe(WANKO_ID)
    } finally { await closeApp(launched2) }
  })

  it('9.appData 恒等（I2）：app.getPath(appData) → CLI resolveModelsDir 同 env 对齐', async () => {
    // V-04 说明：本用例是"镜像自检"（mirror self-check）——resolveModelsDir（scripts/live2d-install.mjs）是
    // expectedUserDataBase() 的镜像，platformEnv 也是 installModels() 装配夹具时用的同一 env 选择器。
    // 因此它验证的是两**镜像副本之间**的一致，而非独立验证真实 appData 路径——若 expectedUserDataBase 漂移
    // 但该镜像同步更新，本用例不会红。existsSync(haru/manifest.json) 是真实的文件系统事实，但该路径
    // 由同公式重算得出。读此 canary 的人不应误以为它能捕获真实 appData 路径漂移（只捕获镜像间漂移）。
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const appData = await launched.app.evaluate(({ app }) => app.getPath('appData'))
      // 以 app 实际 appData 为 env，重算 CLI 装配目标——防装配路径漂移。
      // flavor 传 'default'：集成 harness 跑 `--mode test`，Main 的 userData 也是无后缀的 `Cyrene`
      // （dev 后缀只对未打包 development 生效，见 docs/19）。
      const cliModels = resolveModelsDir({ ...platformEnv(appData), platform: process.platform }, 'default')
      expect(cliModels).toBe(join(appData, 'Cyrene', 'models'))
      // 该目录确实装着已装配模型
      expect(existsSync(join(appData, 'Cyrene', 'models', 'haru', 'manifest.json'))).toBe(true)
      // 开发隔离守卫：dev 风味必须落在**另一个**目录，否则 `pnpm dev` 会读到/写到正式版模型
      expect(resolveModelsDir({ ...platformEnv(appData), platform: process.platform }, 'dev'))
        .toBe(join(appData, 'Cyrene-Dev', 'models'))
      expect(cliModels).not.toBe(resolveModelsDir({ ...platformEnv(appData), platform: process.platform }, 'dev'))
    } finally { await closeApp(launched) }
  })

  it('10.asm.js 运行时探针（M5）：Live2DCubismCore 全局 + csmGetVersion()，无 wasm 资源', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      const probe = await page.evaluate(() => {
        const core = (window as unknown as Record<string, unknown>).Live2DCubismCore
        let version = -1
        try {
          const v = (core as { Version?: { csmGetVersion?: () => number } })?.Version?.csmGetVersion
          if (typeof v === 'function') version = v()
        } catch { /* 探针容错 */ }
        // 无 wasm 资源被加载（Core 为 asm.js 构建）
        const wasm = performance.getEntriesByType('resource')
          .filter((e) => (e as PerformanceResourceTiming).name.toLowerCase().includes('.wasm'))
          .length
        return { hasCore: typeof core === 'object' && core !== null, version, wasm }
      })
      expect(probe.hasCore).toBe(true)
      expect(typeof probe.version).toBe('number')
      expect(probe.version).toBeGreaterThan(0)
      expect(probe.wasm).toBe(0) // 无 WebAssembly 资源（asm.js，未放宽 wasm-unsafe-eval）
    } finally { await closeApp(launched) }
  })
})

describe('阶段5批次B Live2D Electron 集成（B7：切换竞态）', () => {
  it('B7.切换竞态：快速连续切换 → 最终渲染模型与 select 值、持久化 modelId 三方一致', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      const sel = page.locator('select[aria-label="选择 Live2D 模型"]')
      // 快速连续切换：wanko → 立即 haru（第二个大概率被 controller switching 串行守卫丢弃——D5B-10 生效 id 硬化路径）
      await sel.selectOption(WANKO_ID)
      await sel.selectOption('haru')
      // 等切换落地：状态含任一目标模型名（最终渲染 = 生效 id）
      await expect.poll(async () => {
        const st = await statusText(page)
        return /(Haru|Wanko)/.test(st)
      }, POLL).toBe(true)
      const st = await statusText(page)
      const target = st.includes('Wanko') ? WANKO_ID : 'haru'
      // select 值（= store.modelId）与实际渲染模型一致
      await expect.poll(() => selectValue(page), POLL).toBe(target)
      // 持久化生效 id 与 select 一致（500ms 防抖 + settingsSave 落盘）
      await expect.poll(() => readSettingsL2d(ud)?.modelId ?? null, POLL).toBe(target)
      // 实际渲染模型确实在画
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})
