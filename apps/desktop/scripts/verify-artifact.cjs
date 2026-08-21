// apps/desktop/scripts/verify-artifact.cjs
// 静态检查 out/ 产物；仅显式传 --smoke 时加 Playwright _electron 启动冒烟（存在 DISPLAY 不够，须显式请求）。
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = path.join(__dirname, '..')
const out = path.join(root, 'out')
let failed = false
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => { console.error(`✗ ${m}`); failed = true }

// 1. 三件产物存在
for (const rel of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  const p = path.join(out, rel)
  if (fs.existsSync(p)) ok(`out/${rel} 存在`)
  else fail(`out/${rel} 缺失`)
}
// 2. index.html 保留 CSP meta（dev http 兜底）且无 unsafe-eval；prod/preview 走 cyrene:// 严格响应头 AND 收紧
const htmlPath = path.join(out, 'renderer/index.html')
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  if (/unsafe-eval/i.test(html)) fail('index.html 含 unsafe-eval')
  else ok('index.html 无 unsafe-eval')
  if (/Content-Security-Policy/i.test(html)) ok('index.html 保留 CSP meta（dev http 兜底，prod 由响应头 AND 收紧）')
  else fail('index.html 缺失 CSP meta（dev http 场景将零 CSP）')
}
// 3. 秘密模式扫描（best-effort）
const secretPatterns = [
  // AGENT_ACCESS_TOKEN 仅当赋值形态（`= 值`/`: 值`）命中——引用（process.env.AGENT_ACCESS_TOKEN / env['AGENT_ACCESS_TOKEN']）不算秘密
  /(^|[^A-Za-z0-9_.'"`])AGENT_ACCESS_TOKEN\s*[=:]\s*["']?[^\s"'`,;]+/,
  /(^|[\\/])\.env([\\/.]|$)/, // 文件名边界：.env / .env.local 段；不误报 process.env.NODE_ENV 的 .env 访问
  /Bearer\s+[A-Za-z0-9_.~+/=-]{20,}/
]
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files // out/ 缺失时后续 existsSync 检查已 fail，这里不裸抛 ENOENT
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, files)
    else files.push(p)
  }
  return files
}
const textExt = ['.js', '.html', '.css', '.json', '.cjs', '.mjs', '.map'] // .map sourcemap 带完整 sourcesContent，须同扫
let secretHit = false
let scanned = 0
for (const f of walk(out)) {
  if (!textExt.includes(path.extname(f))) continue
  scanned++
  const content = fs.readFileSync(f, 'utf8')
  for (const re of secretPatterns) {
    if (re.test(content)) { fail(`out/ 命中秘密模式 ${re}（文件 ${path.relative(out, f)}）`); secretHit = true }
  }
}
if (secretHit) { /* fail 已置 */ }
else if (scanned > 0) ok('out/ 无 .env/Token/Bearer 模式')
else console.warn('（out/ 无文本文件可扫描——三件产物检查已 fail，不打印 PASS）')
// 4. version 可读
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.version) ok(`version=${pkg.version}`)
else fail('package.json 无 version')

// 优先用未分发包（真实打包形态，能抓到 electron-builder 打包错误）；否则回退 out/（未打包直启）。
// electron-builder 产物含 .chrome-sandbox / chrome_crashpad_handler 等 helper，须按 productName 候选名挑选真实应用二进制；
// 平台感知：linux→dist/linux-unpacked、win32→dist/win-unpacked、darwin→dist/mac/…/MacOS。
// 返回 { exe, foundPackagedDir }：有打包目录但找不到候选二进制 → foundPackagedDir=true 且 exe=null（判失败，防打包命名变化被静默掩盖）。
function findPackagedExecutable(root) {
  const p = process.platform
  const targets = []
  if (p === 'linux') targets.push({ dir: path.join(root, 'dist/linux-unpacked'), names: ['Cyrene', 'cyrene'] })
  if (p === 'win32') targets.push({ dir: path.join(root, 'dist/win-unpacked'), names: ['Cyrene.exe', 'cyrene.exe'] })
  if (p === 'darwin') {
    // electron-builder 按 arch 输出 dist/mac / mac-arm64 / mac-universal；Apple Silicon 用 arm64
    for (const d of ['mac', 'mac-arm64', 'mac-universal']) {
      targets.push({ dir: path.join(root, 'dist', d, 'Cyrene.app', 'Contents', 'MacOS'), names: ['Cyrene', 'cyrene'] })
    }
  }
  let anyDirExisted = false
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue
    anyDirExisted = true
    for (const n of t.names) {
      const exe = path.join(t.dir, n)
      if (fs.existsSync(exe) && fs.statSync(exe).isFile()) return { exe, foundPackagedDir: true }
    }
    // 不提前 return：darwin 可能 dist/mac 为空而 mac-arm64 有产物，继续遍历
  }
  // 有打包目录但全无候选 → 打包命名变化/残缺（真问题，交由调用方 fail）；无目录 → 回退 out/
  return { exe: null, foundPackagedDir: anyDirExisted }
}

// fuse 状态读回断言（spec §7.2）：electron-builder yml `electronFuses` 三键 → wire 读回 → 必须 DISABLE（48 字节枚举）。
// 本脚本为 CJS，@electron/fuses 2.x 为 ESM-only（require 会 ERR_REQUIRE_ESM）——经 await import 动态导入；
// 双版本并存注记：electron-builder 26.15.3 内置 @electron/fuses@^1.8.0 负责写 wire，本脚本经 apps/desktop
// node_modules 解析 devDep @electron/fuses@2.1.3 负责读——wire 为 Electron 字节布局（V1 sentinel 同源），
// 跨版本兼容；若未来版本撕裂（sentinel/字节位置变化）getCurrentFuseWire 抛错 → 本函数 fail（fail-closed +
// 提示检查 devDep 版本，勿静默跳过）。
async function checkFuses(exe) {
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses')
  let wire
  try {
    wire = await getCurrentFuseWire(exe)
  } catch (e) {
    // getCurrentFuseWire 2.x 对不支持的二进制（非 Electron 12+ / wire 损坏）抛错——不静默跳
    fail(`fuse wire 读取失败：${e.message}（二进制不支持或 @electron/fuses devDep 与产物不兼容？——检查 apps/desktop node_modules/@electron/fuses 版本）`)
    return
  }
  const expects = [
    [FuseV1Options.RunAsNode, 'runAsNode（node 子进程执行面）'],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, 'enableNodeOptionsEnvironmentVariable（NODE_OPTIONS 注入面）'],
    [FuseV1Options.EnableNodeCliInspectArguments, 'enableNodeCliInspectArguments（--inspect 调试参数）']
  ]
  for (const [opt, label] of expects) {
    const v = wire[opt]
    if (v === FuseState.DISABLE) ok(`fuse ${label} = DISABLE（wire[${opt}]=${v}）`)
    else fail(`fuse ${label} 未关闭：wire[${opt}]=${v}，期望 DISABLE=${FuseState.DISABLE}——electron-builder.yml electronFuses 三键未生效或读回错位？`)
  }
}

async function smoke() {
  // 在 try 外解析（catch 分支要引用 packagedExe 打诊断提示；块级 const 在 catch 不可见会 ReferenceError）
  const { exe: packagedExe, foundPackagedDir } = findPackagedExecutable(root)
  if (foundPackagedDir && !packagedExe) {
    fail('存在未分发包目录但找不到应用二进制（Cyrene/cyrene）——打包命名变化或产物残缺，不静默回退 out/（Step 5 应已 rm -rf dist）')
  }
  let flipTmp = null
  let flipExe = null
  try {
    const { _electron } = require('playwright')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_ENABLE_LOGGING
    delete env.ELECTRON_RENDERER_URL // 残留 dev env 会把 out/ 回退冒烟劫持到 http；冒烟必须测 cyrene:// 路径
    delete env.NODE_OPTIONS // 开发者 shell 残留的 --inspect* 会误触发打包调试门；冒烟测的是产物不是 shell 环境
    env.CYRENE_TEST_HARNESS = '1' // 显式标记测试 harness：让调试门放行 Playwright 注入的 --remote-debugging-port=0/--inspect=0（生产默认拒绝）
    let app
    if (packagedExe) {
      // spec §7.2（可行 R2-1）：Playwright `_electron.launch` 硬依赖 `--inspect=0` 的「Debugger listening on」行
      // （coreBundle.js:43975/44061-66）——三项 fuse 关闭后直接启动 flipped 产物必挂 30s 超时。
      // 解法：复制整个未分发包目录（资源须与二进制同目录——Electron 按 exe 同目录解析 resources/，单文件
      // 副本会因缺 resources 立即退出）→ flip-back 三项回 true → Playwright 启动副本；产物本体保持关闭态
      // （fuse 读回断言已证明最终态），smoke 断言的 CSP/渲染/协议等行为不受 fuse 位影响。
      console.log(`（冒烟目标：未分发包打包产物 ${path.relative(root, packagedExe)}——复制包含 resources/ 的目录副本并 flip-back 三项 fuse 后启动）`)
      const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses')
      // LOW④（review 2026-08-22）：darwin 的 findPackagedExecutable 返回 …/Cyrene.app/Contents/MacOS，
      // 单复制 MacOS 目录会缺 Contents/Resources 与 Info.plist——按 bundle 结构复制整个 .app（两级上溯），
      // flipExe 取 bundle 内 Contents/MacOS/<候选名>；linux/win 整目录即含 resources/，语义一致。
      const packagedDir = path.dirname(packagedExe)
      const isMac = process.platform === 'darwin'
      const copyRoot = isMac ? path.resolve(packagedDir, '..', '..') : packagedDir
      flipTmp = path.join(os.tmpdir(), `cyrene-smoke-flipback-${process.pid}-${Date.now()}`)
      fs.cpSync(copyRoot, flipTmp, { recursive: true })
      flipExe = isMac
        ? path.join(flipTmp, 'Contents', 'MacOS', path.basename(packagedExe))
        : path.join(flipTmp, path.basename(packagedExe))
      try {
        // flipFuses 2.x 为 async；version 必须是 FuseVersion.V1（"1"），三个 fuse 键回 true（ENABLE）
        await flipFuses(flipExe, {
          version: FuseVersion.V1,
          [FuseV1Options.RunAsNode]: true,
          [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
          [FuseV1Options.EnableNodeCliInspectArguments]: true
        })
        ok(`flip-back 完成（临时副本目录 ${path.basename(flipTmp)}：三项回 true；产物本体保持关闭态）`)
      } catch (e) {
        fail(`flip-back 失败：${e.message}——冒烟拒绝启动（fail-closed，产物 fuse 位保持关闭态；可能副本损坏/只读）`)
        return
      }
      app = await _electron.launch({ executablePath: flipExe, args: [], cwd: root, env, timeout: 30000 })
    } else {
      console.log('（冒烟目标：out/ 未打包直启——未找到未分发包产物）')
      // ELECTRON_RUN_AS_NODE 下 require('electron') 返回 cli 函数而非路径（本仓沙箱注入该 env，docs/17 P-2）；
      // 用 electron 包内 path.txt 解析真实二进制路径（跨平台，不受 env 影响）。
      const electronDir = path.dirname(require.resolve('electron/package.json'))
      const binRel = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
      // path.txt 仅含二进制名（linux→electron），真实二进制在 dist/ 下（electron 自身 index.js 亦 join dist）；已按 .playwright-mcp/smoke-electron.cjs 已验证形态核对
      const electronPath = path.join(electronDir, 'dist', binRel)
      app = await _electron.launch({ executablePath: electronPath, args: [root], cwd: root, env, timeout: 30000 })
    }
    try {
      // 在 firstWindow 前挂 app 级 console 监听——首载阶段的 CSP 拒绝错误也能捕获
      const cspErrors = []
      app.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text())
      })
      const win = await app.firstWindow()
      win.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text())
      })
      await win.waitForFunction(() => typeof window.desktopApi !== 'undefined', null, { timeout: 15000 })
      const proto = await win.evaluate(() => window.location.protocol)
      if (proto === 'cyrene:') ok('window.location.protocol === cyrene:')
      else fail(`协议非 cyrene:（实际 ${proto}）`)
      // reload 确定性复现一次完整页载：监听挂载可能错过最早加载窗口，reload 让严格 CSP 的违规必然被捕获
      await win.reload()
      await win.waitForFunction(() => typeof window.desktopApi !== 'undefined', null, { timeout: 15000 })
      // Vue 挂载断言：preload/协议不依赖 bundle，必须确认 #app 真实渲染，防白屏假绿
      let rendered = false
      try {
        await win.waitForFunction(() => {
          const el = document.querySelector('#app')
          return el && el.childElementCount > 0 && (el.textContent || '').trim().length > 0
        }, null, { timeout: 15000 })
        rendered = true
      } catch { rendered = false }
      if (rendered) ok('Vue #app 已挂载渲染（非白屏）')
      else fail('Vue #app 未挂载（白屏）——renderer bundle 可能未执行（MIME/加载错误）')
      // computed-style 检查：捕获「CSS 未应用（如 style-src 拦截内联样式）」——App.vue 根是 #app 子节点 `.cy-app`（display:grid），
      // #app 挂载点自身只有 height:100%/margin:0（无 grid 规则），须查 `.cy-app`
      const computedDisplay = await win.evaluate(() => {
        const el = document.querySelector('#app .cy-app')
        return el ? getComputedStyle(el).display : '（.cy-app 不存在）'
      })
      if (computedDisplay === 'grid') ok('#app .cy-app computed display=grid（tokens.css/样式已应用）')
      else fail(`#app .cy-app computed display=${computedDisplay}（样式可能被 CSP style-src 拦截或 CSS 未加载）`)
      await win.waitForTimeout(1500)
      if (cspErrors.length === 0) ok('无 CSP console 报错（best-effort）')
      else fail(`CSP 报错 ${cspErrors.length} 条：${cspErrors[0]}`)
      // 确定性 CSP 断言（非时序）：页内 fetch cyrene://renderer/index.html 读响应头，验证严格 CSP 确实被服务
      const cspHeader = await win.evaluate(async () => {
        try {
          const res = await fetch('cyrene://renderer/index.html')
          return res.headers.get('content-security-policy') || ''
        } catch { return '' }
      })
      if (cspHeader.includes("frame-src 'none'") && !/unsafe-eval/.test(cspHeader) && !/unsafe-inline/.test(cspHeader)) {
        ok('cyrene:// 响应头携带严格 CSP（frame-src none / 无 unsafe-eval/inline）')
      } else {
        fail(`cyrene:// 响应头缺严格 CSP（实际：${cspHeader.slice(0, 120)}）`)
      }
      const info = await win.evaluate(() => window.desktopApi.getAppInfo())
      // installAppIdentity 已 app.setName('Cyrene')，打包/未打包 app.getName() 均返回 'Cyrene'（第一块冒烟已验证）
      if (info && info.name === 'Cyrene' && info.version === pkg.version && info.platform === process.platform) ok(`getAppInfo=${JSON.stringify(info)}`)
      else fail(`getAppInfo 异常：${JSON.stringify(info)}`)
      // 普通浏览器信任边界（spec §8.6）：desktopApi 只存在于 Electron preload。
      // 用本地 http 静态服务加载产物（file:// 下 Vite 绝对基址 /assets/... 无法加载，会让 bundle 不执行而假通过）
      try {
        const { chromium } = require('playwright')
        const http = require('http')
        const rendererDir = path.join(root, 'out', 'renderer')
        const server = http.createServer((req, res) => {
          let urlPath
          try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { res.writeHead(400); res.end(); return }
          const safe = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
          const file = path.resolve(rendererDir, safe)
          const bad = (file !== rendererDir && !file.startsWith(rendererDir + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()
          if (bad) { res.writeHead(404); res.end(); return } // 越界/缺失/目录（空路径落 rendererDir 自身）→ 404，不 readFileSync 目录
          // 值与 Task 5 protocol/mime.ts 的 MIME_MAP 逐字符一致（CJS 脚本无法 import TS，此为第二副本，扩展时两边同步）
          const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
          res.end(fs.readFileSync(file))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        try {
          const browser = await chromium.launch()
          try {
            const page = await browser.newPage()
            await page.goto(`http://127.0.0.1:${port}/index.html`)
            // 安全属性断言（核心，独立于渲染）：desktopApi 只存在于 Electron preload
            const hasApi = await page.evaluate(() => typeof window.desktopApi !== 'undefined')
            if (hasApi) fail('普通浏览器暴露 desktopApi（信任边界被破坏！）')
            else ok('普通浏览器 desktopApi undefined（信任边界）')
            // bundle 执行确认（informational，不判 fail）：渲染失败不否定上述安全属性；
            // 若未来 renderer boot 在普通浏览器解引用 desktopApi（启动即抛、#app 不挂载），此处仅提示不误判
            const rendered = await page.evaluate(() => {
              const el = document.querySelector('#app')
              return !!el && el.childElementCount > 0
            })
            if (rendered) console.log('  （bundle 已执行：#app 渲染）')
            else console.warn('  （bundle 未渲染——不影响 desktopApi 断言，但建议人工确认 bundle 可在普通浏览器加载）')
          } finally {
            await browser.close()
          }
        } finally {
          server.close()
        }
      } catch (e) {
        // 仅「chromium 二进制不可用」跳过；其他失败（goto/evaluate/静态服务/启动回归）判失败，防 §8.6 假通过。
        // 块 A review [P2]：不得匹配通用 browserType.launch——权限/参数/共享库等真实回归也会携带该上下文，跳过会掩盖；
        // 只对白名单化的环境缺失错误跳过（块 C trust-boundary 集成测试已把该检查做成 CI 硬门）。
        const m = e && e.message ? String(e.message) : String(e)
        if (/Executable doesn't exist|browser binaries|Please run npx playwright install|Running as root without --no-sandbox|SUID sandbox helper|chrome-sandbox/.test(m)) {
          console.warn('（跳过普通浏览器信任边界检查：chromium 二进制不可用或沙箱受限——块 C trust-boundary 集成测试为硬门）')
        } else {
          fail(`普通浏览器信任边界检查失败：${m}`)
        }
      }
      // 截图写到仓库根 .playwright-mcp/（vision MCP 读取根；apps/desktop 下的同名目录会被 gitignore 但 vision 找不到）
      const shotDir = path.join(root, '..', '..', '.playwright-mcp')
      fs.mkdirSync(shotDir, { recursive: true })
      await win.screenshot({ path: path.join(shotDir, 'cyrene-cyrene-proto.png') })
      ok(`截图 ${path.join(shotDir, 'cyrene-cyrene-proto.png')}`)
      // 负路径前先关正路径 app 并等单实例锁释放——否则负路径若因锁退出（而非调试门拒绝）会被误判为门禁生效，
      // 门禁回归时假通过（块 A review [P1]：正路径 app 仍持有 userData 锁）。
      await app.close()
      await new Promise((r) => setTimeout(r, 300))
      // 负路径（仅打包形态）：带禁止开关（无 harness）→ 调试门应 failStart 退出（验证拒绝路径接线 E2E，
      // 而不只是单测覆盖纯函数）。out/ 未打包 isPackaged=false 不触发门，此处只在 packagedExe 时测。
      // 注：本断言实际由 Playwright 注入的 --inspect=0 触发门（allowRandomPort=false 时拒绝），早于显式 --remote-debugging-port=9222——
      // 它证明打包调试门会拒绝非 harness 启动；显式端口 9222 的拒绝由单测 config-debug-switches.spec 另行覆盖。
      // 负路径用 flip-back 副本（flipExe）：产物本体三项 fuse 关闭后 Playwright 注入的 --inspect=0 得不到
      // 「Debugger listening on」，Playwright 内部遗留未消费的 chromeMatchPromise 拒绝 → Node 进程崩溃（unhandled rejection）；
      // 副本 fuse 已回 true（与改动前的可启动形态一致）——本断言验证的是应用层调试门（fuse 无关），
      // fuse 层证明由静态读回断言承担（三项 DISABLE 已在上方断言）。
      if (packagedExe) {
        const negEnv = { ...env }
        delete negEnv.CYRENE_TEST_HARNESS
        let negRejected = false
        try {
          const negApp = await _electron.launch({ executablePath: flipExe, args: ['--remote-debugging-port=9222'], env: negEnv, timeout: 15000 })
          try {
            const negWin = await negApp.firstWindow({ timeout: 5000 }).catch(() => null)
            if (negWin) { /* 拿到窗口 = 门没生效 */ } else { negRejected = true }
          } finally { await negApp.close().catch(() => {}) }
        } catch {
          negRejected = true // failStart 退出 → launch/firstWindow 失败
        }
        if (negRejected) ok('调试门拒绝路径生效（打包 + --remote-debugging-port=9222 → failStart 退出）')
        else fail('调试门未生效：打包带 --remote-debugging-port=9222 仍启动出窗口')
      }
    } finally {
      await app.close()
    }
  } catch (e) {
    const m = e && e.message ? String(e.message) : String(e)
    fail(`启动冒烟失败：${m}`)
    if (packagedExe) {
      console.error('  提示：若为超时/立即退出，可能是单实例锁冲突（你在跑 pnpm dev / 真实 Cyrene？或上一次冒烟未正常关闭），或调试门与 Playwright 注入开关冲突（确认 CYRENE_TEST_HARNESS=1 已注入、Playwright 注入形态为 --remote-debugging-port=0/--inspect=0）')
    }
  } finally {
    // flip-back 副本为临时目录（os.tmpdir()），用后整树删除（spec §7.2 已知边界）
    if (flipTmp) {
      fs.rmSync(flipTmp, { recursive: true, force: true })
      console.log(`（已删除 flip-back 临时副本目录 ${flipTmp}）`)
    }
  }
}

;(async () => {
  // 2.5 fuse 读回（静态断言，不启动 Electron）：未分发包产物存在时读回三项关闭态。
  // 有打包目录但找不到二进制 → fail（同 smoke 语义，防打包命名变化被静默掩盖）；无打包产物（out/ 未打包形态）→ 跳过提示。
  const { exe: fuseExe, foundPackagedDir: fuseDirFound } = findPackagedExecutable(root)
  if (fuseDirFound && !fuseExe) {
    fail('存在未分发包目录但找不到应用二进制——fuse 读回无法执行（打包命名变化/产物残缺），不静默跳过')
  } else if (fuseExe) {
    await checkFuses(fuseExe)
  } else {
    console.log('（fuse 读回跳过：无未分发包产物——先 `pnpm -F @cyrene/desktop package` 再验证）')
  }
  const wantSmoke = process.argv.includes('--smoke')
  if (wantSmoke) {
    // Linux 需 DISPLAY 或 WAYLAND_DISPLAY（X/Wayland 均可）；win32/darwin 有原生显示
    const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    if (needsDisplay) {
      fail('请求了 --smoke 但 Linux 无 DISPLAY/WAYLAND_DISPLAY，无法执行启动冒烟')
    } else {
      console.log('—— 启动冒烟（Playwright _electron）——')
      await smoke()
    }
  } else {
    console.log('（仅静态检查：未传 --smoke。启动冒烟用 `pnpm verify:artifact -- --smoke`）')
  }
  if (failed) { console.error('verify:artifact 失败'); process.exit(1) }
  console.log('verify:artifact 通过')
})()
