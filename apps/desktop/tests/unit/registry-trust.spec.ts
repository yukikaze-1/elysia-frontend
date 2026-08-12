// tests/unit/registry-trust.spec.ts
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn() } })) // registry 顶层 import electron
import { isTrustedSenderFor } from '../../src/main/ipc/registry'
import { resolveTrustedDevOrigins } from '../../src/main/config/trusted-renderer-origin'

const trusted = resolveTrustedDevOrigins({})
const frame = (url: string) => ({ url })
function makeWin(mainFrame: { url: string }, destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { mainFrame } }
}

describe('isTrustedSenderFor', () => {
  it('全匹配 + cyrene://renderer → true', () => {
    const mf = frame('cyrene://renderer/index.html')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(true)
  })
  it('全匹配 + 受信 http dev origin → true', () => {
    const mf = frame('http://localhost:5173/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(true)
  })
  it('win null / destroyed → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(null, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(false)
    const dead = makeWin(mf, true)
    expect(isTrustedSenderFor(dead, { sender: dead.webContents, senderFrame: mf }, trusted)).toBe(false)
  })
  it('sender 不匹配 → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: 'other-wc', senderFrame: mf }, trusted)).toBe(false)
  })
  it('senderFrame 缺失 / ≠ mainFrame → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: null }, trusted)).toBe(false)
    const sub = frame('cyrene://renderer/')
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: sub }, trusted)).toBe(false) // sub !== mainFrame
  })
  it('senderFrame.url 不受信 → false（错误 cyrene host / 远程 http）', () => {
    const mf = frame('http://evil.example/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(false)
    const mf2 = frame('cyrene://evil/')
    const win2 = makeWin(mf2)
    expect(isTrustedSenderFor(win2, { sender: win2.webContents, senderFrame: mf2 }, trusted)).toBe(false)
  })
})
