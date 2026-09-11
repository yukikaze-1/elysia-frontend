import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const DESKTOP = join(__dirname, '../..')
const RENDERER = join(DESKTOP, 'src/renderer')
const ASSET_DIR = join(RENDERER, 'src/assets/backgrounds')
const PUBLIC_ASSET_DIR = join(RENDERER, 'public/assets/backgrounds')

const BACKGROUNDS = [
  'cyrene-bg-chat-light.webp',
  'cyrene-bg-chat-dark.webp',
  'cyrene-bg-settings-light.webp',
  'cyrene-bg-settings-dark.webp'
] as const

describe('Cyrene 背景素材契约', () => {
  it('Vite 源资源树包含全部主题背景，且单张背景不超过 800 KiB', () => {
    for (const name of BACKGROUNDS) {
      const path = join(ASSET_DIR, name)
      expect(existsSync(path), `${name} 应存在于 renderer/src 资源目录`).toBe(true)
      expect(statSync(path).size, `${name} 应保持轻量`).toBeGreaterThan(1024)
      expect(statSync(path).size, `${name} 不应超过 800 KiB`).toBeLessThanOrEqual(800 * 1024)
      expect(existsSync(join(PUBLIC_ASSET_DIR, name)), `${name} 不应依赖 Electron 中失效的绝对 public URL`).toBe(false)
    }
  })

  it('light/dark 主题变量使用 Vite 可追踪的相对资源 URL', () => {
    const tokens = readFileSync(join(RENDERER, 'src/tokens.css'), 'utf8')
    const darkTheme = tokens.indexOf('@media (prefers-color-scheme: dark)')
    expect(darkTheme).toBeGreaterThan(-1)
    expect(tokens).not.toMatch(/url\(\s*['"]\/assets\//)
    expect(tokens.slice(0, darkTheme)).toContain("--cy-chat-background: url('./assets/backgrounds/cyrene-bg-chat-light.webp')")
    expect(tokens.slice(0, darkTheme)).toContain("--cy-settings-background: url('./assets/backgrounds/cyrene-bg-settings-light.webp')")
    expect(tokens.slice(darkTheme)).toContain("--cy-chat-background: url('./assets/backgrounds/cyrene-bg-chat-dark.webp')")
    expect(tokens.slice(darkTheme)).toContain("--cy-settings-background: url('./assets/backgrounds/cyrene-bg-settings-dark.webp')")
  })

  it('聊天、设置和语音页都引用 Vite 打包资源，而不是绝对 public URL', () => {
    const app = readFileSync(join(RENDERER, 'src/App.vue'), 'utf8')
    const settings = readFileSync(join(RENDERER, 'src/components/CySettingsView.vue'), 'utf8')
    const voice = readFileSync(join(RENDERER, 'src/components/CyVoicePane.vue'), 'utf8')
    expect(app).toContain('var(--cy-chat-background)')
    expect(settings).toContain('var(--cy-settings-background)')
    expect(voice).toContain("from '../assets/backgrounds/cyrene-deco-voice-wave.png'")
    expect(voice).not.toContain("'/assets/backgrounds/cyrene-deco-voice-wave.png'")
    expect(voice).toContain(':src="VOICE_DECORATION_URL"')
    expect(voice).toContain('aria-hidden="true"')
    expect(voice).toContain('pointer-events: none')
  })

  it('主消息区的多层面板保留足够的背景可见度', () => {
    const app = readFileSync(join(RENDERER, 'src/App.vue'), 'utf8')
    const messages = readFileSync(join(RENDERER, 'src/components/CyMessageList.vue'), 'utf8')
    const conversations = readFileSync(join(RENDERER, 'src/components/CyConversationList.vue'), 'utf8')
    const nav = readFileSync(join(RENDERER, 'src/components/CyNavRail.vue'), 'utf8')
    const live = readFileSync(join(RENDERER, 'src/components/CyLive2DPanel.vue'), 'utf8')
    const mainAlpha = Number(app.match(/\.cy-main[\s\S]*?background:\s*color-mix\(in srgb, var\(--cy-pane\) (\d+)%?, transparent\)/)?.[1]) / 100
    const messageAlpha = Number(messages.match(/\.cy-messages[\s\S]*?background: color-mix\(in srgb, var\(--cy-pane\) (\d+)%?, transparent\)/)?.[1]) / 100
    expect(Number.isFinite(mainAlpha)).toBe(true)
    expect(Number.isFinite(messageAlpha)).toBe(true)
    expect((1 - mainAlpha) * (1 - messageAlpha), '中央背景穿透率不应被多层底色压到不可见').toBeGreaterThanOrEqual(0.55)
    expect(conversations).toContain('background: color-mix(in srgb, var(--cy-surface) 48%, transparent)')
    expect(nav).toContain('background: color-mix(in srgb, var(--cy-nav) 62%, transparent)')
    expect(live).toContain('color-mix(in srgb, var(--cy-surface) 48%, transparent)')
    expect(live).toContain('color-mix(in srgb, var(--cy-pane) 58%, transparent)')
  })
})
