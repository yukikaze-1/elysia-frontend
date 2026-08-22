import { describe, expect, it } from 'vitest'
import { findForbiddenDebugLaunch, hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from '../../src/main/config/debug-switches'

const none = (): { present: boolean; value: string } => ({ present: false, value: '' })
// 模拟 commandLine：present=开关已注入；value=getSwitchValue（''=裸开关/未注入）
const sw = (_name: string, value: string): { present: boolean; value: string } => ({ present: true, value })

describe('hasForbiddenDebugSwitch', () => {
  it('无调试开关 → false', () => {
    expect(hasForbiddenDebugSwitch(['/usr/bin/electron', '.'], none)).toBe(false)
  })
  it('显式端口 --remote-debugging-port=9222 → true（默认与 harness 都拒绝）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=9222'], none)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=9222'], none, true)).toBe(true)
  })
  it('裸 --remote-debugging-port（默认 9222）→ true', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port'], none)).toBe(true)
  })
  it('默认（生产）拒绝 --remote-debugging-port=0（doc 07 任何构建不得开放调试端口）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=0'], none)).toBe(true)
  })
  it('测试 harness（allowRandomPort=true）放行 =0 随机端口', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=0'], none, true)).toBe(false)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect=0'], none, true)).toBe(false)
  })
  it('--inspect-brk / --inspect-node / --inspect-brk-node / --inspect-wait / --inspect-wait-node / --remote-debugging-fd → 恒 true（harness 也不放行）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-brk=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-brk-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-wait=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-wait-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-fd=3'], none, true)).toBe(true)
  })
  it('--remote-debugging-pipe：生产拒，harness 放行（未来 Playwright 可能切 pipe 通道）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-pipe'], none)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-pipe'], none, true)).toBe(false)
  })
  it('commandLine 注入：value=9222 拒；value=0 仅 harness 放行', () => {
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '9222') : none()))).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '0') : none()))).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '0') : none()), true)).toBe(false)
  })
  it('-- 分隔符后为应用参数，非 Chromium 开关 → 不误杀', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--', '--inspect=9229'], none)).toBe(false)
  })
})

describe('hasForbiddenNodeOptions', () => {
  it('无 NODE_OPTIONS / 不含调试 → false', () => {
    expect(hasForbiddenNodeOptions(undefined)).toBe(false)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096')).toBe(false)
  })
  it('NODE_OPTIONS=--inspect 系（inspect/inspect-brk/inspect-node/inspect-brk-node/inspect-wait）→ true（单 env 即开 Node inspector）', () => {
    expect(hasForbiddenNodeOptions('--inspect=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-brk=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-node=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096 --inspect-brk-node=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-wait=9229')).toBe(true)
  })
  it('--inspect-port 单独（不开 inspector，仅配合 --inspect 用）→ false；路径含子串 → false', () => {
    expect(hasForbiddenNodeOptions('--inspect-port=0')).toBe(false)
    expect(hasForbiddenNodeOptions('--require /opt/tools/--inspect-helper.js')).toBe(false)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096')).toBe(false)
  })
})

describe('findForbiddenDebugLaunch', () => {
  it('所有构建共用同一启动门：显式 CDP 端口命中 switch（不接收 isPackaged 分支）', () => {
    expect(findForbiddenDebugLaunch(['electron', '--remote-debugging-port=9223'], none, undefined)).toBe('switch')
  })

  it('NODE_OPTIONS inspector 命中 node_options', () => {
    expect(findForbiddenDebugLaunch(['electron', '.'], none, '--inspect=9229')).toBe('node_options')
  })

  it('测试 harness 仅放行随机端口，显式端口仍拒绝', () => {
    expect(findForbiddenDebugLaunch(['electron', '--remote-debugging-port=0'], none, undefined, true)).toBeNull()
    expect(findForbiddenDebugLaunch(['electron', '--remote-debugging-port=9223'], none, undefined, true)).toBe('switch')
  })
})
