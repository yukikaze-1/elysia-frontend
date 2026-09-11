// tests/integration/electron-live2d.spec.ts
// Task 7（阶段 5 批次 A / A7）：Electron 集成测试——Live2D 全链路验收（brief Step 2 十用例）。
// 覆盖：启动→右栏→list-models / 首帧 / 切换 / 损坏注入 / 协议安全 / 设备丢失 / 折叠停渲染 /
//       持久化重启 / appData 恒等(I2) / asm.js 探针(M5)。
//
// 装配策略（brief Step 1）：beforeAll 以 node --experimental-strip-types scripts/live2d-install.mjs
//   把 Haru（+ 修女莉尔 lil 若 tmp/live2d 存在）装进「master userData」（XDG_CONFIG_HOME 覆写，镜像
//   helpers/app.ts 的 appDataKey）。每用例 clone 一份 master 作独立 userData——损坏/切换/持久化互不污染。
//   重启用例单独复用同一 clone（closeApp keepUserData + launchApp opts.userData）。
//
// 纪律（对齐套件）：真实点击（locator.selectOption/click，无 force）、expect.poll 等待、
//   缺失元素以 count()===0 判、xvfb-run。WebGL 走 SwiftShader；首帧像素采样为「status=ready + 非透明像素」稳健形态。
//   若本环境 SwiftShader 采样得 0（preserveDrawingBuffer 时序），如实记录并回退 raf 帧计数为渲染证据（见报告）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, lstatSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'
import { resolveModelsDir } from '../../scripts/live2d-install.mjs'

const execFileP = promisify(execFile)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))        // apps/desktop
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))  // 仓库根
const CLI_SCRIPT = join(ROOT, 'scripts/live2d-install.mjs')
const CLI_ARGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', CLI_SCRIPT]
const HARU_SRC = join(REPO, 'third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
const LIL_SRC = join(REPO, 'tmp/live2d', '修女莉尔免费版', '修女莉尔免费版') // 用户模型双层目录（内层含 model3.json）
// 确定性切换目标：lil 的 8192px 大纹理超出 SwiftShader MAX_TEXTURE_SIZE（集成实测装载即失败），
// 故另装官方 Wanko（1024px，最小史样）作可靠 switch/持久化点击对象——如实记录于报告（偏离 brief 的切换目标选择）。
const WANKO_SRC = join(REPO, 'third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Samples/Resources/Wanko')
const WANKO_ID = 'wanko'

const POLL = { timeout: 8000, interval: 200 }

/** 镜像 helpers/app.ts 的 appDataKey 选择：env 指向 root 时装配目标 userData 根 */
function platformEnv(root: string): Record<string, string> {
  if (process.platform === 'win32') return { APPDATA: root }
  if (process.platform === 'darwin') return { HOME: root }
  return { XDG_CONFIG_HOME: root }
}

// —— 装配 ——
let masterDir = ''
let haruInstalled = false
let lilInstalled = false
let wankoInstalled = false

async function installModels(root: string): Promise<{ haru: boolean; lil: boolean; wanko: boolean }> {
  const env = { ...process.env, ...platformEnv(root) }
  const runCli = (args: string[]) => execFileP(process.execPath, [...CLI_ARGS, ...args], { env })
  await runCli(['--model-dir', HARU_SRC, '--id', 'haru', '--display-name', 'Haru'])
  await runCli(['--model-dir', WANKO_SRC, '--id', WANKO_ID, '--display-name', 'Wanko'])
  let lil = false
  if (existsSync(LIL_SRC)) {
    await runCli(['--model-dir', LIL_SRC, '--id', 'lil', '--display-name', '修女莉尔'])
    lil = true
  }
  return { haru: true, lil, wanko: true }
}

beforeAll(async () => {
  masterDir = mkdtempSync(join(tmpdir(), 'cy-l2d-master-'))
  const res = await installModels(masterDir)
  haruInstalled = res.haru
  lilInstalled = res.lil
  wankoInstalled = res.wanko
}, 120_000)

afterAll(() => {
  if (masterDir) { try { rmSync(masterDir, { recursive: true, force: true }) } catch { /* 尽力 */ } }
})

/** 递归 chmod 到 0700：cpSync 复制的顶层目录以默认 mode（0755&umask→0775）落盘，非源 0700——
 *  ensureUserDataDirs 要求 userData 基目录恰 0700（(mode&0o077)===0），否则抛 UserDataDirError → blocking 错误框挂死。
 *  装配目标 models 早已 0700，此处把基目录/子树统一收敛到 0700（安全前置，与真实装配 install 的内容一致）。 */
function chmodTree(p: string, mode: number): void {
  try { chmodSync(p, mode); lstatSync(p) } catch { /* 尽力 */ }
  for (const name of readdirSync(p)) {
    const child = join(p, name)
    try { if (lstatSync(child).isDirectory()) chmodTree(child, mode) } catch { /* 尽力 */ }
  }
}

/** 每用例独立 userData：clone master（含已装配模型），避免损坏/切换/持久化互污染 */
function freshUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'cy-l2d-ud-'))
  cpSync(masterDir, d, { recursive: true })
  chmodTree(d, 0o700) // cpSync 顶层目录 mode 漂移修复（见 chmodTree 注释）
  return d
}

/** 装配了模型 → 启动即 Live2D WebGL 初始化；强制 SwiftShader 软渲染（headless 下 radv/Vulkan 非 conformant
 *  会拖挂/超时）。extraArgs 对齐 electron-voice 先例（Chromium 开关附于 args 末尾）。env 为附加环境变量
 *  （批次 B：CYRENE_MOCK_EMIT_DELAY_MS 放宽 replay 间隔 / CYRENE_MOCK_GENERATION_EMOTION 情绪注入）。 */
function launchL2d(ud: string, env: Record<string, string> = {}): Promise<LaunchedApp> {
  return launchApp(undefined, { userData: ud, env, extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
}

// —— 渲染进程观测 ——

async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.cy-live-status')?.textContent ?? '')
}
async function selectValue(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector('select[aria-label="选择 Live2D 模型"]') as HTMLSelectElement | null)?.value ?? '')
}
/** 等 Live2D 状态落到终态（就绪/回退/失败）并返回其文案 */
async function waitLive2dSettled(page: Page): Promise<string> {
  await expect.poll(() => statusText(page), POLL).toMatch(/就绪|回退|失败/)
  return statusText(page)
}

/**
 * 等重建真正落终态。
 *
 * 2026-09-10 审查修复：GPU 丢失后**不能**直接用 `toMatch(/就绪|回退|失败/)` 等重建——`rebuildAfterLost()`
 * 在 await reset 之前就把 `status='fallback'` 同步镜像（live2d.store.ts:234），其文案「静态头像回退（GPU 不可用）」
 * 本身即匹配该正则，于是 poll 会在**第一次求值就通过**，12s 预算形同虚设，重建逻辑即使完全不工作也绿。
 * 这里改为「等到真正终态或超时」：`正在加载模型…`==reset 进行中（**不**匹配终态）→ 返回 null 继续重试。
 * 若 12s 内一直停在中间态，poll 会以 null 失败并打印该文案。
 */
async function waitLive2dTerminal(page: Page, timeout = 12000): Promise<string | null> {
  let last = ''
  await expect.poll(async () => {
    last = await statusText(page)
    return /就绪|回退|失败/.test(last) ? last : null
  }, { ...POLL, timeout }).not.toBeNull()
  return last
}

/** 连接 mock → 激活首个会话 → 输入框可用（「聊天可用」判据，对齐 electron-voice 先例） */
async function connectAndActivateFirst(page: Page): Promise<void> {
  // UII-QQ：连接钮收进连接入口 popover——先点徽标（REAL/MOCK）展开，再点连接（能力不删，入口变更）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? ''), POLL).toContain('流式回复演示')
  await expect.poll(() => page.evaluate(() => (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true)), POLL).toBe(false)
}

/** 采样画布非透明像素数（WebGL canvas 经 2D drawImage 读回；rAF 双帧后读，尽量避开 preserveDrawingBuffer 时序）。-1 = 无法采样 */
// V-04 说明：-1 是"采样失败"哨兵（无 .cy-live-canvas / 零尺寸 / getContext('2d') 为 null），与 "真空白 0" 是两种不同信号。
// 但所有消费方都用 `expect.poll(() => countNonTransparentPx(page), POLL).toBeGreaterThan(0)` ——-1 被 `toBeGreaterThan(0)`
// 折叠，采样失败与真空白不可区分（poll 不失败）。这是有意容忍：无 canvas 时等待中的就绪态不应误判为空画布失败。
// 若未来需要区分"采样失败"与"画布真空白"，应改用断言值 !== -1 或单独哨兵断言，而非现在的 toBeGreaterThan(0)。
async function countNonTransparentPx(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return -1
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const w = canvas.width, h = canvas.height
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(canvas, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n
  })
}

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
      // 以 app 实际 appData 为 env，重算 CLI 装配目标——防装配路径漂移
      const cliModels = resolveModelsDir({ ...platformEnv(appData), platform: process.platform })
      expect(cliModels).toBe(join(appData, 'Cyrene', 'models'))
      // 该目录确实装着已装配模型
      expect(existsSync(join(appData, 'Cyrene', 'models', 'haru', 'manifest.json'))).toBe(true)
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

/** 取 lil（若装配）的入口 moc 文件名（供损坏注入改 size） */
function lilModelFile(ud: string): string {
  const m = JSON.parse(readFileSync(join(ud, 'Cyrene', 'models', 'lil', 'manifest.json'), 'utf8')) as { modelFile: string }
  return m.modelFile
}

// —— 阶段 5 批次 B（B7）：表现集成 harness（状态驱动/动作播放/设置子页/性能模式/布局/切换竞态 ——

// —— 阶段 5 批次 C（C1）：TTS 音量口型集成（CYRENE_MOCK_MOUTH_LEVEL 合成包络源，确定性断言链路）——

/** 打开设置中心（.cy-settings 覆盖层出现） */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
}

/** 关闭设置中心（✕ 关闭按钮，确定性；对齐 electron-voice 先例） */
async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
}

describe('阶段5批次C Live2D Electron 集成（C1：TTS 音量口型）', () => {
  it('C1.口型链路：CYRENE_MOCK_MOUTH_LEVEL=step → 激活 TTS → 发送 → 口型电平随合成包络变化 → 停止归 0', async () => {
    const ud = freshUserData()
    // CI 稳健化（2026-08-19）：CYRENE_MOCK_MOUTH_WINDOW_MS=5000 把 mock 采样窗口从 1.5s 放宽到 5s——
    // 慢 CI（SwiftShader 渲染饱和）上 1.5s 窗口可能被口部采样错过；setInterval 采集器独立于 rAF，
    // 不受渲染饱和/页面 rAF 节流影响（rAF 采集器曾只采到 13 帧即停）。
    const launched = await launchL2d(ud, { CYRENE_MOCK_MOUTH_LEVEL: 'step', CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_MOUTH_WINDOW_MS: '5000' })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 探针必须暴露（dev/test 构建经 window.__cyreneTest.getMouthLevel 读 store.mouthLevel）
      const probe = await page.evaluate(() =>
        typeof (window as unknown as { __cyreneTest?: { getMouthLevel?: () => number } }).__cyreneTest?.getMouthLevel)
      expect(probe).toBe('function')
      await connectAndActivateFirst(page)
      // 激活 TTS Profile（mock ttsActive = !!activeSelection.ttsProfileId → generation.completed 才发 audio.session.ready）
      await openSettings(page)
      await page.getByRole('tab', { name: 'TTS', exact: true }).click()
      const edgeCard = page.locator('.cy-profile-card[data-profile-id="edge/edge-tts"]')
      await expect.poll(() => edgeCard.count(), POLL).toBe(1)
      await edgeCard.getByRole('button', { name: '设为当前', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cy-profile-card[data-profile-id="edge/edge-tts"] .cy-profile-current').length), POLL).toBe(1)
      await closeSettings(page)
      // 发送 → generation.completed → audio.session.ready → tts.playing=true → attach → tick 采样 step 序列
      await sendChat(page, 'mouth')
      // 断言：口部曾随合成包络非零（moved）且窗口结束归零（settled）——轮询**持久标志**而非瞬态采样。
      // 根因（2026-08-19 CI 第 4 轮）：SwiftShader 渲染饱和 renderer 主线程，page.evaluate 慢到 ~3.75s/次
      // （15s 只取到 4 个读值），瞬态窗口采样全漏；持久标志由 tick 写入（tick 即饱和源、恒运行），
      // 外部慢轮询几次即读到。附带断言 kind=step（mockMouthLevel 水合生效）——排除真实 Analyser 读静音。
      try {
        await expect.poll(async () => {
          const m = await page.evaluate(() =>
            (window as unknown as {
              __cyreneTest?: { getMouthInfo: () => { kind: 'step' | 'sine' | 'real' | null; moved: boolean; settled: boolean } }
            }).__cyreneTest?.getMouthInfo?.() ?? null)
          return m !== null && m.kind === 'step' && m.moved && m.settled
        }, { ...POLL, timeout: 15000 }).toBe(true)
      } catch (e) {
        // DEBUG：超时转储 voiceStore.tts 态 + 口部源/标志 + 当前电平 + 页面可见性（定位链路断点）
        const dump = await page.evaluate(() => {
          const el = document.querySelector<HTMLAudioElement>('audio.cy-tts-player')
          const t = (window as unknown as {
            __cyreneTest?: {
              getTtsState?: () => {
                url: string | null
                playing: boolean
                playingStreamId: number | null
                readySeen: boolean
                autoReadReply: boolean
                ttsAudioElPresent: boolean
              }
              getMouthInfo?: () => { kind: 'step' | 'sine' | 'real' | null; moved: boolean; settled: boolean }
              getMouthLevel?: () => number
            }
          }).__cyreneTest
          return {
            audio: { src: el?.getAttribute('src') ?? null, paused: el?.paused ?? null },
            voice: t?.getTtsState?.() ?? null,
            mouth: t?.getMouthInfo?.() ?? null,
            mouthLevel: t?.getMouthLevel?.() ?? null,
            visibility: document.visibilityState
          }
        })
        console.log('C1 DEBUG state:', JSON.stringify(dump))
        throw e
      }
    } finally { await closeApp(launched) }
  })
})

/** 状态徽标文案（.cy-live-badge，形如「状态：思考中」） */
async function badgeText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.cy-live-badge')?.textContent ?? '')
}

/** 连接 + 激活会话后经 UI 发送一条文本消息（mock 随即回放 generation 夹具 → 状态驱动/动作播放数据源） */
async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('textarea[aria-label="消息输入框"]').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

/**
 * 打开设置中心 → 「外观与 Live2D」子页（CyLive2DPane）。
 *
 * 2026-09-10 修复：本 helper 原用 `角色与外观`，而 `3afc4de`（feat(character): add identity and
 * character management UI）已把设置导航项改名为 `外观与 Live2D`（CySettingsView.vue NAV_ITEMS）。
 * 改名是有意的，且被单测锁定：cy-settings-character-nav.spec.ts 断言文本**包含** `外观与 Live2D`
 * 且**不包含** `角色与外观`。本 spec 停留在旧名 → Playwright 找不到元素 → 30s 超时，
 * 连带 B4/B5/C2.1/恢复默认/禁用启用 共 5 个用例长期红灯。注意 getByRole 严格模式也不会误配：
 * 邻近的「角色」按钮 name 恰为「角色」，与旧名不同。
 */
async function openCharacterPane(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
  await page.getByRole('button', { name: /外观与 Live2D/ }).click()
  await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
}

/** 读 settings.json 的 live2d 子树（文件缺失/暂未落盘 → null，供 expect.poll 等待持久化） */
function readSettingsL2d(ud: string): { modelId: string | null; scale?: number; offsetX?: number; performanceMode?: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(ud, 'Cyrene', 'config', 'settings.json'), 'utf8')) as {
      live2d?: { modelId?: string | null; scale?: number; offsetX?: number; performanceMode?: string }
    }
    return {
      modelId: s.live2d?.modelId ?? null,
      scale: s.live2d?.scale,
      offsetX: s.live2d?.offsetX,
      performanceMode: s.live2d?.performanceMode
    }
  } catch { return null }
}

/** 预置 settings.json（性能模式旧值 'high' 读回归一用例；缺字段时间必须补全，否则 settings-service 判定
 *  corrupt 全量重置——voice/dictation/live2d 全字段镜像 DEFAULT_SETTINGS） */
function presetSettings(ud: string, live2dPatch: Record<string, unknown> = {}): void {
  const dir = join(ud, 'Cyrene', 'config')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const settings = {
    version: 1,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
    dictation: { insertMode: 'append' },
    live2d: {
      enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
      mouseTracking: true, autoMotions: true, lipSync: true,
      performanceMode: 'auto', reduceMotion: false,
      ...live2dPatch
    }
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
}

describe('阶段5批次B Live2D Electron 集成（B7：状态驱动/动作/设置/性能/布局/竞态）', () => {
  it('B1.状态驱动：发送消息 → 徽标「思考中」→「说话中」→「空闲」（真实 DOM）', async () => {
    // 放宽 mock replay 事件间隔：thinking/speaking 窗口在 200ms 轮询下可稳定捕获（缺省 30ms 会被漏掉）
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400' })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      // 连接后业务态 idle（徽标「空闲」；未连接前为 offline「未连接」）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      // generation.started → thinking（「思考中」）；首个公众正文 delta → speaking（「说话中」）
      await sendChat(page, '你好')
      await expect.poll(() => badgeText(page), POLL).toContain('思考中')
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      // generation.completed → 回 idle（默认夹具 emotion='thinking' 非已知 mood → 被状态源忽略，不回情绪态）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
    } finally { await closeApp(launched) }
  })

  it('B2.动作播放：Haru（有动作）speaking → 画布非空无错误；lil（无动作）切换优雅不崩、聊天可用', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '300' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      if (haruInstalled) {
        // B3 路径：有动作模型，指定切到 Haru 后触发 speaking → 帧推进、画布非空
        await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
        await expect.poll(() => statusText(page), POLL).toContain('Haru')
        await connectAndActivateFirst(page)
        await sendChat(page, 'haru speaking')
        await expect.poll(() => badgeText(page), POLL).toContain('说话中')
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      }
      if (lilInstalled) {
        // B4 路径：无动作模型。lil 的 8192px 大纹理超 SwiftShader MAX_TEXTURE_SIZE（批次 A 已实测装载即失败）——
        // 本环境断言「切换不崩 + 优雅保留原模型 + 聊天可用」；参数级回退的正向断言由单测（live2d-controller B4）
        // 覆盖。若其他环境 lil 可渲染，则补强画布断言。
        await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('lil')
        await expect.poll(() => statusText(page), POLL).toMatch(/就绪|回退|失败/)
        if ((await statusText(page)).includes('修女莉尔')) {
          await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
        }
      }
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('B3.情绪态→表情：mock emotion=happy → 徽标「开心」+ 画布非空 + 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_GENERATION_EMOTION: 'happy' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, 'happy')
      // 流式 speaking → completion(emotion=happy) → 情绪态「开心」（~2s 后 mood 超时回空闲）
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 情绪态期间渲染不中断（Haru F01 表情 setExpression 进入——白名单内）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('F-1.中文 mood 归一：mock emotion=开心 → 徽标「开心」+ 画布非空 + 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_GENERATION_EMOTION: '开心' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, '开心')
      // 流式 speaking → completion(emotion=开心) → normalizeEmotionCode 归一 happy → 情绪态「开心」
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 情绪态期间渲染不中断（Haru F01 表情 setExpression 进入——白名单内）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('B4.设置子页：改 scale/performanceMode → 即时生效 + 重启后持久化恢复', async () => {
    const ud = freshUserData()
    // 第一次 launch：设置页调 scale=1.5、performanceMode=balanced（设置即时改 + 500ms 防抖持久化）
    const launched1 = await launchL2d(ud)
    try {
      const { page } = launched1
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      // scale 滑块（表现组首个 range = 大小）→ 设置即时更新（Pane 字段值即刻变化）。
      // B4 滑块以 evaluate 合成事件（直接置 value + dispatch input/change）驱动——headless SwiftShader 下
      // Playwright 的 range 真实拖拽（dragTo/键盘箭头）依赖可见指针命中测试且帧时序不可控，合成事件与真实
      // 滑块在 Vue 的 @input 绑定上等价（同一 setLive2d patch 路径），足够断言「即时预览 + 持久化」链路。
      // V-05 补注：① 组件（CyLive2DPane.vue）故意用 `:value` + `@input` 而非 v-model——因此裸 evaluate 置 value 后
      // 必须显式 dispatch 'input' 才会走 onSlider → setLive2d 即时预览；② 'input' 与 'change' 是两个不同监听器：
      // 'input' 满足 @input（即时预览，onSlider），'change' 满足即时预览之外的持久化/失焦路径——两者都 dispatch 才能
      // 覆盖「即时生效」与「落盘持久化」两条链（单发 'input' 或单发 'change' 都会漏另一条链）。
      await page.locator('.cy-l2d-pane input[type="range"]').first().evaluate((el) => {
        const input = el as HTMLInputElement
        input.value = '1.5'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-l2d-pane .cy-l2d-field-value')?.textContent ?? ''), POLL).toContain('1.50')
      // 帧率模式下拉 → 设置即时更新
      await page.locator('.cy-l2d-pane select').selectOption('balanced')
      await expect.poll(() => page.locator('.cy-l2d-pane select').inputValue(), POLL).toBe('balanced')
      // 关闭设置 → chat 视图重挂载（Panel 重 init 读最新 settings 应用视图变换）。
      // UII-Live2D 修缮：画布顶部滑块组（.cy-live-view-controls）已移除、视图操作改为画布拖动/滚轮直接操作，
      // 面板侧不再有 scale DOM 读数——「即时生效」以设置页字段值（上方 1.50 断言）+ 视图变换转发单测为准。
      await page.getByRole('button', { name: '关闭设置' }).click()
      await waitLive2dSettled(page)
      // 500ms 防抖 + settingsSave → settings.json 落盘
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ scale: 1.5, performanceMode: 'balanced' })
    } finally { await closeApp(launched1, { keepUserData: true }) }
    const persisted = readSettingsL2d(ud)
    expect(persisted?.scale).toBe(1.5)
    expect(persisted?.performanceMode).toBe('balanced')
    // 第二次 launch（复用同一 userData）：设置恢复
    const launched2 = await launchL2d(ud)
    try {
      const { page } = launched2
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-l2d-pane .cy-l2d-field-value')?.textContent ?? ''), POLL).toContain('1.50')
      await expect.poll(() => page.locator('.cy-l2d-pane select').inputValue(), POLL).toBe('balanced')
    } finally { await closeApp(launched2) }
  })

  it('B5.性能模式：四值下拉存在、选中持久化、旧值 high 读回归一（不 corrupt）', async () => {
    const ud = freshUserData()
    presetSettings(ud, { performanceMode: 'high' }) // 批次 A 旧三值 → 读回归一 quality
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 不 corrupt：无 .corrupt 备份 + 原文件仍存在
      expect(existsSync(join(ud, 'Cyrene', 'config', 'settings.json.corrupt'))).toBe(false)
      await openCharacterPane(page)
      const pmSelect = page.locator('.cy-l2d-pane select')
      // 四值下拉：auto/quality/balanced/low_power
      const options: string[] = await pmSelect.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
      expect(options.sort()).toEqual(['auto', 'balanced', 'low_power', 'quality'])
      // 旧值 'high' 已归一为 'quality'（内存态，setting pane 绑定 settings.live2d.performanceMode）
      await expect.poll(() => pmSelect.inputValue(), POLL).toBe('quality')
      // 选中持久化
      await pmSelect.selectOption('low_power')
      await page.getByRole('button', { name: '关闭设置' }).click()
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ performanceMode: 'low_power' })
    } finally { await closeApp(launched) }
  })

  it('B6.布局：无 Layout 模型画幅均正常（默认 + switch 到 wanko 后 canvas 均非空）', async () => {
    // 本仓装配模型（haru/wanko/lil）均无 model3 Layout → 走 scale-only 拟合（批次 A 路径）；
    // 有 Layout fixture 的 setupFromLayout 拟合由单测（live2d-adapter.spec 夹具）覆盖。
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })

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

// —— 阶段 5 批次 C（C2）：性能降级（FrameBudget 四值消费）+ GPU 重建一次 + 可见性收口 ——

describe('阶段5批次C Live2D Electron 集成（C2：性能降级 + GPU 重建 + 可见性）', () => {
  it('C2.1.性能模式四值切换：low_power 降帧切换后渲染不崩 + 设置持久化', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      const pmSelect = page.locator('.cy-l2d-pane select')
      // 四值依次切换 → 渲染不崩（FrameBudget setMode 热切换；集成仅断言无回归，时序语义由 perf.spec 覆盖）
      for (const mode of ['quality', 'balanced', 'low_power', 'auto']) {
        await pmSelect.selectOption(mode)
        await expect.poll(() => pmSelect.inputValue(), POLL).toBe(mode)
      }
      // 落 low_power → 关闭设置 → 渲染仍正常（就绪 + 画布非空；或静态回退不崩）
      await pmSelect.selectOption('low_power')
      await page.getByRole('button', { name: '关闭设置' }).click()
      await waitLive2dSettled(page)
      const s = await statusText(page)
      if (s.includes('就绪')) {
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      }
      // 500ms 防抖 + settingsSave → settings.json 落盘 performanceMode=low_power
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ performanceMode: 'low_power' })
    } finally { await closeApp(launched) }
  })

  it('C2.2.GPU 丢失重建一次：webglcontextlost → 重建（回到就绪+渲染恢复，或回退不崩）+ 聊天可用', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 触发 webglcontextlost → adapter gpuLost → 渲染 tick 抛 Live2DGpuLostError → device_lost → store 重建
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
        const gl = canvas?.getContext('webgl') ?? canvas?.getContext('webgl2')
        const ext = gl?.getExtension('WEBGL_lose_context')
        ext?.loseContext()
      })
      // 重建一次：等真正落终态（就绪=重建成功 / 回退=重建失败，SwiftShader 下均合法）；「一次」由单测 guard 覆盖，
      // 集成以「不崩 + 状态机合法」为准（brief Step 7）。终态文案在此确定读取，供下面的像素分支使用。
      const s = await waitLive2dTerminal(page) ?? (await statusText(page))
      if (s.includes('就绪')) {
        // 重建成功 → 渲染恢复（非透明像素重新出现）
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 8000 }).toBeGreaterThan(0)
      }
      await connectAndActivateFirst(page) // 重建不阻塞聊天
    } finally { await closeApp(launched) }
  })
})

// —— 阶段 5 批次 C（C3）：后端 live2d.directive 指令消费（CYRENE_MOCK_DIRECTIVE）——

describe('阶段5批次C Live2D Electron 集成（C3：live2d.directive 指令消费）', () => {
  it('C3.1.指令 happy+F01：generation.completed 后徽标「开心」+ 表情被消费（画布非空）+ 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"happy","expression":"expressions/F01.exp3.json","priority":1}'
    })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive happy')
      // 流式 speaking → completion 后指令(state=happy) → 情绪态「开心」（指令瞬态 ~2s）
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 指令 expression F01 命中白名单 → 表情被消费（startExpression → 渲染不中断）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('C3.2.指令非白名单 expression：不崩 + 脱敏 warn（directive_miss，不记 payload 原文）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"happy","expression":"expressions/evil.exp3.json","priority":1}'
    })
    const warns: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive miss')
      // generation.completed 后指令消费 → expression 未命中白名单 → 脱敏 warn（code=directive_miss）
      await expect.poll(() => warns.some((w) => w.includes('directive_miss')), POLL).toBe(true)
      // 脱敏：warn 不记 payload 原文（evil 路径不得出现）
      expect(warns.some((w) => w.includes('expressions/evil.exp3.json'))).toBe(false)
      // 聊天仍可用（不崩）
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('C3.3.指令 state:working（越界）→ env 解析缺省不发射（无指令、不崩、聊天可用）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"working","expression":"expressions/F01.exp3.json","priority":1}'
    })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive working')
      // 等 generation.completed 完成（指令应不发射——working 非七值，parseMockDirectiveEnv 拒）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })
})

// —— 阶段 5 批次 C（收口回归：Task5 M2 restore 分叉）——

describe('阶段5批次C Live2D Electron 集成（收口回归：恢复默认 → 画布与持久化一致）', () => {
  it('恢复默认设置：已加载非首个模型 → 切回首个可用（画布/select/持久化三方一致）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 切到非首个模型 wanko（haru = 首个可用）→ 已加载 ≠ 首个可用，持久化 wanko
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      await expect.poll(() => readSettingsL2d(ud)?.modelId ?? null, POLL).toBe(WANKO_ID)
      // 打开设置子页 → 恢复默认设置（7D 起面板常驻挂载且 ready → store.restoreDefaults 走 controller 存活
      // 分支：settings 打开时即 switchModel 首个可用；关闭设置后画布/select/持久化一致）
      await openCharacterPane(page)
      await page.getByRole('button', { name: '恢复默认设置' }).click()
      await page.getByRole('button', { name: '关闭设置' }).click()
      // 切回首个可用 Haru：画布状态含 Haru（switchModel 完成）
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      // select 值与持久化 modelId 三方一致（500ms 防抖 + settingsSave 落盘）
      await expect.poll(() => selectValue(page), POLL).toBe('haru')
      await expect.poll(() => readSettingsL2d(ud)?.modelId ?? null, POLL).toBe('haru')
      // 画布非空（切回首个可用渲染正常）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})

// —— 阶段 7 批次 D（Task 4）：Live2D 数值读数接入诊断页（FrameBudget.getStats 透传，闭合 D7A-06）——

describe('阶段7批次D Live2D Electron 集成（7D：Live2D 数值读数接入诊断页）', () => {
  it('诊断页 Live2D 性能：Live2D 面板常驻挂载，设置打开仍显示真实帧耗时/帧率读数', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page) // chat 视图 Live2D 就绪（settings 未打开）
      // 打开设置 → 开发与诊断 → 开开发者模式（confirm 处理）
      page.on('dialog', (d) => d.accept())
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
      // 7D：面板不随 chat 卸载——设置打开后仍 ready，但 v-show 隐藏（rAF 由 currentView gate 停止）
      await expect.poll(() => page.locator('.cy-live').count(), POLL).toBe(1)
      await expect(page.locator('.cy-live').isVisible()).resolves.toBe(false)
      await expect.poll(() => statusText(page), POLL).toContain('就绪')
      await page.locator('.cy-settings-nav-item', { hasText: '开发与诊断' }).click()
      await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
      await page.locator('button[data-testid="diag-dev-toggle"]').click()
      // settings 打开但 store 保持 ready → getStats 非 null → 显示真实帧读数（模式/帧耗时 EMA）
      await expect.poll(() => page.getByTestId('diag-dev-perf').textContent(), POLL).toMatch(/帧耗时（EMA）：\d+(\.\d+)? ms/)
      expect(await page.getByTestId('diag-dev-perf').textContent()).toContain('模式：')
    } finally { await closeApp(launched) }
  })

  it('禁用/启用 Live2D：常驻面板立即 dispose/重载，诊断页读数随 status 切换（未启动 ↔ 帧读数）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      // 关闭启用开关 → 面板常驻但立即 dispose（7D 补上的原「settings 卸载即释放」语义）
      await page.locator('.cy-l2d-pane input[type="checkbox"]').first().uncheck()
      await expect.poll(() => statusText(page), POLL).toContain('已关闭')
      // 诊断页此刻应显示未启动（store.status=unloaded → getStats null）
      await page.locator('.cy-settings-nav-item', { hasText: '开发与诊断' }).click()
      await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
      page.on('dialog', (d) => d.accept())
      await page.locator('button[data-testid="diag-dev-toggle"]').click()
      await expect.poll(() => page.getByTestId('diag-dev-perf').textContent(), POLL).toMatch(/未启动|无读数/)
      // 重新启用 → 面板隐藏态也能 init → ready（关闭设置后 rAF 恢复、画布非空）
      await page.locator('.cy-settings-nav-item', { hasText: '外观与 Live2D' }).click()
      await page.locator('.cy-l2d-pane input[type="checkbox"]').first().check()
      await expect.poll(() => statusText(page), POLL).toContain('就绪')
      await closeSettings(page)
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})
