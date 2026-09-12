// scripts/package-app.mjs
// `electron-builder --dir` 的唯一入口（P2-4，2026-09-12）。
//
// 为什么需要它：评审记录了一个**只在 Windows、只在首跑**出现的失败——
// `pnpm package` 在 `@electron/fuses` 写 wire 的步骤报 `ENOENT … Cyrene.exe`，**重跑即过**
// （该步骤由 electron-builder 内部执行，写的是 `dist/win-unpacked/Cyrene.exe`）。
// P2-4 把 `package` 接进 Windows CI 之后，这个偶发会直接表现为"新门禁时红时绿"，
// 于是必须先让它**有针对性**地稳下来：**只**对"ENOENT 且指向 .exe"这一形态重试一次，
// 其它任何失败立刻原样失败——不做无条件重试（那会把真实失败也掩盖成"第一次不算"）。
//
// 注意：本机（本次修改期间）**无法复现**该偶发，故这里的重试是**依据评审记录的观察**做的防御，
// 而不是我实测到的失败。脚本会把"发生了重试"显式打印出来（CI 里也能看到），
// 因此一旦它其实从不需要重试，日志会告诉我们；一旦频繁重试，也一眼可见。
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 命中"首跑 fuses 写 wire 的 ENOENT"这一已知偶发形态（纯函数，可单测） */
export function isFusesEnoentFlake(output) {
  if (!/ENOENT/i.test(output)) return false
  // 收紧到"找不到 .exe"：避免把任意 ENOENT（如缺某个配置文件）都当成该偶发而重试
  return /[\w.-]+\.exe/i.test(output) || /win-unpacked/i.test(output)
}

/** 跑一次 electron-builder --dir；返回 { code, output }（输出同时实时透传到父进程） */
export function runBuilderOnce({ spawnImpl = spawn, args = ['exec', 'electron-builder', '--dir'] } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl('pnpm', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    const tee = (stream, sink) => (chunk) => { const text = chunk.toString(); output += text; sink.write(text) }
    child.stdout?.on('data', tee('stdout', process.stdout))
    child.stderr?.on('data', tee('stderr', process.stderr))
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

async function main() {
  const first = await runBuilderOnce()
  if (first.code === 0) return 0

  if (!isFusesEnoentFlake(first.output)) {
    console.error('\n[package-app] 打包失败（非已知偶发形态），不重试。')
    return first.code
  }

  console.warn('\n[package-app] 首次打包命中已知 Windows 偶发（fuses 写 wire 时 ENOENT .exe）——按 P2-4 重试一次。')
  const second = await runBuilderOnce()
  if (second.code === 0) {
    console.warn('[package-app] 重试成功。注意：本次确实需要了重试，请留意该偶发频率。')
    return 0
  }
  console.error('[package-app] 重试仍失败，按失败处理。')
  return second.code
}

// 仅在被直接执行时跑（被 import 单测时不执行）。
// 用 pathToFileURL 而非字符串拼接：Windows 路径拼接写成 `file://C:\...` 会与 import.meta.url 不相等，
// 导致"直接执行"判定永远为假、脚本静默什么都不做（这类静默失效正是本仓库最忌讳的形态）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
