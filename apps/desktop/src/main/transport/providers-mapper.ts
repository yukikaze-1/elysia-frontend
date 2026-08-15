import type { ModelCredentialStatus, ModelProfile, ModelProfileSource, ModelServiceType } from '@shared/contracts/model'

/** rest.py ProvidersResponse wire（camelCase 字段；provider 名动态 key） */
export interface ProvidersResponseWire {
  llm: Record<string, ProviderEntryWire>
  stt: Record<string, ProviderEntryWire>
  tts: Record<string, ProviderEntryWire>
  custom: Partial<Record<ModelServiceType, Array<CustomProviderWire>>>
  unconfigured?: Partial<Record<ModelServiceType, Array<{ name: string; env_vars: string[] }>>>
}
export interface ProviderEntryWire {
  models: string[]
  credentialConfigured?: boolean
  runtime?: 'backend' | 'desktop' | 'local_worker'
  capabilities?: Record<string, unknown>
}
export interface CustomProviderWire {
  name: string
  base_url?: string
  models?: string[]
  runtime?: 'backend' | 'desktop' | 'local_worker'
  credentialConfigured?: boolean
  capabilities?: Record<string, unknown>
}

function caps(entry: { capabilities?: Record<string, unknown> }): string[] {
  return Object.keys(entry.capabilities ?? {}).sort()
}
function hostOf(url: string): string | undefined {
  try { return new URL(url).host } catch { return undefined }
}

/** 单条内置或 custom → ModelProfile[]（内置每 model 一条；custom 单条 id=custom/<name>） */
export function providersToModelProfiles(raw: ProvidersResponseWire): ModelProfile[] {
  const out: ModelProfile[] = []
  const pushEntry = (
    service: ModelServiceType, name: string,
    entry: ProviderEntryWire | CustomProviderWire, source: ModelProfileSource
  ): void => {
    const runtime = entry.runtime ?? 'backend'
    const cred = (entry.credentialConfigured ? 'configured' : 'missing') as ModelCredentialStatus
    const models = 'models' in entry ? (entry.models ?? []) : []
    if (source === 'built_in') {
      const list = models.length ? models : [name]
      for (const m of list) {
        out.push({
          id: `${name}/${m}`, type: service, displayName: name, source, provider: name, model: m,
          models: list, executionLocation: runtime, credentialStatus: cred, enabled: true,
          capabilities: caps(entry), builtIn: true
        })
      }
    } else {
      const base = 'base_url' in entry ? entry.base_url : undefined
      out.push({
        id: `custom/${name}`, type: service, displayName: name, source, provider: 'custom', model: name,
        models, executionLocation: runtime, credentialStatus: cred, enabled: true,
        capabilities: caps(entry), ...(base ? { endpointLabel: hostOf(base) } : {}), builtIn: false
      })
    }
  }
  const services: Array<ModelServiceType> = ['llm', 'stt', 'tts']
  for (const s of services) {
    for (const [name, entry] of Object.entries(raw[s] ?? {})) pushEntry(s, name, entry, 'built_in')
    for (const entry of raw.custom?.[s] ?? []) pushEntry(s, entry.name, entry, 'custom')
  }
  return out
}
