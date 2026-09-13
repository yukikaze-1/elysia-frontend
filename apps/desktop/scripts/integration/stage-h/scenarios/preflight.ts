import { normalizeEndpointForComparison, readCommonSnapshot } from '../lib/electron.ts'
import type { StageHScenario } from './types.ts'

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' ? value as AnyRecord : {}
}

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((item): item is AnyRecord => Boolean(item && typeof item === 'object')) : []
}

function parseBuildSha(serverVersion: unknown): string | undefined {
  if (typeof serverVersion !== 'string') return undefined
  const plus = serverVersion.lastIndexOf('+')
  return plus >= 0 && plus < serverVersion.length - 1 ? serverVersion.slice(plus + 1) : undefined
}

export const runPreflight: StageHScenario = async ({ config, page }) => {
  const common = asRecord(await readCommonSnapshot(page))
  const custom = asRecord(await page.evaluate(async () => window.desktopApi.listCharacters({ source: 'custom', status: 'active', limit: 100 })))
  const connection = asRecord(common.connection)
  const runtime = asRecord(common.runtime)
  const me = asRecord(common.me)
  const active = asRecord(common.characters)
  const conversations = asRecord(common.conversations)
  const customItems = records(custom.items)
  const activeItems = records(active.items)
  const conversationItems = records(conversations.items)
  const features = asRecord(connection.features)

  let endpointMatches = false
  try {
    // `connection.serverUrl` 是 unknown：非字符串（含对象）一律按"不匹配"处理，
    // 不再 `String(对象)` 得到 '[object Object]'（`no-base-to-string`，2026-09-13 type-aware 全集）
    const serverUrl = typeof connection.serverUrl === 'string' ? connection.serverUrl : ''
    endpointMatches = normalizeEndpointForComparison(serverUrl) === normalizeEndpointForComparison(config.backendUrl)
  } catch {
    endpointMatches = false
  }

  let targetReadable = true
  if (config.characterId) {
    try {
      await page.evaluate(async (id) => window.desktopApi.getCharacter(id), config.characterId)
    } catch {
      targetReadable = false
    }
  }

  const checks = {
    connectionConnected: connection.status === 'connected',
    realRuntime: runtime.mode === 'real',
    endpointMatches,
    protocolPresent: typeof connection.protocolVersion === 'string' && connection.protocolVersion.length > 0,
    characterProfilesCapability: features.characterProfiles === true,
    characterStateStreamCapability: features.characterStateStream === true,
    identityReadable: me.initialized === true && Number.isInteger(me.revision) && Number(me.revision) >= 1,
    activeCatalogReadable: Array.isArray(active.items),
    customCatalogReadable: Array.isArray(custom.items),
    conversationListReadable: Array.isArray(conversations.items),
    targetCharacterReadable: targetReadable
  }

  return {
    checks,
    backend: {
      url: typeof connection.serverUrl === 'string' ? connection.serverUrl : undefined,
      protocolVersion: typeof connection.protocolVersion === 'string' ? connection.protocolVersion : undefined,
      serverVersion: typeof connection.serverVersion === 'string' ? connection.serverVersion : undefined,
      // This is observed metadata.  The CLI's --backend-commit is an
      // expectation checked by the runner and must never replace it.
      buildSha: parseBuildSha(connection.serverVersion)
    },
    details: {
      activeCharacterCount: activeItems.length,
      customCharacterCount: customItems.length,
      conversationCount: conversationItems.length,
      initialized: me.initialized === true,
      identityRevision: typeof me.revision === 'number' ? me.revision : null,
      targetCharacterConfigured: config.characterId !== undefined
    }
  }
}
