// tests/unit/package-app-retry.spec.ts
// P2-4（2026-09-12）：打包重试判据。
//
// 背景：P2-4 把 `pnpm package` + 静态 `verify:artifact` 接进 Windows CI。而评审记录了一个
// **只在 Windows、只在首跑**的偶发：`@electron/fuses` 写 wire 时 `ENOENT … Cyrene.exe`，重跑即过。
// 新门禁若带着这个偶发上线，会表现为"时红时绿"，所以必须先把重试做成**有针对性**的：
// **只**对"ENOENT 且指向 .exe / win-unpacked"这一形态重试一次，其它失败一律立刻失败。
//
// 本 spec 钉住那个判据。它守的是一条真实风险：判据写宽（只看 ENOENT）会把**任意**缺失文件的
// 打包失败也重试一次，把"真实失败"掩盖成"第一次不算"——那正是本仓库反复批评的假绿形态。
import { describe, expect, it } from 'vitest'
import { isFusesEnoentFlake } from '../../scripts/package-app.mjs'

describe('isFusesEnoentFlake（P2-4 重试判据）', () => {
  it('命中已知形态：ENOENT + Cyrene.exe（评审记录的原文形态）', () => {
    const real = "⨯ cannot execute  cause=Error: ENOENT: no such file or directory, open 'C:\\x\\dist\\win-unpacked\\Cyrene.exe'"
    expect(isFusesEnoentFlake(real)).toBe(true)
  })

  it('命中已知形态：ENOENT + win-unpacked（二进制名变化时仍能识别）', () => {
    expect(isFusesEnoentFlake('Error: ENOENT: no such file or directory, chmod win-unpacked')).toBe(true)
  })

  it('**不**把无关的 ENOENT 当成该偶发（这是本判据存在的全部意义）', () => {
    // 缺配置文件、缺 node_modules、缺图标——都是真实打包失败，必须立刻失败而不是重试
    expect(isFusesEnoentFlake("ENOENT: no such file or directory, open '/repo/apps/desktop/electron-builder.yml'")).toBe(false)
    expect(isFusesEnoentFlake('ENOENT: no such file or directory, scandir node_modules/electron')).toBe(false)
    expect(isFusesEnoentFlake("ENOENT: no such file or directory, open 'build/icon.png'")).toBe(false)
  })

  it('不含 ENOENT 的失败一律不重试（权限/签名/网络/配置错误）', () => {
    expect(isFusesEnoentFlake('EPERM: operation not permitted, rename app.asar')).toBe(false)
    expect(isFusesEnoentFlake('Error: Cannot compute electron version from installed node modules')).toBe(false)
    expect(isFusesEnoentFlake('package.json not valid JSON')).toBe(false)
    expect(isFusesEnoentFlake('')).toBe(false)
  })

  it('大小写不敏感（electron-builder 不同版本措辞不一）', () => {
    expect(isFusesEnoentFlake('enoent: ... Cyrene.EXE')).toBe(true)
  })
})
