export const FORBIDDEN_DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-fd',
  'inspect',
  'inspect-brk',
  'inspect-node',
  'inspect-brk-node',
  'inspect-wait', // Node 22：固定端口开 inspector 并等待（同 brk 危害）
  'inspect-wait-node'
] as const

// 允许 =0 的开关：Playwright _electron 控制通道注入 --inspect=0 / --remote-debugging-port=0（随机端口）。
// 默认（allowRandomPort=false）连 =0 也拒绝——doc 07「任何构建都不得开放远程调试端口」；
// 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口。
const RANDOM_PORT_ONLY = new Set(['remote-debugging-port', 'inspect'])

// getSwitch(name)：commandLine 查询（{ present: hasSwitch(name), value: getSwitchValue(name) }）
export function hasForbiddenDebugSwitch(
  argv: readonly string[],
  getSwitch: (name: string) => { present: boolean; value: string },
  allowRandomPort = false
): boolean {
  const forbidden = (name: string, value: string | null): boolean => {
    // 注：空格分隔形式（`--remote-debugging-port 0`）在 argv 扫描中 value=null 判为裸开关 → 保守拒绝（harness 也不放行）。
    // Playwright 注入的是 `=0` 等号形式（已验证）；空格形式不属测试 harness 场景。
    // brk/wait 变体与 fd 通道恒拒绝（Playwright 不注入）
    if (name === 'inspect-brk' || name === 'inspect-node' || name === 'inspect-brk-node' || name === 'inspect-wait' || name === 'inspect-wait-node' || name === 'remote-debugging-fd') return true
    if (name === 'remote-debugging-pipe') return !allowRandomPort // pipe 仅 harness 放行（未来 Playwright 可能切 pipe 通道）
    if (RANDOM_PORT_ONLY.has(name)) {
      if (value === '0') return !allowRandomPort // =0 仅测试 harness 放行
      return true // 裸开关（null）与显式端口都拒绝
    }
    return false
  }
  // 1) argv 同步扫描；遇 `--` 分隔符停止——其后 token 属应用参数，非 Chromium 开关
  for (const a of argv) {
    if (a === '--') break
    if (!a.startsWith('--')) continue
    const body = a.slice(2)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const value = eq >= 0 ? body.slice(eq + 1) : null
    if (forbidden(name, value)) return true
  }
  // 2) commandLine 兜底（argv 不含但开关已注入）
  for (const name of FORBIDDEN_DEBUG_SWITCHES) {
    const s = getSwitch(name)
    if (s.present && forbidden(name, s.value === '' ? null : s.value)) return true
  }
  return false
}

// NODE_OPTIONS 纯 env 通道：Electron main 是 Node，NODE_OPTIONS=--inspect 即可开 inspector，
// 而 argv/commandLine 均不含它——门必须单独查。打包下含 inspect 系一律拒绝。
// 正则锚定选项边界（^ 或空白后跟 --inspect...，后随 =值/空白/结尾），避免误伤路径/参数中的 `--inspect` 子串；
// 匹配 --inspect/--inspect-brk/--inspect-node/--inspect-brk-node（--inspect-port 单独不开 inspector，不匹配）。
// 诚实限制：`--inspect-brk` 会在 Node 引导期、任何应用 JS（含本门）运行前暂停——进程内无法拦截，
// 属固有限制（记录 spec G-7；阶段 8 Electron Fuses 评估关闭 Node inspector 通道）。
export function hasForbiddenNodeOptions(nodeOptions: string | undefined): boolean {
  if (!nodeOptions) return false
  return /(^|\s)--inspect(?:-brk|-node|-brk-node|-wait|-wait-node)?(?=\s|=|$)/.test(nodeOptions)
}

export type ForbiddenDebugLaunchReason = 'switch' | 'node_options'

/**
 * 启动级统一策略：远程调试/Node inspector 对开发态与打包态一视同仁。
 *
 * 这里刻意不接收 `isPackaged`。doc 07 的安全基线是“任何构建都不得开放远程调试
 * 端口”，只允许显式测试 harness 使用随机端口（=0/pipe）。将环境分支留在调用处
 * 容易再次出现开发态漏门，因此把完整裁决收敛到一个纯函数并由单测钉死。
 */
export function findForbiddenDebugLaunch(
  argv: readonly string[],
  getSwitch: (name: string) => { present: boolean; value: string },
  nodeOptions: string | undefined,
  allowRandomPort = false
): ForbiddenDebugLaunchReason | null {
  if (hasForbiddenDebugSwitch(argv, getSwitch, allowRandomPort)) return 'switch'
  if (hasForbiddenNodeOptions(nodeOptions)) return 'node_options'
  return null
}
