// tests/integration/dev-form-renderer.spec.ts
// 门禁判别力批次（M-29 / P2-5）：**dev 形态**集成覆盖——页面由 Vite dev server 供给（`http://127.0.0.1:<port>`），
// 而不是 `cyrene://renderer`。
//
// 为什么这是本项目最该补的一条盲区：
//   在 2026-09-10 之前，集成套件**全部**运行 prod 形态（tests/integration/helpers/app.ts 无条件删除
//   `ELECTRON_RENDERER_URL`）。于是"只在 dev 可达"的整类回归零覆盖——其中一条真的发生了：用户在 `pnpm dev`
//   下看到 Live2D「模型加载失败 / 原因：Failed to fetch」，同时面板又显示「已发现 3 个模型，其中可用 3 个」。
//   根因是 dev 页面在 `http://localhost:<port>`，而模型文件只在 `cyrene://renderer` 上供给，`cyrene` scheme
//   恒 `corsEnabled:false`（阶段 5 D-4 安全结论）→ 跨源 fetch 被 Chromium 拒绝。该限制自阶段 5 起记录在案
//   却从未被测到，因为它只在 dev 形态出现。
//
// 本 spec 因此不只断言"dev 形态能跑"，而是把**根因与修法成对钉住**：
//   ① 页面确实来自 dev server（否则整份 spec 会悄悄退化成第二次 prod 覆盖——这正是当初的失效模式）；
//   ② `cyrene://` 跨源 fetch **仍然被拒**（根因没被谁顺手放开），而同一批字节经 IPC 供给**成功**且与磁盘逐字节一致；
//   ③ dev CSP 响应头存在且真的生效（`frame-ancestors` 只能走响应头，meta 不支持）；
//   ④ `/@fs`、`/@vite` 同源导航被拒（含 `%40fs` 编码绕过形态）；
//   ⑤ 端到端：Live2D 在 dev 形态走到**就绪**——这条是用户可见口径，②③④ 都是它的分解。
//
// 形态差异的忠实性说明（诚实标注）：本 spec 的 main/preload 来自 `--mode test` 构建（`pnpm test:integration`
// 入口自带），而运行时 renderer 由 dev server 以 mode=development 供给。`__APP_MODE__` 只影响
// `resolveAppConfig` 的日志级别与 `resolveTestAppDataOverride` 的 harness 门（src/main/config/index.ts:11、
// src/main/app/test-app-data.ts:21）；决定"是否使用 dev server"的 `shouldUseViteDevServer` 只看
// `app.isPackaged` + `ELECTRON_RENDERER_URL`（src/main/config/env.ts:37-43），与 mode 无关。
// 因此本 spec 覆盖的正是 dev 形态的加载/来源/供给/CSP/导航谓词，差异面仅日志级别与 appData 门（后者是
// 测试隔离所必需，且它自己被 test-app-data 单测覆盖）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, rmSync, mkdtempSync, readFileSync, chmodSync, readdirSync, lstatSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { launchAppDev, closeApp, type LaunchedApp } from './helpers/app'
import { startRendererDevServer, type RendererDevServer } from './helpers/renderer-dev-server'

const execFileP = promisify(execFile)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))        // apps/desktop
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))  // 仓库根
const CLI_SCRIPT = join(ROOT, 'scripts/live2d-install.mjs')
const CLI_ARGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', CLI_SCRIPT]
// 只装官方 Wanko：1024px 纹理，SwiftShader 下可渲染（Haru 亦可，lil 的 8192px 超 MAX_TEXTURE_SIZE 装载即失败）。
// 本 spec 验的是**供给通路**而非模型规模，故取最小可用样本以压住耗时。
const WANKO_SRC = join(REPO, 'third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Samples/Resources/Wanko')
const WANKO_ID = 'wanko'
const MODEL_FILE = 'model3.json'

const POLL = { timeout: 8000, interval: 200 }
/** 首帧预算放宽：dev server 首次请求要现场编译 renderer + 预打包依赖，比 prod 形态慢 */
const READY_POLL = { timeout: 30_000, interval: 250 }

/** 镜像 helpers/app.ts 的 appDataKey 选择：env 指向 root 时装配目标 userData 根（download 侧同款公式） */
function platformEnv(root: string): Record<string, string> {
  if (process.platform === 'win32') return { APPDATA: root }
  if (process.platform === 'darwin') return { HOME: root }
  return { XDG_CONFIG_HOME: root }
}

let devServer: RendererDevServer
let masterDir = ''
let launched: LaunchedApp

/** 递归 chmod 0700：cpSync 复制出的顶层目录 mode 与源不同，ensureUserDataDirs 会因 (mode&0o077)!==0 拒绝启动 */
function chmodTree(p: string, mode: number): void {
  try { chmodSync(p, mode); lstatSync(p) } catch { /* 尽力 */ }
  for (const name of readdirSync(p)) {
    const child = join(p, name)
    try { if (lstatSync(child).isDirectory()) chmodTree(child, mode) } catch { /* 尽力 */ }
  }
}

beforeAll(async () => {
  devServer = await startRendererDevServer()

  masterDir = mkdtempSync(join(tmpdir(), 'cy-devform-master-'))
  await execFileP(
    process.execPath,
    // `--user-data default`：本 spec 的 app 跑 `--mode test`，userData 是 `<tmp>/Cyrene`（dev 后缀只对未打包
    // development 生效，见 docs/19）；CLI 缺省装到 Cyrene-Dev，不显式对齐就会克隆出一份 app 读不到的模型。
    [...CLI_ARGS, '--user-data', 'default', '--model-dir', WANKO_SRC, '--id', WANKO_ID, '--display-name', 'Wanko'],
    { env: { ...process.env, ...platformEnv(masterDir) } }
  )

  const ud = mkdtempSync(join(tmpdir(), 'cy-devform-ud-'))
  cpSync(masterDir, ud, { recursive: true })
  chmodTree(ud, 0o700)
  // SwiftShader 软渲染：headless 下 radv/Vulkan 非 conformant 会拖挂 Live2D 首帧
  launched = await launchAppDev(devServer.url, undefined, {
    userData: ud,
    extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
}, 180_000)

afterAll(async () => {
  if (launched) await closeApp(launched)
  if (devServer) await devServer.close()
  if (masterDir) { try { rmSync(masterDir, { recursive: true, force: true }) } catch { /* 尽力 */ } }
})

async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.cy-live-status')?.textContent ?? '')
}

describe('dev 形态（Vite dev server 供给页面）', () => {
  it('① 页面确实来自 dev server —— 否则整份 spec 会退化成第二次 prod 覆盖', async () => {
    const { app, page } = launched
    // 三面独立取证：Playwright 看到的 URL、renderer 自己的 location.origin、Main 眼里的 webContents URL
    expect(page.url().startsWith(devServer.url), `page.url()=${page.url()}`).toBe(true)
    expect(await page.evaluate(() => location.origin)).toBe(devServer.url)
    const mainView = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? '')
    expect(mainView.startsWith(devServer.url), `Main 侧 webContents URL=${mainView}`).toBe(true)
    // 反向证据：不是 cyrene:// 形态（若此项为 true，说明 dev env 没生效，下面的供给断言全都测错了形态）
    expect(mainView.startsWith('cyrene://')).toBe(false)
  })

  it('② 根因仍在（cyrene:// 跨源 fetch 被拒），而修法生效（IPC 供给同字节）', async () => {
    const { page } = launched
    // 根因：dev 页面 fetch cyrene:// 必被拒（跨源 + scheme corsEnabled:false，且 dev CSP connect-src 不含 cyrene:）
    const viaNativeFetch = await page.evaluate(async () => {
      try {
        const r = await fetch('cyrene://renderer/__cyrene-live2d/wanko/model3.json')
        return { kind: 'ok' as const, status: r.status }
      } catch (err) {
        return { kind: 'rejected' as const, message: String(err) }
      }
    })
    expect(viaNativeFetch.kind, `原生 fetch 竟然成功了：${JSON.stringify(viaNativeFetch)}——若这是有意放开 CORS 的结果，请同步更新本 spec 与 doc 07/17 的安全结论`).toBe('rejected')

    // 修法：同一批字节经 IPC 供给通道返回，且内容与磁盘逐字节一致
    const viaIpc = await page.evaluate(async () => {
      const r = await window.desktopApi.readLive2dModelFile('wanko', 'model3.json')
      if (!r.ok) return { ok: false as const, status: r.status }
      const bytes = new Uint8Array(r.bytes)
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { Version?: number; FileReferences?: { Moc?: string } }
      return { ok: true as const, mime: r.mime, size: bytes.length, version: parsed.Version, moc: parsed.FileReferences?.Moc ?? '' }
    })
    expect(viaIpc.ok, `IPC 供给失败：${JSON.stringify(viaIpc)}`).toBe(true)
    if (!viaIpc.ok) return
    expect(viaIpc.version).toBe(3)              // Cubism model3.json 的 Version 字面量：证明是真模型定义，不是空壳/错误页
    expect(viaIpc.moc).toBeTruthy()
    expect(viaIpc.mime).toContain('json')

    const onDisk = readFileSync(join(launched.userData, 'Cyrene', 'models', WANKO_ID, MODEL_FILE))
    expect(viaIpc.size, 'IPC 返回的字节数与 userData 中的模型文件不一致').toBe(onDisk.byteLength)
  })

  it('②b 供给通道的门禁在 dev 形态同样生效（与协议通道共用 serve-gate）', async () => {
    const { page } = launched
    const matrix = await page.evaluate(async () => {
      const traversal = await window.desktopApi.readLive2dModelFile('wanko', '../../../../etc/passwd')
      const unknownModel = await window.desktopApi.readLive2dModelFile('no-such-model', 'model3.json')
      const malformedId = await window.desktopApi
        .readLive2dModelFile('..', 'model3.json')
        .then(() => 'resolved')
        .catch((e: unknown) => String(e))
      return { traversal, unknownModel, malformedId }
    })
    expect(matrix.traversal).toMatchObject({ ok: false, status: 403 })    // 越界 relPath
    expect(matrix.unknownModel).toMatchObject({ ok: false, status: 404 }) // 未注册 modelId
    expect(matrix.malformedId).toMatch(/^\w*(Error|error)/)               // modelId 收窄在请求 schema 层
  })

  it('③ dev CSP 响应头存在且真的生效', async () => {
    const { page } = launched
    // 中间件对**全部**响应注入（electron.vite.config.ts devCspPlugin），取文档响应核对
    const res = await fetch(`${devServer.url}/index.html`)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp, 'dev server 未返回 CSP 响应头（中间件失效？）').not.toBe('')
    expect(csp).toContain("frame-ancestors 'none'")   // 只能经响应头，meta 不支持——它的存在即证明走的是真中间件
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("'unsafe-eval'")
    // 逐指令核对（不能整串 not.toContain）：2026-09-10 只从 **connect-src** 去掉了 cyrene:，
    // img-src/media-src 保留 cyrene: 是**有意**的——dev 页面在 http://127.0.0.1，媒体经
    // `cyrene://renderer/__cyrene-media` 以**元素加载**（非 fetch）供给。整串断言会把这条正确设计判红。
    const directive = (name: string): string => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''
    expect(directive('connect-src'), 'dev 下已无任何 fetch 指向 cyrene://，connect-src 不应再放行它').not.toContain('cyrene:')
    expect(directive('img-src')).toContain('cyrene:')
    expect(directive('media-src')).toContain('cyrene:')
    expect(directive('connect-src')).toContain("'self'")

    // 生效性（不是"有头就算过"）：无 unsafe-eval ⇒ 页面**自己**插入的内联脚本必须被拒。
    //
    // 方法论陷阱（本轮实测踩到，勿再用错判据）：**不能用 `page.evaluate(() => new Function(...))` 探测 CSP**——
    // Playwright 的 evaluate 经 CDP `Runtime.evaluate` 下发，等同 DevTools 控制台求值，**不受页面 CSP 约束**，
    // 于是无论 CSP 在不在都会得到 "allowed"（本轮第一版就是这么写的，实测 'allowed'）。
    // 有效判据必须是**页面自己发起**的动作：这里用 DOM 插入内联 <script>——内联脚本在插入时同步执行，
    // 故插入后立即读哨兵即可判定，无需任何等待。
    const inlineScriptProbe = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const s = document.createElement('script')
      s.textContent = 'window.__cyCspInlineRan = true'
      document.head.appendChild(s)
      // 同步读：CSP 放行则脚本已执行；被拒则哨兵始终不存在
      return w['__cyCspInlineRan'] === true ? 'allowed' : 'blocked'
    })
    expect(inlineScriptProbe, 'CSP 存在但未生效：内联脚本竟然执行了（响应头没作用到本页面）').toBe('blocked')
  })

  it('④ 端到端：Live2D 在 dev 形态加载成功（用户可见口径）', async () => {
    const { page } = launched
    await expect.poll(() => page.locator('.cy-live').count(), POLL).toBe(1)
    // 判据与 electron-live2d.spec.ts 的 prod 形态用例同款：**就绪或静态回退**都算装载成功，
    // 「失败」才是本 spec 要拦的（CI 的 SwiftShader 可能只到回退，严谨的 就绪-only 会在 CI 上假红）。
    // 判别力不受影响：供给通路断掉时状态文案是「Failed to fetch」（属失败态，既非就绪也非回退），
    // 变异验证实测该断言红于 'Failed to fetch'（见 doc 16 §3.1）。
    await expect.poll(() => statusText(page), READY_POLL).toMatch(/就绪|回退/)
    expect(await statusText(page)).not.toMatch(/失败/)
  })

  // 放在最后：本用例会主动尝试导航，一旦被放行就会离开应用文档——排在后面会让"页面没了"污染其余用例的
  // 失败签名（变异验证实测：移除 deny 分支时本条与后面的 Live2D 用例一起红，噪声更大）。破坏性用例排末位。
  it('⑤ /@fs 与 /@vite 同源导航被拒（含 %40fs 编码绕过）', async () => {
    const { page } = launched
    const before = page.url()
    await page.evaluate(() => { (window as unknown as Record<string, unknown>)['__cyNavSentinel'] = 'alive' })

    for (const target of [
      `${devServer.url}/@fs/${process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd'}`,
      `${devServer.url}/%40fs/${process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd'}`, // %40fs 编码绕过形态
      `${devServer.url}/@vite/client`
    ]) {
      // 负向断言用**事件等待**而非盲等：若导航真被放行，framenavigated 会在预算内触发
      const raced = page.waitForEvent('framenavigated', { timeout: 2500 }).then(() => 'navigated' as const, () => 'no-navigation' as const)
      await page.evaluate((t) => { window.location.href = t }, target)
      expect(await raced, `导航被放行：${target}`).toBe('no-navigation')
      expect(page.url()).toBe(before)
      // 执行上下文未被销毁 = 文档确实没换（导航若成功，此 evaluate 会以 Execution context destroyed 失败）
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__cyNavSentinel'])).toBe('alive')
    }
  })
})
