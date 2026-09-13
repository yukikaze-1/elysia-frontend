// tests/integration/voice-silence-autostop.spec.ts —— 规格漂移台账 ②-7：doc 11 §3.3「语音活动检测／静音结束时长」
//
// 为什么必须有一条端到端用例：静音判定的**判据**已经被单测钉死（SilenceTracker/computeRms），
// 但"设置项 → 采集层 → 真的自动结束录音"这条链还缺一环证据。本用例用 Chromium 的
// `--use-file-for-fake-audio-capture=<静音 wav>` 造出**确定性静音**的假麦克风，
// 于是"静音 1s → 自动结束"可以在 CI 上稳定复现（默认 fake device 是 440Hz 音调，永远不会静音，
// 故必须显式给静音 WAV；这也是本用例能存在的前提）。
//
// 判别面：① 预置 silenceAutoStop=true/silenceStopMs=1000 后，开始录音 → 无需人工干预，
// 「停止录音」按钮自行消失（= 已自动结束）且给出可见提示；② 反向：同环境下关闭该设置时，
// 录音**不会**自行结束（证明红的是"设置真的生效"，不是"录音本来就结束"）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

const POLL = { timeout: 20000, interval: 200 }
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

/** 16kHz/单声道/16bit 的静音 WAV（Chromium --use-file-for-fake-audio-capture 只吃 WAV） */
function writeSilentWav(seconds = 5): string {
  const dir = mkdtempSync(join(tmpdir(), 'cy-vad-'))
  const path = join(dir, 'silence.wav')
  const sampleRate = 16000
  const samples = sampleRate * seconds
  const dataBytes = samples * 2
  const buf = Buffer.alloc(44 + dataBytes)   // 头 44B + 全零 PCM（静音）
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40)
  writeFileSync(path, buf)
  return dir
}

/** 预置 settings.json：consent 已接受（跳过 D-P16 弹窗）+ 静音自动结束按用例配置 */
function settingsSeed(silenceAutoStop: boolean, silenceStopMs: number): string {
  return JSON.stringify({
    version: 1,
    voice: {
      enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true,
      consentBackendStt: true, silenceAutoStop, silenceStopMs
    },
    dictation: { insertMode: 'append' }
  })
}

let wavDir = ''
let launched: LaunchedApp | undefined

beforeAll(() => { wavDir = writeSilentWav(5) })
afterAll(async () => {
  if (launched) { try { await closeApp(launched) } catch { /* 尽力 */ } }
  try { rmSync(wavDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
})

async function launchWithSilence(silenceAutoStop: boolean, silenceStopMs: number): Promise<LaunchedApp> {
  return launchApp([{ relPath: 'config/settings.json', content: settingsSeed(silenceAutoStop, silenceStopMs) }], {
    extraArgs: [...FAKE_MEDIA, `--use-file-for-fake-audio-capture=${join(wavDir, 'silence.wav')}`]
  })
}

async function connectAndActivateFirst(page: LaunchedApp['page']): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
}

const isRecording = (page: LaunchedApp['page']): Promise<number> => page.getByRole('button', { name: '停止录音', exact: true }).count()

describe('语音活动检测：静音自动结束录音（doc 11 §3.3）', () => {
  it('① 开启后：静音 1s 自行结束录音并给出可见提示；② 关闭时不会自行结束', async () => {
    // —— ① 开启 ——
    launched = await launchWithSilence(true, 1000)
    const page = launched.page
    await connectAndActivateFirst(page)
    await page.getByRole('button', { name: '普通录音', exact: true }).click()
    await expect.poll(() => isRecording(page), POLL).toBe(1)
    // 假麦克风喂的是静音 WAV ⇒ 到点即自动结束（无需任何点击）
    await expect.poll(() => isRecording(page), POLL).toBe(0)
    const notice = await page.evaluate(() => document.body.textContent ?? '')
    expect(notice, '自动结束要有可见提示（不做静默行为变更）').toContain('静音')
    await closeApp(launched)
    launched = undefined

    // —— ② 反向：关闭该设置时，同样的静音环境不会自动结束 ——
    const off = await launchWithSilence(false, 1000)
    try {
      const page2 = off.page
      await connectAndActivateFirst(page2)
      await page2.getByRole('button', { name: '普通录音', exact: true }).click()
      await expect.poll(() => isRecording(page2), POLL).toBe(1)
      // 等足 3s（远超 1s 静音时长）：仍在录音 ⇒ 证明 ① 的红是"设置生效"而非"录音本来就结束"
      await page2.waitForTimeout(3000)
      expect(await isRecording(page2), '关闭该设置时不得自行结束录音').toBe(1)
    } finally {
      await closeApp(off)
    }
  }, 120_000)
})
