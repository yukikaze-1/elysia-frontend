import { isAbsolute } from 'node:path'

/**
 * Electron 集成测试专用 appData 覆盖。
 *
 * Windows 上 Electron 43 的 app.getPath('appData') 由系统 Known Folder 决定，单纯覆写
 * APPDATA 环境变量并不能保证隔离。测试因此必须显式传入本变量，并同时满足：未打包、
 * `--mode test` 构建、CYRENE_TEST_HARNESS=1。任一条件不满足都拒绝启动，不能静默回落
 * 到真实用户目录。
 */
export const TEST_APP_DATA_ENV = 'CYRENE_TEST_APP_DATA'

export function resolveTestAppDataOverride(input: {
  env: NodeJS.ProcessEnv
  packaged: boolean
  mode: string
}): string | undefined {
  const raw = input.env[TEST_APP_DATA_ENV]
  if (raw === undefined) return undefined

  if (input.packaged || input.mode !== 'test' || input.env['CYRENE_TEST_HARNESS'] !== '1') {
    throw new Error('测试 appData 覆盖仅允许未打包的 test harness')
  }
  if (raw.length === 0 || raw !== raw.trim() || !isAbsolute(raw)) {
    throw new Error('测试 appData 覆盖必须是无首尾空白的绝对路径')
  }
  return raw
}
